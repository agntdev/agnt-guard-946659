import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { requireAdmin } from "../moderation.js";
import { getChat, putChat, VERIFICATION_WINDOW_LABEL } from "../store.js";

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
    [inlineButton("🔔 Notify target", "config:edit:notify")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

const PANEL_TEXT =
  `Settings. New members get ${VERIFICATION_WINDOW_LABEL} to verify. Tap what you'd like to change.`;

async function showPanel(ctx: Ctx): Promise<void> {
  const data = await requireAdmin(ctx);
  if (!data) return;
  await ctx.editMessageText(PANEL_TEXT, { reply_markup: panelKeyboard() });
}

composer.callbackQuery("config:panel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  await showPanel(ctx);
});

async function startEdit(ctx: Ctx, step: Ctx["session"]["step"], prompt: string): Promise<void> {
  const data = await requireAdmin(ctx);
  if (!data) return;
  ctx.session.step = step;
  await ctx.editMessageText(prompt, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "config:panel")]]),
  });
}

composer.callbackQuery("config:edit:welcome", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startEdit(ctx, "config_welcome", "Send the new welcome text (or /cancel).");
});

composer.callbackQuery("config:edit:rules", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startEdit(ctx, "config_rules", "Send the new rules (one per line, or /cancel).");
});

composer.callbackQuery("config:edit:threshold", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startEdit(ctx, "config_threshold", "Send the new spam threshold — a number like 2 (or /cancel).");
});

composer.callbackQuery("config:edit:notify", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startEdit(ctx, "config_notify", "Send the chat id that should receive summary reports (or /cancel).");
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
    const text = ctx.message.text.trim();
    if (/^\/cancel$/i.test(text)) {
      ctx.session.step = "idle";
      await ctx.reply("Cancelled. Tap Settings to pick something else.");
      return;
    }

    const data = await getChat(ctx.chat.id);
    if (ctx.session.step === "config_welcome") {
      data.config.welcomeText = text;
      await putChat(ctx.chat.id, data);
      ctx.session.step = "idle";
      await ctx.reply(`✅ Saved. New welcome text:\n\n${text}`, { reply_markup: backToPanelKeyboard() });
      return;
    }
    if (ctx.session.step === "config_rules") {
      data.config.rules = text;
      await putChat(ctx.chat.id, data);
      ctx.session.step = "idle";
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
      await putChat(ctx.chat.id, data);
      ctx.session.step = "idle";
      await ctx.reply(`✅ Saved. Spam threshold is now ${n}.`, { reply_markup: backToPanelKeyboard() });
      return;
    }
    // config_notify
    const id = Number(text);
    if (!/^-?\d+$/.test(text)) {
      await ctx.reply("That's not a chat id. Send the numeric chat id (or /cancel).");
      return;
    }
    data.config.notifyTarget = id;
    await putChat(ctx.chat.id, data);
    ctx.session.step = "idle";
    await ctx.reply(`✅ Saved. Summaries will go to chat ${id}.`, { reply_markup: backToPanelKeyboard() });
  },
);

export default composer;
