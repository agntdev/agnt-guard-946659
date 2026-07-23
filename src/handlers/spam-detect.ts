import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getChat, putChat, upsertMember, logAction, type Action } from "../store.js";
import { now } from "../clock.js";
import { DEFAULT_MUTE_SECONDS } from "../store.js";

// GroupGuard — spam detection on group messages. Admins and trusted members are
// exempt. A first hit warns the sender; repeat hits escalate to mute, kick, and
// ban. Private chats and commands are never moderated here.

const composer = new Composer<Ctx>();

const BLACKLIST = [
  "casino",
  "viagra",
  "crypto giveaway",
  "earn money fast",
  "free gift",
  "click to earn",
  "buy followers",
  "limited time offer",
];

interface SpamVerdict {
  spam: boolean;
  reason: string;
}

function analyze(text: string): SpamVerdict {
  const t = text.trim();
  if (/https?:\/\//i.test(t)) return { spam: true, reason: "contains a link" };
  const lower = t.toLowerCase();
  for (const w of BLACKLIST) {
    if (lower.includes(w)) return { spam: true, reason: "blocked phrase" };
  }
  if (/(\S)\1{6,}/.test(t)) return { spam: true, reason: "repeated characters" };
  if (t.length >= 16) {
    const letters = t.replace(/[^A-Za-z]/g, "");
    if (letters.length > 0) {
      const caps = letters.replace(/[^A-Z]/g, "").length;
      if (caps / letters.length > 0.7) return { spam: true, reason: "excessive capitalization" };
    }
  }
  return { spam: false, reason: "" };
}

function escalation(hitCount: number): Action {
  if (hitCount <= 1) return "warn";
  if (hitCount === 2) return "mute";
  if (hitCount === 3) return "kick";
  return "ban";
}

function isGroup(ctx: Ctx): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function isCommand(ctx: Ctx): boolean {
  const ents = ctx.message?.entities ?? [];
  return ents.some((e) => e.type === "bot_command");
}

composer.on("message:text").filter(
  (ctx): boolean => isGroup(ctx) && !isCommand(ctx),
  async (ctx) => {
    const chatId = ctx.chat!.id;
    const sender = ctx.message.from;
    if (!sender || sender.is_bot) return;

    const data = await getChat(chatId);
    const member = upsertMember(data, sender.id, sender.first_name ?? "", {});
    if (data.adminIds.includes(sender.id) || member.trusted) {
      await putChat(chatId, data);
      return; // admins/trusted are exempt
    }

    const verdict = analyze(ctx.message.text ?? "");
    if (!verdict.spam) {
      await putChat(chatId, data);
      return; // clean message — silent
    }

    member.infractions += 1;
    const action = escalation(member.infractions);
    const reason = `spam: ${verdict.reason}`;
    logAction(data, chatId, { actor: 0, target: sender.id, action, reason });
    await putChat(chatId, data);

    try {
      await ctx.deleteMessage();
    } catch {
      // best-effort
    }

    const name = member.firstName || sender.first_name || `user ${sender.id}`;
    let notice: string;
    switch (action) {
      case "mute":
        try {
          await ctx.api.restrictChatMember(chatId, sender.id, {
            can_send_messages: false,
            can_send_audios: false,
            can_send_documents: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_video_notes: false,
            can_send_voice_notes: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
          });
        } catch {
          // best-effort
        }
        notice = `🔇 ${name} muted for ${Math.round(DEFAULT_MUTE_SECONDS / 60)} minutes — spam (${verdict.reason}).`;
        break;
      case "kick":
        try {
          await ctx.api.banChatMember(chatId, sender.id);
          await ctx.api.unbanChatMember(chatId, sender.id);
        } catch {
          // best-effort
        }
        notice = `👢 ${name} removed — repeated spam (${verdict.reason}).`;
        break;
      case "ban":
        try {
          await ctx.api.banChatMember(chatId, sender.id);
        } catch {
          // best-effort
        }
        notice = `⛔ ${name} banned — persistent spam (${verdict.reason}).`;
        break;
      default:
        notice = `⚠️ ${name}: that looked like spam (${verdict.reason}). Repeated spam leads to a mute, kick, or ban.`;
    }
    await ctx.reply(notice);
  },
);

export default composer;
