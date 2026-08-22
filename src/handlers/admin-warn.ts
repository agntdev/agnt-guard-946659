import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { showMemberList } from "../moderation.js";
import { answerCallback } from "../telegram.js";

// GroupGuard — "Warn" admin action. Opens the member picker; selecting a member
// prompts for a reason (handled in mod.ts) and records a warning infraction.

const composer = new Composer<Ctx>();

composer.callbackQuery("admin:warn", async (ctx) => {
  await answerCallback(ctx);
  await showMemberList(ctx, "warn");
});

export default composer;
