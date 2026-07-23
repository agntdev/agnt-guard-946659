import { Composer } from "grammy";
import type { ChatPermissions } from "grammy/types";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";
import {
  getChat,
  putChat,
  upsertMember,
  setTrusted,
  logAction,
  VERIFICATION_WINDOW_MS,
  VERIFICATION_WINDOW_LABEL,
} from "../store.js";
import { now } from "../clock.js";

// GroupGuard — new-member verification. When someone joins, the bot restricts
// them, posts the group's welcome + rules with an "I'm human" button, and waits
// VERIFICATION_WINDOW_MS (2 minutes). Tapping the button within the window
// lifts the restriction and records the verification; a tap after the window
// expires removes the member.

registerMainMenuItem({ label: "✅ I'm human", data: "verification:confirm", order: 5 });

const composer = new Composer<Ctx>();

const RESTRICTED: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};

const GRANTED: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
};

function displayName(firstName: string, userId: number): string {
  return firstName && firstName.trim() !== "" ? firstName : `user ${userId}`;
}

composer.on("message:new_chat_members", async (ctx, next) => {
  const chatId = ctx.chat.id;
  const data = await getChat(chatId);
  for (const user of ctx.message.new_chat_members ?? []) {
    if (user.is_bot) continue;
    upsertMember(data, user.id, user.first_name ?? "", { joinTime: now() });
    const joinedAt = now();
    data.pending[user.id] = {
      timestamp: joinedAt,
      expiry: joinedAt + VERIFICATION_WINDOW_MS,
      status: "pending",
    };
    try {
      await ctx.api.restrictChatMember(chatId, user.id, RESTRICTED);
    } catch {
      // best-effort: missing "restrict" permission shouldn't block the welcome
    }
    logAction(data, chatId, {
      actor: 0,
      target: user.id,
      action: "join",
      reason: `joined — verify within ${VERIFICATION_WINDOW_LABEL} (${VERIFICATION_WINDOW_MS}ms)`,
    });
  }
  await putChat(chatId, data);

  // One consolidated welcome for the batch.
  const names = (ctx.message.new_chat_members ?? [])
    .filter((u) => !u.is_bot)
    .map((u) => displayName(u.first_name ?? "", u.id));
  if (names.length === 0) return next();

  const first = names.join(", ");
  const text =
    `Welcome, ${first}!\n\n${data.config.welcomeText}\n\n📋 Rules:\n${data.config.rules}\n\n` +
    `You have ${VERIFICATION_WINDOW_LABEL} to tap the button and verify you're human — ` +
    `otherwise you'll be removed.`;
  const keyboard = inlineKeyboard([
    [inlineButton("✅ I'm human", "verification:confirm")],
  ]);
  await ctx.reply(text, { reply_markup: keyboard });
});

composer.callbackQuery("verification:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat?.id;
  const userId = ctx.callbackQuery.from.id;
  if (!chatId) {
    await ctx.reply("Couldn't verify you here. Try again in the group.");
    return;
  }
  const data = await getChat(chatId);
  const pending = data.pending[userId];

  if (!pending) {
    const member = data.members[userId];
    if (member && member.trusted) {
      await ctx.reply("✅ You're already verified — no action needed.");
    } else {
      await ctx.reply("No verification needed — you can send messages freely.");
    }
    return;
  }

  if (pending.status === "verified") {
    await ctx.reply("✅ You're already verified — no action needed.");
    return;
  }

  const t = now();
  if (t > pending.expiry) {
    // Verification pressed after the 2-minute window — remove the member and explain.
    pending.status = "expired";
    setTrusted(data, userId, false);
    upsertMember(data, userId, ctx.callbackQuery.from.first_name ?? "", {});
    logAction(data, chatId, {
      actor: 0,
      target: userId,
      action: "kick",
      reason: `verification timed out after ${VERIFICATION_WINDOW_LABEL} (${VERIFICATION_WINDOW_MS}ms)`,
    });
    await putChat(chatId, data);
    try {
      await ctx.api.banChatMember(chatId, userId);
      await ctx.api.unbanChatMember(chatId, userId);
    } catch {
      // best-effort: missing rights shouldn't break the message
    }
    await ctx.reply(
      `Verification timed out for ${displayName(ctx.callbackQuery.from.first_name ?? "", userId)} — they've been removed. ` +
        `They can rejoin and try again within ${VERIFICATION_WINDOW_LABEL}.`,
    );
    return;
  }

  // Verified within the 2-minute window — lift the restriction.
  pending.status = "verified";
  setTrusted(data, userId, true);
  const storedName = data.members[userId]?.firstName ?? ctx.callbackQuery.from.first_name ?? "";
  upsertMember(data, userId, storedName, { trusted: true });
  logAction(data, chatId, {
    actor: 0,
    target: userId,
    action: "verify",
    reason: `passed human check within ${VERIFICATION_WINDOW_LABEL}`,
  });
  await putChat(chatId, data);
  try {
    await ctx.api.restrictChatMember(chatId, userId, GRANTED);
  } catch {
    // best-effort
  }
  await ctx.reply(
    `✅ Thanks, ${displayName(storedName, userId)} — you're verified and can send messages now.`,
  );
});

export default composer;
