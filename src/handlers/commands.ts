import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getChat, putChat, logAction, upsertMember, type ChatData } from "../store.js";
import { applyAction, botRightsForAction, formatDuration, parseDuration, requireAdmin } from "../moderation.js";
import { modPanelKeyboard } from "../moderation.js";

const composer = new Composer<Ctx>();
const PANEL_TEXT = "Moderation panel. Pick an action, then choose a member to apply it to.";

interface CommandTarget {
  id: number;
  name: string;
  username?: string;
}

function repliedTarget(ctx: Ctx): CommandTarget | null {
  const user = ctx.message?.reply_to_message?.from;
  if (!user || user.is_bot) return null;
  return { id: user.id, name: user.first_name || "that member", username: user.username };
}

function commandArgument(ctx: Ctx): string {
  return (ctx.message?.text ?? "").replace(/^\/\w+(?:@\w+)?\s*/i, "").trim();
}

function providedTarget(ctx: Ctx, data: ChatData): { target: CommandTarget; reason: string } | null {
  const argument = commandArgument(ctx);
  if (!argument) return null;
  const textMention = ctx.message?.entities?.find((entity) => entity.type === "text_mention");
  if (textMention?.type === "text_mention") {
    const user = textMention.user;
    const visibleMention = (ctx.message?.text ?? "").slice(textMention.offset, textMention.offset + textMention.length);
    return {
      target: { id: user.id, name: user.first_name || `user ${user.id}`, username: user.username },
      reason: argument.replace(visibleMention, "").trim(),
    };
  }
  const [token, ...reasonParts] = argument.split(/\s+/);
  if (!token) return null;

  const numericId = /^-?\d+$/.test(token) ? Number(token) : undefined;
  const byId = numericId === undefined ? undefined : data.members[numericId];
  const username = token.startsWith("@") ? token.slice(1).toLowerCase() : undefined;
  const byUsername = username
    ? data.memberIds.map((id) => data.members[id]).find((member) => member?.username?.toLowerCase() === username)
    : undefined;
  const member = byId ?? byUsername;
  if (!member) return null;
  return {
    target: { id: member.userId, name: member.firstName || `user ${member.userId}`, username: member.username },
    reason: reasonParts.join(" "),
  };
}

async function needTarget(ctx: Ctx, data: ChatData, allowProvided = false): Promise<{ target: CommandTarget; reason?: string } | null> {
  const target = repliedTarget(ctx);
  if (target) return { target };
  if (allowProvided) {
    const provided = providedTarget(ctx, data);
    if (provided) return provided;
    // A numeric id need not have appeared in this bot's local member index yet.
    // Telegram is the source of truth for current group membership, so resolve
    // it through getChatMember before accepting it as a moderation target.
    const argument = commandArgument(ctx);
    const [token, ...reasonParts] = argument.split(/\s+/);
    if (ctx.chat && token && /^-?\d+$/.test(token)) {
      try {
        const member = await ctx.api.getChatMember(ctx.chat.id, Number(token));
        if (!member.user.is_bot) {
          return {
            target: { id: member.user.id, name: member.user.first_name || `user ${member.user.id}`, username: member.user.username },
            reason: reasonParts.join(" "),
          };
        }
      } catch {
        // The normal guidance below gives an admin a useful recovery path.
      }
    }
  }
  await ctx.reply(allowProvided
    ? "Reply to a member's message, or use their known @username or numeric ID after the command."
    : "Reply to a member's message, then send this command.");
  return null;
}

async function execute(ctx: Ctx, action: "warn" | "kick" | "ban", reason: string): Promise<void> {
  const data = await requireAdmin(ctx, botRightsForAction(action));
  if (!data || !ctx.chat || !ctx.from) return;
  const resolved = await needTarget(ctx, data);
  if (!resolved) return;
  const target = resolved.target;
  if (!reason) {
    await ctx.reply("Add a short reason after the command.");
    return;
  }
  const message = await applyAction(ctx, data, ctx.chat.id, ctx.from.id, action, target.id, reason, null);
  await putChat(ctx.chat.id, data);
  await ctx.reply(message);
}

