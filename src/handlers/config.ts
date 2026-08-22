import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getChat, putChat, logAction, purgeActivityAcrossChats, VERIFICATION_WINDOW_LABEL, type ChatData } from "../store.js";
import { answerCallback, editOrReply } from "../telegram.js";
import { isBotOwner, isDeploymentOwner, isOperator } from "../ownership.js";

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
    [inlineButton("🛡 Spam actions", "config:actions")],
    [inlineButton("🔔 Summary target", "config:edit:notify")],
    [inlineButton("Clear activity data", "config:privacy")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

const PANEL_TEXT =
  `Settings. New members get ${VERIFICATION_WINDOW_LABEL} to verify. Tap what you'd like to change.`;

const OWNER_DENIED = "Only the bot owner may edit bot settings.";
const PRIVACY_DENIED = "Only the deployment owner can clear activity data across groups.";

/**
 * Settings are deliberately stricter than moderation: only the configured
 * global bot owner may edit them. This is not inferred from group ownership or
 * from the first person who taps a menu.
 */
async function requireConfigurationOwner(ctx: Ctx): Promise<ChatData | null> {
  if (!ctx.chat || !ctx.from) return null;
  const data = await getChat(ctx.chat.id);
  if (await isBotOwner(ctx, data)) return data;

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

function privacyConfirmKeyboard() {
  return inlineKeyboard([
    [inlineButton("Clear activity data", "config:privacy:confirm")],
    [inlineButton("⬅️ Back to settings", "config:panel")],
  ]);
}

/** This deliberately requires the deployment owner rather than a per-group
 * owner: the confirmed operation clears activity from every indexed group. */
function canClearAllActivity(ctx: Ctx): boolean {
  return isOperator(ctx) || isDeploymentOwner(ctx);
}

composer.callbackQuery("config:privacy", async (ctx) => {
  await answerCallback(ctx);
  if (!canClearAllActivity(ctx)) {
    await ctx.reply(PRIVACY_DENIED);
    return;
  }
  await editOrReply(ctx,
    "This permanently clears stored verification activity, member records, moderation actions, reports, and counters across every GroupGuard group. Settings, rules, templates, admin lists, and summary targets stay."
    + "\n\nTap Clear activity data to continue.",
    { reply_markup: privacyConfirmKeyboard() },
  );
});

composer.callbackQuery("config:privacy:confirm", async (ctx) => {
  await answerCallback(ctx);
  if (!canClearAllActivity(ctx)) {
    await ctx.reply(PRIVACY_DENIED);
    return;
  }
  await purgeActivityAcrossChats();
  ctx.session.step = "idle";
  ctx.session.pendingAction = undefined;
  ctx.session.pendingTarget = undefined;
  ctx.session.configEditorId = undefined;
  await editOrReply(ctx,
    "Activity data has been permanently cleared across GroupGuard. Verification challenges, member records, moderation actions, reports, logs, and counters are now empty. Settings are unchanged.",
    { reply_markup: panelKeyboard() },
  );
});

function actionsKeyboard(data: ChatData) {
  const label = (action: "warn" | "mute" | "kick" | "ban") =>
    `${data.config.enabledActions[action] ? "✅" : "○"} ${action[0]!.toUpperCase()}${action.slice(1)}`;
  return inlineKeyboard([
    [inlineButton(label("warn"), "config:action:warn"), inlineButton(label("mute"), "config:action:mute")],
    [inlineButton(label("kick"), "config:action:kick"), inlineButton(label("ban"), "config:action:ban")],
    [inlineButton("⬅️ Back to settings", "config:panel")],
  ]);
}

composer.callbackQuery("config:actions", async (ctx) => {
  await answerCallback(ctx);
  const data = await requireConfigurationOwner(ctx);
  if (!data) return;
  await editOrReply(ctx, "Choose which automatic spam actions GroupGuard may use.", {
    reply_markup: actionsKeyboard(data),
  });
});

composer.callbackQuery(/^config:action:(warn|mute|kick|ban)$/, async (ctx) => {
  await answerCallback(ctx);
  const data = await requireConfigurationOwner(ctx);
  if (!data || !ctx.chat || !ctx.from) return;
  const action = ctx.match![1] as "warn" | "mute" | "kick" | "ban";
  data.config.enabledActions[action] = !data.config.enabledActions[action];
  logAction(data, ctx.chat.id, {
    actor: ctx.from.id,
    target: ctx.from.id,
    action: "config",
    reason: `${data.config.enabledActions[action] ? "enabled" : "disabled"} automatic spam ${action}`,
  });
  await putChat(ctx.chat.id, data);
  await editOrReply(ctx, "Choose which automatic spam actions GroupGuard may use.", {
    reply_markup: actionsKeyboard(data),
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
