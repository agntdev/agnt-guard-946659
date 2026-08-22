import type { Ctx } from "./bot.js";

/** Callback answers and message edits are best-effort UI affordances. Telegram
 * rejects stale callback ids and identical/old messages; neither should abort a
 * moderation action. */
export async function answerCallback(ctx: Ctx): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // A callback can expire while Telegram retries a webhook delivery.
  }
}

export async function editOrReply(
  ctx: Ctx,
  text: string,
  extra?: Parameters<Ctx["editMessageText"]>[1],
): Promise<void> {
  try {
    await ctx.editMessageText(text, extra);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/message is not modified/i.test(message)) return;
    await ctx.reply(text, extra).catch(() => undefined);
  }
}