composer.command("warn", async (ctx) => {
  const data = await requireAdmin(ctx, botRightsForAction("warn"));
  if (!data || !ctx.chat || !ctx.from) return;
  const resolved = await needTarget(ctx, data, true);
  if (!resolved) return;
  const target = resolved.target;
  const reason = ctx.message?.reply_to_message ? commandArgument(ctx) : (resolved.reason ?? "");
  // Keep the known member record current when the admin warned by reply.
  upsertMember(data, target.id, target.name, { username: target.username });
  const message = await applyAction(ctx, data, ctx.chat.id, ctx.from.id, "warn", target.id, reason || "No reason provided.", null);
  await putChat(ctx.chat.id, data);
  await ctx.reply(message);
});
composer.command("kick", (ctx) => execute(ctx, "kick", commandArgument(ctx)));
composer.command("ban", (ctx) => execute(ctx, "ban", commandArgument(ctx)));

composer.command("mute", async (ctx) => {
  const data = await requireAdmin(ctx, botRightsForAction("mute"));
  if (!data || !ctx.chat || !ctx.from) return;
  const resolved = await needTarget(ctx, data);
  if (!resolved) return;
  const target = resolved.target;
  const seconds = parseDuration(commandArgument(ctx));
  if (!seconds || seconds <= 0) {
    await ctx.reply("Add a duration like 30m, 1h, or 2d after /mute.");
    return;
  }
  const message = await applyAction(ctx, data, ctx.chat.id, ctx.from.id, "mute", target.id, `muted ${formatDuration(seconds)}`, seconds);
  await putChat(ctx.chat.id, data);
  await ctx.reply(message);
});

composer.command("unmute", async (ctx) => {
  const data = await requireAdmin(ctx, botRightsForAction("mute"));
  if (!data || !ctx.chat || !ctx.from) return;
  const resolved = await needTarget(ctx, data);
  if (!resolved) return;
  const target = resolved.target;
  try {
    await ctx.api.restrictChatMember(ctx.chat.id, target.id, {
      can_send_messages: true, can_send_audios: true, can_send_documents: true,
      can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
      can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
      can_add_web_page_previews: true,
    });
  } catch {
    await ctx.reply("Couldn't unmute that member. Check that I can manage restrictions.");
    return;
  }
  logAction(data, ctx.chat.id, { actor: ctx.from.id, target: target.id, action: "mute", reason: "unmuted" });
  await putChat(ctx.chat.id, data);
  await ctx.reply(`${target.name} can send messages again.`);
});

composer.command("warnings", async (ctx) => {
  const data = await requireAdmin(ctx, botRightsForAction("warn"));
  if (!data || !ctx.chat) return;
  const resolved = await needTarget(ctx, data, true);
  if (!resolved) return;
  const target = resolved.target;
  const count = data.members[target.id]?.warningCount ?? 0;
  await ctx.reply(`${target.name} has ${count} warning${count === 1 ? "" : "s"}.`);
});

composer.command("resetwarn", async (ctx) => {
  const data = await requireAdmin(ctx, botRightsForAction("warn"));
  if (!data || !ctx.chat || !ctx.from) return;
  const resolved = await needTarget(ctx, data, true);
  if (!resolved) return;
  const target = resolved.target;
  upsertMember(data, target.id, target.name, { warningCount: 0, username: target.username });
  logAction(data, ctx.chat.id, { actor: ctx.from.id, target: target.id, action: "warn", reason: "warnings reset", warningCount: 0 });
  await putChat(ctx.chat.id, data);
  await ctx.reply(`Removed ${target.name}'s warnings.`);
});

composer.command("unban", async (ctx) => {
  const data = await requireAdmin(ctx, botRightsForAction("ban"));
  if (!data || !ctx.chat) return;
  const resolved = await needTarget(ctx, data);
  if (!resolved) return;
  const target = resolved.target;
  try {
    await ctx.api.unbanChatMember(ctx.chat.id, target.id, { only_if_banned: true });
  } catch {
    await ctx.reply("Couldn't unban that member. Check that I can manage bans.");
    return;
  }
  await ctx.reply(`${target.name} can join the group again.`);
});

composer.command("rules", async (ctx) => {
  if (!ctx.chat) return;
  const data = await getChat(ctx.chat.id);
  await ctx.reply(`Group rules:\n${data.config.rules}`);
});

// A panel shortcut remains available through the main menu; it is deliberately
// not published as a Telegram slash command.
composer.callbackQuery("admin:commands-panel", async (ctx) => {
  const data = await requireAdmin(ctx);
  if (!data) return;
  await ctx.reply(PANEL_TEXT, { reply_markup: modPanelKeyboard() });
});

export default composer;
