// Shared moderation helpers used by the admin action handlers. Not a Composer —
// lives outside src/handlers/ so buildBot() never tries to auto-load it.

import type { Ctx } from "./bot.js";
import {
  getChat,
  putChat,
  upsertMember,
  setTrusted,
  isAdmin,
  logAction,
  DEFAULT_MUTE_SECONDS,
  type ChatData,
  type Action,
} from "./store.js";
import { now } from "./clock.js";
import { inlineButton, inlineKeyboard, type InlineKeyboardMarkup } from "./toolkit/index.js";
import { editOrReply } from "./telegram.js";
import { isBotOwner } from "./ownership.js";

export function displayName(firstName: string, userId: number): string {
  return firstName && firstName.trim() !== "" ? firstName : `user ${userId}`;
}

export function warningTargetLabel(firstName: string, userId: number, username?: string): string {
  const name = displayName(firstName, userId);
  return username ? `${name} (@${username.replace(/^@/, "")})` : `${name} (id: ${userId})`;
}

export function warningNotice(firstName: string, userId: number, username: string | undefined, reason: string, count: number): string {
  return `⚠️ 乂𝗭𝗬𝗡Ø𝗫 WARNING\nUser: ${warningTargetLabel(firstName, userId, username)}\nReason: ${reason || "No reason provided."}\nWarning: ${count}/3\nPlease follow the group rules. Further violations may result in a mute, kick, or ban.`;
}

