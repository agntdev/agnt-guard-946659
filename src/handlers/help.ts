import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { answerCallback, editOrReply } from "../telegram.js";

// /help — plain-language explanation for non-technical users. This bot is
// button-driven: tell the user to tap /start to open the menu rather than listing
// slash commands. The same text is shown when the user taps the Help button on the
// main menu (`menu:help`). Enhance the copy for your specific bot; keep it short.
const composer = new Composer<Ctx>();

const HELP =
  "GroupGuard keeps your group protected.\n\n" +
  "/start — Start the bot\n/help — Show all commands\n/warn — Warn a member\n/warnings — Check a member's warnings\n/resetwarn — Remove a member's warnings\n/mute — Mute a member\n/unmute — Unmute a member\n/kick — Remove a member from the group\n/ban — Ban a member\n/unban — Unban a member\n/rules — Show group rules\n\n" +
  "For member actions, reply to that member's message before sending the command.";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await answerCallback(ctx);
  await editOrReply(ctx, HELP, { reply_markup: backToMenu });
});

export default composer;
