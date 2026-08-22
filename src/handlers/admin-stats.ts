import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { requireAdmin, displayName } from "../moderation.js";
import { getChat, type ChatData, type Action } from "../store.js";
import { answerCallback, editOrReply } from "../telegram.js";

// GroupGuard — "View Stats". Aggregates the chat's audit log (capped at 200) into
// a concise summary admins can read at a glance, with an option to push the same
// summary to the configured notification target.

registerMainMenuItem({ label: "📊 Stats", data: "admin:stats", order: 20 });

const composer = new Composer<Ctx>();

function summarize(data: ChatData): string {
  const counts: Record<Action, number> = {
    warn: 0, mute: 0, kick: 0, ban: 0, trust: 0, verify: 0, join: 0, spam: 0,
    config: 0, config_denied: 0,
  };
  for (const id of data.auditIds) {
    const rec = data.audit[id];
    if (rec) counts[rec.action] += 1;
  }
  return (
    `📊 Moderation stats (last 200 actions)\n\n` +
    `Joins: ${counts.join}\n` +
    `Verifications: ${counts.verify}\n` +
    `Warns: ${counts.warn}\n` +
    `Mutes: ${counts.mute}\n` +
    `Kicks: ${counts.kick}\n` +
    `Bans: ${counts.ban}\n` +
    `Trusted: ${counts.trust}\n\n` +
    `Settings changes: ${counts.config}\n` +
    `Blocked settings attempts: ${counts.config_denied}\n\n` +
    (data.auditIds.length === 0
      ? "No moderation activity yet — actions will appear here."
      : `Recent: ${data.auditIds.slice(0, 5).length} action(s) recorded.`)
  );
}

const statsKeyboard = inlineKeyboard([
  [inlineButton("📤 Send to target", "admin:stats:send")],
  [inlineButton("⬅️ Back to panel", "admin:panel")],
]);

composer.callbackQuery("admin:stats", async (ctx) => {
  await answerCallback(ctx);
  const data = await requireAdmin(ctx);
  if (!data) return;
  await editOrReply(ctx, summarize(data), { reply_markup: statsKeyboard });
});

composer.callbackQuery("admin:stats:send", async (ctx) => {
  await answerCallback(ctx);
  const data = await requireAdmin(ctx);
  if (!data) return;
  const target = data.config.notifyTarget;
  if (!target) {
    await ctx.reply("No notification target set. Open Settings to add one first.");
    return;
  }
  const text = summarize(data);
  try {
    await ctx.api.sendMessage(target, text);
    await ctx.reply("Sent the summary to the configured chat.");
  } catch {
    await ctx.reply("Couldn't deliver the summary. Check the notification target and try again.");
  }
});

export default composer;