/** /mod panel — every admin action as a button, plus stats and settings. */
export function modPanelKeyboard(): InlineKeyboardMarkup {
  return inlineKeyboard([
    [inlineButton("⚠️ Warn", "admin:warn")],
    [inlineButton("🔇 Mute", "admin:mute"), inlineButton("👢 Kick", "admin:kick")],
    [inlineButton("⛔ Ban", "admin:ban"), inlineButton("✅ Mark Trusted", "admin:trust")],
    [inlineButton("📊 View Stats", "admin:stats")],
    [inlineButton("Manage moderators", "admin:moderators")],
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

type BotRight = "can_manage_chat" | "can_restrict_members";

const BOT_RIGHT_LABEL: Record<BotRight, string> = {
  can_manage_chat: "manage chat",
  can_restrict_members: "restrict members",
};

function isAdministrator(member: { status: string }): boolean {
  // Telegram called the group owner "creator" in older Bot API payloads and
  // "owner" in newer ones. Accept both alongside ordinary administrators.
  return member.status === "creator" || member.status === "owner" || member.status === "administrator";
}

function botRightMissing(member: unknown, right: BotRight): boolean {
  const value = member as Record<string, unknown>;
  return value[right] !== true;
}

function rightsMessage(rights: BotRight[]): string {
  const labels = rights.map((right) => BOT_RIGHT_LABEL[right]);
  return `I must be an administrator with ${labels.join(" and ")} to perform this action.`;
}

/**
 * Authorize a group moderator and confirm the bot can carry out the requested
 * action. A Telegram administrator/owner is always allowed. GroupGuard's
 * explicit moderator role is also allowed: it is a durable, per-group
 * delegation made through the moderation panel, not an incidental cache of a
 * Telegram lookup.
 */
export async function requireAdmin(ctx: Ctx, requiredBotRights: BotRight[] = ["can_manage_chat"]): Promise<ChatData | null> {
  if (!ctx.chat || !ctx.from) return null;
  const data = await getChat(ctx.chat.id);
  const internallyDelegated = isAdmin(data, ctx.from.id) || await isBotOwner(ctx, data);
  let telegramAdministrator = false;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    telegramAdministrator = isAdministrator(member);
    if (telegramAdministrator && !data.adminIds.includes(ctx.from.id)) data.adminIds.push(ctx.from.id);
    await putChat(ctx.chat.id, data);
  } catch { /* Keep a durable internal role usable if Telegram lookup is temporarily unavailable. */ }
  if (!telegramAdministrator && !internallyDelegated) {
    await ctx.reply("You don't have permission to manage moderators.");
    return null;
  }

  try {
    const botMember = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
    const missing = !isAdministrator(botMember)
      ? requiredBotRights
      : requiredBotRights.filter((right) => botRightMissing(botMember, right));
    if (missing.length > 0) {
      await ctx.reply(rightsMessage(missing));
      return null;
    }
  } catch {
    await ctx.reply(rightsMessage(requiredBotRights));
    return null;
  }
  return data;
}

/**
 * Internal moderator-list administration has intentionally different rules
 * from Telegram moderation actions. The configured bot owner may curate the
 * bot's stored moderator list even when they are not a Telegram administrator;
 * a Telegram group administrator may do the same. No Bot API permission check
 * is made here because this path never changes Telegram chat permissions.
 */
export async function requireModeratorManager(ctx: Ctx): Promise<ChatData | null> {
  if (!ctx.chat || !ctx.from) return null;
  const data = await getChat(ctx.chat.id);
  // A moderator is an explicit, durable delegation. Do not use the observed
  // Telegram-admin cache here: that cache is only for spam exemptions and can
  // be stale after an administrator is demoted.
  let allowed = await isBotOwner(ctx, data) || data.moderatorIds.includes(ctx.from.id);
  if (!allowed) {
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      const privileges = member as unknown as Record<string, unknown>;
      const status = member.status as string;
      const isCreator = status === "creator" || status === "owner";
      const canManageModerators = status === "administrator"
        && (privileges.can_promote_members === true || privileges.can_restrict_members === true);
      allowed = isCreator || canManageModerators;
      if (allowed && isAdministrator(member) && !data.adminIds.includes(ctx.from.id)) {
        data.adminIds.push(ctx.from.id);
        await putChat(ctx.chat.id, data);
      }
    } catch {
      // A stored designated moderator remains usable during a temporary
      // Telegram lookup failure; everyone else fails closed.
    }
  }
  if (!allowed) {
    await ctx.reply("You must be the bot owner, a chat admin with Promote/Restrict rights, or a designated moderator to manage moderators. If you are an admin, ensure the bot is also an admin with Promote/Restrict rights.");
    return null;
  }
  return data;
}

/** Confirm that the bot itself can make a moderator-list change. This check is
 * deliberately separate from opening/viewing the list so admins can diagnose
 * a missing bot right without being locked out of the panel. */
export async function requireModeratorChangeRights(ctx: Ctx): Promise<boolean> {
  if (!ctx.chat) return false;
  // The internal moderator list is GroupGuard data, not a Telegram admin-role
  // change. A configured bot owner may always maintain it, including when the
  // bot's Telegram rights were temporarily reduced.
  const data = await getChat(ctx.chat.id);
  if (await isBotOwner(ctx, data)) return true;
  try {
    const botMember = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
    const privileges = botMember as unknown as Record<string, unknown>;
    const status = botMember.status as string;
    const canChange = status === "creator" || status === "owner"
      || (status === "administrator"
        && (privileges.can_promote_members === true || privileges.can_restrict_members === true));
    if (canChange) return true;
  } catch {
    // The same clear message applies when Telegram cannot confirm the bot's
    // membership or rights.
  }
  await ctx.reply("Bot must be an admin with Promote/Restrict members permission to change moderators.");
  return false;
}

export function botRightsForAction(action: Action): BotRight[] {
  return action === "mute" || action === "kick" || action === "ban"
    ? ["can_manage_chat", "can_restrict_members"]
    : ["can_manage_chat"];
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
  // Telegram does not permit a bot to restrict another administrator. More
  // importantly, never turn a moderator command into an infraction against a
  // fellow admin just because a stale local record labelled them as a member.
  try {
    const targetMember = await ctx.api.getChatMember(chatId, targetId);
    if (isAdministrator(targetMember)) {
      console.debug("GroupGuard skipped action against administrator", { chatId, targetId, action });
      return "I can't moderate another group administrator.";
    }
  } catch {
    // The subsequent Bot API operation remains the source of truth. A target
    // lookup can fail for a recently departed member without making the whole
    // moderation flow unusable.
  }

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
      target.warningCount = Math.min(3, (target.warningCount ?? 0) + 1);
      logAction(data, chatId, {
        actor: actorId,
        target: targetId,
        action: "warn",
        reason: reason || "No reason provided.",
        warningCount: target.warningCount,
      });
      return warningNotice(target.firstName, targetId, target.username, reason, target.warningCount);
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
  const data = await requireAdmin(ctx, botRightsForAction(action));
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
