import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard } from "../toolkit/index.js";
import { answerCallback, editOrReply } from "../telegram.js";

// The /start handler renders the bot's MAIN MENU — the primary way users operate
// a button-first bot. A feature adds its own button by calling
// `registerMainMenuItem(...)` in its own `src/handlers/<slug>.ts`; this handler
// renders whatever is registered (plus a Help button), so you do NOT edit this
// file to add a feature. Send ONE message — no placeholder line above the menu.
const composer = new Composer<Ctx>();

const WELCOME = "👋 Welcome! Tap a button below to get started.";

composer.command("start", async (ctx) => {
  await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await answerCallback(ctx);
  await editOrReply(ctx, WELCOME, { reply_markup: mainMenuKeyboard() });
});

export default composer;
