import type { Ctx } from "./bot.js";

function isBenignTelegramUiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message is not modified|query is too old|query ID is invalid|not enough rights to send text messages/i.test(message);
}

/**
 * Telegram can redeliver a callback after its answer window, and an admin can
 * temporarily remove the bot's send right. Those UI-only failures must not
 * abort a moderation update or flood the global error boundary.
 */
export function softenTelegramUiErrors(ctx: Ctx): void {
  const reply = ctx.reply.bind(ctx);
  const editMessageText = ctx.editMessageText.bind(ctx);
  const answerCallbackQuery = ctx.answerCallbackQuery.bind(ctx);

  ctx.reply = (async (...args: Parameters<Ctx["reply"]>) => {
    try {
      return await reply(...args);
    } catch (error) {
      if (isBenignTelegramUiError(error)) return undefined as never;
      throw error;
    }
  }) as Ctx["reply"];
  ctx.editMessageText = (async (...args: Parameters<Ctx["editMessageText"]>) => {
    try {
      return await editMessageText(...args);
    } catch (error) {
      if (isBenignTelegramUiError(error)) return undefined as never;
      throw error;
    }
  }) as Ctx["editMessageText"];
  ctx.answerCallbackQuery = (async (...args: Parameters<Ctx["answerCallbackQuery"]>) => {
    try {
      return await answerCallbackQuery(...args);
    } catch (error) {
      if (isBenignTelegramUiError(error)) return undefined as never;
      throw error;
    }
  }) as Ctx["answerCallbackQuery"];
}

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
