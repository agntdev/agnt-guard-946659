import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { showMemberList } from "../moderation.js";

// GroupGuard — "Mark Trusted" admin action. Opens the member picker; selecting a
// member toggles their trusted flag immediately (no reason needed), exempting
// them from auto-moderation.

const composer = new Composer<Ctx>();

composer.callbackQuery("admin:trust", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showMemberList(ctx, "trust");
});

export default composer;
