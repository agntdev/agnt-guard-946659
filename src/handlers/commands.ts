import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getChat, putChat, logAction, upsertMember } from "../store.js";
import { applyAction, formatDuration, parseDuration, requireAdmin } from "../moderation.js";
import { modPanelKeyboard } from "../moderation.js";

const composer = new Composer<Ctx>();
const PANEL_TEXT = "Moderation panel. Pick an action, then choose a member to apply it to.";

function repliedTarget(ctx: Ctx): { id: number; name: string } | null {
  const user = ctx.message?.reply_to_message?.from;
  if (!user || user.is_bot) return null;
  return { id: user.id, name: user.first_name || "that member" };
}

function commandArgument(ctx: Ctx): string {
  return (ctx.message?.text ?? "").replace(/^\/\w+(?:@\w+)?\s*/i, "").trim();
}

async function needTarget(ctx: Ctx): Promise<{ id: number; name: string } | null> {
  const target = repliedTarget(ctx);
  if (!target) await ctx.reply("Reply to a member's message, then send this command.");
  return target;
}

async function execute(ctx: Ctx, action: "warn" | "kick" | "ban", reason: string): Promise<void> {
  const data = await requireAdmin(ctx);
  if (!data || !ctx.chat || !ctx.from) return;
  const target = await needTarget(ctx);
  if (!target) return;
  if (!reason) {
    await ctx.reply("Add a short reason after the command.");
    return;
  }
  const message = await applyAction(ctx, data, ctx.chat.id, ctx.from.id, action, target.id, reason, null);
  await putChat(ctx.chat.id, data);
  await ctx.reply(message);
}

composer.command("warn", (ctx) => execute(ctx, "warn", commandArgument(ctx)));
composer.command("kick", (ctx) => execute(ctx, "kick", commandArgument(ctx)));
composer.command("ban", (ctx) => execute(ctx, "ban", commandArgument(ctx)));

composer.command("mute", async (ctx) => {
  const data = await requireAdmin(ctx);
  if (!data || !ctx.chat || !ctx.from) return;
  const target = await needTarget(ctx);
  if (!target) return;
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
  const data = await requireAdmin(ctx);
  if (!data || !ctx.chat || !ctx.from) return;
  const target = await needTarget(ctx);
  if (!target) return;
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
  const data = await requireAdmin(ctx);
  if (!data || !ctx.chat) return;
  const target = await needTarget(ctx);
  if (!target) return;
  const count = data.members[target.id]?.infractions ?? 0;
  await ctx.reply(`${target.name} has ${count} warning${count === 1 ? "" : "s"}.`);
});

composer.command("resetwarn", async (ctx) => {
  const data = await requireAdmin(ctx);
  if (!data || !ctx.chat || !ctx.from) return;
  const target = await needTarget(ctx);
  if (!target) return;
  upsertMember(data, target.id, target.name, { infractions: 0 });
  logAction(data, ctx.chat.id, { actor: ctx.from.id, target: target.id, action: "warn", reason: "warnings reset" });
  await putChat(ctx.chat.id, data);
  await ctx.reply(`Removed ${target.name}'s warnings.`);
});

composer.command("unban", async (ctx) => {
  const data = await requireAdmin(ctx);
  if (!data || !ctx.chat) return;
  const target = await needTarget(ctx);
  if (!target) return;
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
