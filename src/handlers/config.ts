import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getChat, putChat, logAction, VERIFICATION_WINDOW_LABEL, type ChatData } from "../store.js";
import { answerCallback, editOrReply } from "../telegram.js";

// GroupGuard — configuration management. Admins edit the welcome text, rules,
// the spam-escalation threshold, and the notification target for summary
// reports. All values live in the chat's durable record. The human-verification
// window is fixed at VERIFICATION_WINDOW_LABEL (2 minutes).

registerMainMenuItem({ label: "⚙️ Settings", data: "config:panel", order: 30 });

const composer = new Composer<Ctx>();

function panelKeyboard() {
  return inlineKeyboard([
    [inlineButton("📝 Welcome text", "config:edit:welcome")],
    [inlineButton("📋 Rules", "config:edit:rules")],
    [inlineButton("🔢 Spam threshold", "config:edit:threshold")],
    [inlineButton("🔔 Summary target", "config:edit:notify")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

const PANEL_TEXT =
  `Settings. New members get ${VERIFICATION_WINDOW_LABEL} to verify. Tap what you'd like to change.`;

const OWNER_DENIED = "Only the bot owner can edit this bot.";

function isTelegramOwner(member: { status: string }): boolean {
  return member.status === "owner" || member.status === "creator";
}

/**
 * Settings are deliberately stricter than moderation: only the persisted
 * group owner may edit them. Existing groups are safely bootstrapped from a
 * Telegram owner/creator lookup, never from the first person who taps a menu.
 */
async function requireConfigurationOwner(ctx: Ctx): Promise<ChatData | null> {
  if (!ctx.chat || !ctx.from) return null;
  const data = await getChat(ctx.chat.id);
  if (data.config.ownerId === ctx.from.id) return data;

  if (data.config.ownerId === null) {
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      if (isTelegramOwner(member)) {
        data.config.ownerId = ctx.from.id;
        logAction(data, ctx.chat.id, {
          actor: ctx.from.id,
          target: ctx.from.id,
          action: "config",
          reason: "configuration owner established",
        });
        await putChat(ctx.chat.id, data);
        return data;
      }
    } catch {
      // A failed lookup must fail closed: settings are never opened to admins.
    }
  }

  logAction(data, ctx.chat.id, {
    actor: ctx.from.id,
    target: ctx.from.id,
    action: "config_denied",
    reason: "non-owner attempted to edit configuration",
  });
  await putChat(ctx.chat.id, data);
  await ctx.reply(OWNER_DENIED);
  return null;
}

async function showPanel(ctx: Ctx): Promise<void> {
  const data = await requireConfigurationOwner(ctx);
  if (!data) return;
  await editOrReply(ctx, PANEL_TEXT, { reply_markup: panelKeyboard() });
}

composer.callbackQuery("config:panel", async (ctx) => {
  await answerCallback(ctx);
  ctx.session.step = "idle";
  await showPanel(ctx);
});

async function startEdit(ctx: Ctx, step: Ctx["session"]["step"], prompt: string): Promise<void> {
  const data = await requireConfigurationOwner(ctx);
  if (!data) return;
  ctx.session.step = step;
  ctx.session.configEditorId = ctx.from!.id;
  await editOrReply(ctx, prompt, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "config:panel")]]),
  });
}

composer.callbackQuery("config:edit:welcome", async (ctx) => {
  await answerCallback(ctx);
  await startEdit(ctx, "config_welcome", "Send the new welcome text (or /cancel).");
});

composer.callbackQuery("config:edit:rules", async (ctx) => {
  await answerCallback(ctx);
  await startEdit(ctx, "config_rules", "Send the new rules (one per line, or /cancel).");
});

composer.callbackQuery("config:edit:threshold", async (ctx) => {
  await answerCallback(ctx);
  await startEdit(ctx, "config_threshold", "Send the new spam threshold — a number like 2 (or /cancel).");
});

