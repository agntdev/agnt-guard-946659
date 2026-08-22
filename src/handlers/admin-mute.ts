import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { showMemberList } from "../moderation.js";
import { answerCallback } from "../telegram.js";

// GroupGuard — "Mute" admin action. Opens the member picker; selecting a member
// prompts for a duration (handled in mod.ts), then restricts them in the chat.

const composer = new Composer<Ctx>();

composer.callbackQuery("admin:mute", async (ctx) => {
  await answerCallback(ctx);
  await showMemberList(ctx, "mute");
});

export default composer;
