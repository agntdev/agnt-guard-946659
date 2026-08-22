import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { showMemberList } from "../moderation.js";
import { answerCallback } from "../telegram.js";

// GroupGuard — "Ban" admin action. Opens the member picker; selecting a member
// prompts for a reason (handled in mod.ts), then permanently bans them.

const composer = new Composer<Ctx>();

composer.callbackQuery("admin:ban", async (ctx) => {
  await answerCallback(ctx);
  await showMemberList(ctx, "ban");
});

export default composer;
