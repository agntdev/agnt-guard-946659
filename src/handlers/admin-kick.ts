import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { showMemberList } from "../moderation.js";
import { answerCallback } from "../telegram.js";

// GroupGuard — "Kick" admin action. Opens the member picker; selecting a member
// prompts for a reason (handled in mod.ts), then removes them from the group.

const composer = new Composer<Ctx>();

composer.callbackQuery("admin:kick", async (ctx) => {
  await answerCallback(ctx);
  await showMemberList(ctx, "kick");
});

export default composer;
