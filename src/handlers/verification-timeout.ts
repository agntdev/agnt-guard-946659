import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { now } from "../clock.js";
import { getChat, logAction, putChat, setTrusted, VERIFICATION_WINDOW_LABEL } from "../store.js";

// Telegram has no delayed-update primitive. This sweep runs on every group
// message, using the durable pending index, so an expired challenge is enforced
// even when its member never presses the button. The late button path in
// verification-confirm remains a second, race-safe enforcement point.
const composer = new Composer<Ctx>();

function isGroup(ctx: Ctx): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

export async function sweepExpiredVerifications(ctx: Ctx): Promise<boolean> {
  if (!isGroup(ctx) || !ctx.chat) return false;
  const data = await getChat(ctx.chat.id);
  const expired = Object.entries(data.pending)
    .filter(([, challenge]) => challenge.status === "pending" && now() > challenge.expiry)
    .map(([id]) => Number(id));
  if (expired.length === 0) return false;

  for (const userId of expired) {
    const challenge = data.pending[userId]!;
    challenge.status = "expired";
    setTrusted(data, userId, false);
    logAction(data, ctx.chat.id, {
      actor: 0,
      target: userId,
      action: "kick",
      reason: `verification timed out after ${VERIFICATION_WINDOW_LABEL}`,
    });
  }
  await putChat(ctx.chat.id, data);

  const removed: number[] = [];
  const notRemoved: number[] = [];
  for (const userId of expired) {
    try {
      await ctx.api.banChatMember(ctx.chat.id, userId);
      await ctx.api.unbanChatMember(ctx.chat.id, userId);
      removed.push(userId);
    } catch {
      // A missing bot right must not stop expiry processing for other members.
      notRemoved.push(userId);
    }
  }
  if (removed.length > 0) {
    const names = removed.map((id) => data.members[id]?.firstName || "a member");
    await ctx.reply(
      `${names.join(", ")} ${removed.length === 1 ? "was" : "were"} removed after the ${VERIFICATION_WINDOW_LABEL} verification window expired.`,
    );
  }
  if (notRemoved.length > 0) {
    const names = notRemoved.map((id) => data.members[id]?.firstName || "a member");
    await ctx.reply(`The verification window expired for ${names.join(", ")}, but I couldn't remove ${notRemoved.length === 1 ? "that member" : "those members"}. Check my Restrict members permission.`);
  }
  return true;
}

composer.on("message", async (ctx, next) => {
  await sweepExpiredVerifications(ctx);
  return next();
});

export default composer;
