import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getChat, logAction, putChat } from "../store.js";
import { botOwnerId, isBotOwner, isOperator } from "../ownership.js";

// Ownership is intentionally an explicit power-user command: it is used for
// initial setup and recovery, while normal administration remains button-first.
const composer = new Composer<Ctx>();

function requestedOwnerId(ctx: Ctx): number | null {
  const replyUser = ctx.message?.reply_to_message?.from;
  if (replyUser && !replyUser.is_bot) return replyUser.id;
  const argument = (ctx.message?.text ?? "").replace(/^\/set_owner(?:@\w+)?\s*/i, "").trim();
  return /^\d+$/.test(argument) && Number.isSafeInteger(Number(argument)) ? Number(argument) : null;
}

composer.command("set_owner", async (ctx) => {
  if (!ctx.chat || !ctx.from) return;
  const data = await getChat(ctx.chat.id);
  const current = await botOwnerId(ctx, data);
  const allowed = await isBotOwner(ctx, data);
  if (!allowed && !isOperator(ctx)) {
    await ctx.reply("Only the current bot owner or platform operator can change the bot owner.");
    return;
  }
  const next = requestedOwnerId(ctx);
  if (next === null) {
    await ctx.reply("Reply to a user with /set_owner, or send /set_owner followed by their numeric user ID.");
    return;
  }
  try {
    await ctx.api.getChat(next);
  } catch {
    await ctx.reply("I couldn't find that Telegram user. Ask them to start the bot, then try again.");
    return;
  }
  if (current === next) {
    await ctx.reply("That user is already the bot owner.");
    return;
  }
  data.config.botOwnerId = next;
  logAction(data, ctx.chat.id, {
    actor: ctx.from.id,
    target: next,
    action: "owner_change",
    reason: current === null ? "set bot owner" : `transferred bot owner from ${current}`,
  });
  await putChat(ctx.chat.id, data);
  await ctx.reply("Bot owner updated. They can now manage settings, moderators, and full moderation records.");
});

composer.command("botinfo", async (ctx) => {
  if (!ctx.chat || !ctx.from) return;
  const data = await getChat(ctx.chat.id);
  if (!await isBotOwner(ctx, data)) {
    await ctx.reply("Only the bot owner can view bot ownership details.");
    return;
  }
  const owner = await botOwnerId(ctx, data);
  await ctx.reply(owner === null ? "No bot owner is configured yet." : `Current bot owner: ${owner}.`);
});

export default composer;
