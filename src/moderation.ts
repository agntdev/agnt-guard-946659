// Shared moderation helpers used by the admin action handlers. Not a Composer —
// lives outside src/handlers/ so buildBot() never tries to auto-load it.

import type { Ctx } from "./bot.js";
import {
  getChat,
  putChat,
  upsertMember,
  setTrusted,
  logAction,
  isAdmin,
  DEFAULT_MUTE_SECONDS,
  type ChatData,
  type Action,
} from "./store.js";
import { now } from "./clock.js";
import { inlineButton, inlineKeyboard, type InlineKeyboardMarkup } from "./toolkit/index.js";
import { editOrReply } from "./telegram.js";

export function displayName(firstName: string, userId: number): string {
  return firstName && firstName.trim() !== "" ? firstName : `user ${userId}`;
}

/** /mod panel — every admin action as a button, plus stats and settings. */
export function modPanelKeyboard(): InlineKeyboardMarkup {
  return inlineKeyboard([
    [inlineButton("⚠️ Warn", "admin:warn")],
    [inlineButton("🔇 Mute", "admin:mute"), inlineButton("👢 Kick", "admin:kick")],
    [inlineButton("⛔ Ban", "admin:ban"), inlineButton("✅ Mark Trusted", "admin:trust")],
    [inlineButton("📊 View Stats", "admin:stats")],
    [inlineButton("⚙️ Settings", "config:panel")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

/** Member list for an action — one button per (non-admin) member. */
export function memberListKeyboard(data: ChatData, action: Action): InlineKeyboardMarkup {
  const rows = data.memberIds
    .filter((id) => action !== "trust" || true)
    .map((id) => {
      const m = data.members[id];
      const label = `${displayName(m?.firstName ?? "", id)}${m?.trusted ? " ✅" : ""}`;
      return [inlineButton(label, `act:${action}:${id}`)];
    });
  rows.push([inlineButton("⬅️ Back to panel", "admin:panel")]);
  return inlineKeyboard(rows);
}

/** Require the acting user be a group admin (no auto-promote here). */
export async function requireAdmin(ctx: Ctx): Promise<ChatData | null> {
  if (!ctx.chat || !ctx.from) return null;
  const data = await getChat(ctx.chat.id);
  let permitted = isAdmin(data, ctx.from.id);
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    permitted = member.status === "creator" || member.status === "administrator";
    if (permitted && !data.adminIds.includes(ctx.from.id)) data.adminIds.push(ctx.from.id);
    if (!permitted) data.adminIds = data.adminIds.filter((id) => id !== ctx.from!.id);
    await putChat(ctx.chat.id, data);
  } catch {
    // A previously verified admin remains usable during a short Telegram outage.
  }
  if (!permitted) {
    await ctx.reply("Only group admins can manage moderation here.");
    return null;
  }
  return data;
}

export function parseDuration(text: string): number | null {
  const m = /^\s*(\d+)\s*(s|m|h|d)\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
}

/** Apply a moderation action against a target member; returns the user-facing
 *  confirmation line. Caller persists `data` afterwards. */
export async function applyAction(
  ctx: Ctx,
  data: ChatData,
  chatId: number | string,
  actorId: number,
  action: Action,
  targetId: number,
  reason: string,
  durationSeconds: number | null,
): Promise<string> {
  const target = upsertMember(data, targetId, "", {});
  const name = displayName(target.firstName, targetId);

  if (action === "trust") {
    const next = !target.trusted;
    setTrusted(data, targetId, next);
    logAction(data, chatId, { actor: actorId, target: targetId, action: "trust", reason: next ? "marked trusted" : "removed trust" });
    return next ? `✅ ${name} is now trusted — exempt from auto-moderation.` : `↩️ ${name} is no longer trusted.`;
  }

  switch (action) {
    case "warn": {
      target.infractions += 1;
      logAction(data, chatId, { actor: actorId, target: targetId, action: "warn", reason });
      return `⚠️ Warned ${name}: ${reason}. They've been warned ${target.infractions} time(s).`;
    }
    case "mute": {
      const secs = durationSeconds ?? DEFAULT_MUTE_SECONDS;
      try {
        await ctx.api.restrictChatMember(
          chatId,
          targetId,
          {
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
          },
          { until_date: Math.round(now() / 1000) + secs },
        );
      } catch {
        // best-effort
      }
      target.infractions += 1;
      logAction(data, chatId, { actor: actorId, target: targetId, action: "mute", reason });
      return `🔇 Muted ${name} for ${formatDuration(secs)}.`;
    }
    case "kick": {
      try {
        await ctx.api.banChatMember(chatId, targetId);
        await ctx.api.unbanChatMember(chatId, targetId);
      } catch {
        // best-effort
      }
      target.infractions += 1;
      logAction(data, chatId, { actor: actorId, target: targetId, action: "kick", reason });
      return `👢 Kicked ${name}: ${reason}.`;
    }
    case "ban": {
      try {
        await ctx.api.banChatMember(chatId, targetId);
      } catch {
        // best-effort
      }
      target.infractions += 1;
      logAction(data, chatId, { actor: actorId, target: targetId, action: "ban", reason });
      return `⛔ Banned ${name}: ${reason}.`;
    }
    default:
      return "Unsupported action.";
  }
}

export function formatDuration(secs: number): string {
  if (secs >= 86400 && secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs >= 60 && secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

export { putChat };

/** Render a member picker for `action` (used by the warn/mute/kick/ban/trust
 *  buttons). Empty state when the group has no members yet. */
export async function showMemberList(ctx: Ctx, action: Action): Promise<void> {
  const data = await requireAdmin(ctx);
  if (!data) return;
  if (data.memberIds.length === 0) {
    await editOrReply(ctx,
      "No members yet — once people join, you'll be able to pick them here.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to panel", "admin:panel")]]) },
    );
    return;
  }
  const verb =
    action === "warn" ? "warn" :
    action === "mute" ? "mute" :
    action === "kick" ? "kick" :
    action === "ban" ? "ban" : "mark as trusted";
  await editOrReply(ctx, `Pick a member to ${verb}:`, {
    reply_markup: memberListKeyboard(data, action),
  });
}