composer.callbackQuery("config:edit:notify", async (ctx) => {
  await answerCallback(ctx);
  const data = await requireConfigurationOwner(ctx);
  if (!data || !ctx.chat || !ctx.from) return;
  data.config.notifyTarget = ctx.chat.id;
  logAction(data, ctx.chat.id, {
    actor: ctx.from.id,
    target: ctx.from.id,
    action: "config",
    reason: "updated notification target to this chat",
  });
  await putChat(ctx.chat.id, data);
  await editOrReply(ctx, "✅ Saved. This chat will receive moderation summaries.", {
    reply_markup: backToPanelKeyboard(),
  });
});

function backToPanelKeyboard() {
  return inlineKeyboard([[inlineButton("⬅️ Back to settings", "config:panel")]]);
}

composer.on("message:text").filter(
  (ctx) =>
    ctx.session.step === "config_welcome" ||
    ctx.session.step === "config_rules" ||
    ctx.session.step === "config_threshold" ||
    ctx.session.step === "config_notify",
  async (ctx) => {
    const data = await requireConfigurationOwner(ctx);
    if (!data) return;
    if (ctx.session.configEditorId !== ctx.from.id) {
      // A group session belongs to the chat, so do not let another user submit
      // a value into an owner-started flow.
      await ctx.reply(OWNER_DENIED);
      return;
    }
    const text = ctx.message.text.trim();
    if (/^\/cancel$/i.test(text)) {
      ctx.session.step = "idle";
      ctx.session.configEditorId = undefined;
      await ctx.reply("Cancelled. Tap Settings to pick something else.");
      return;
    }

    if (!text) {
      await ctx.reply("That can't be blank. Send the value again or use /cancel.");
      return;
    }
    if (ctx.session.step === "config_welcome") {
      data.config.welcomeText = text;
      logAction(data, ctx.chat.id, { actor: ctx.from.id, target: ctx.from.id, action: "config", reason: "updated welcome text" });
      await putChat(ctx.chat.id, data);
      ctx.session.step = "idle";
      ctx.session.configEditorId = undefined;
      await ctx.reply(`✅ Saved. New welcome text:\n\n${text}`, { reply_markup: backToPanelKeyboard() });
      return;
    }
    if (ctx.session.step === "config_rules") {
      data.config.rules = text;
      logAction(data, ctx.chat.id, { actor: ctx.from.id, target: ctx.from.id, action: "config", reason: "updated rules" });
      await putChat(ctx.chat.id, data);
      ctx.session.step = "idle";
      ctx.session.configEditorId = undefined;
      await ctx.reply(`✅ Saved. New rules:\n\n${text}`, { reply_markup: backToPanelKeyboard() });
      return;
    }
    if (ctx.session.step === "config_threshold") {
      const n = Number(text);
      if (!/^\d+$/.test(text) || n < 1) {
        await ctx.reply("That's not a positive number. Send a number like 2 (or /cancel).");
        return;
      }
      data.config.spamThreshold = n;
      logAction(data, ctx.chat.id, { actor: ctx.from.id, target: ctx.from.id, action: "config", reason: "updated spam threshold" });
      await putChat(ctx.chat.id, data);
      ctx.session.step = "idle";
      ctx.session.configEditorId = undefined;
      await ctx.reply(`✅ Saved. Spam threshold is now ${n}.`, { reply_markup: backToPanelKeyboard() });
      return;
    }
    // Kept for sessions created before the summary target became a one-tap
    // current-chat setting.
    const id = Number(text);
    if (!/^-?\d+$/.test(text)) {
      await ctx.reply("That's not a chat id. Send the numeric chat id (or /cancel).");
      return;
    }
    data.config.notifyTarget = id;
    logAction(data, ctx.chat.id, { actor: ctx.from.id, target: ctx.from.id, action: "config", reason: "updated notification target" });
    await putChat(ctx.chat.id, data);
    ctx.session.step = "idle";
    ctx.session.configEditorId = undefined;
    await ctx.reply("✅ Saved. Summaries will go to that chat.", { reply_markup: backToPanelKeyboard() });
  },
);

export default composer;
