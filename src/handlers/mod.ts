import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getChat } from "../store.js";
import {
  modPanelKeyboard,
  requireAdmin,
  memberListKeyboard,
  showMemberList,
  applyAction,
  botRightsForAction,
  parseDuration,
  formatDuration,
  displayName,
  putChat,
} from "../moderation.js";
import { answerCallback, editOrReply } from "../telegram.js";

// GroupGuard — admin moderation panel (/mod) and the shared action flow that
// warn/mute/kick/ban/trust funnel through. Each action first lists members as
// buttons; tapping a member prompts for a reason (or duration, for mute) and
// then executes the action against the Bot API.

registerMainMenuItem({ label: "🛡 Moderation", data: "admin:panel", order: 10 });

const composer = new Composer<Ctx>();

const PANEL_TEXT =
  "Moderation panel. Pick an action, then choose a member to apply it to.";

// Kept as a compatibility shortcut for existing groups. It is intentionally not
// included in Telegram's published command list; the Moderation menu is primary.
composer.command("mod", async (ctx) => {
  const data = await requireAdmin(ctx);
  if (!data) return;
  await ctx.reply(PANEL_TEXT, { reply_markup: modPanelKeyboard() });
});

composer.callbackQuery("admin:panel", async (ctx) => {
  await answerCallback(ctx);
  ctx.session.step = "idle";
  ctx.session.pendingAction = undefined;
  ctx.session.pendingTarget = undefined;
  const data = await requireAdmin(ctx);
  if (!data) return;
  await editOrReply(ctx, PANEL_TEXT, { reply_markup: modPanelKeyboard() });
});

// Each admin action button (admin:warn / admin:mute / ...) lives in its own
// handler module and renders the shared member picker via showMemberList.

// Tap a member for a given action — start the reason/duration flow (or toggle trust).
composer.callbackQuery(/^act:(warn|mute|kick|ban|trust):(-?\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  const action = ctx.match![1] as "warn" | "mute" | "kick" | "ban" | "trust";
  const data = await requireAdmin(ctx, botRightsForAction(action));
  if (!data) return;
  const targetId = Number(ctx.match![2]);
  const target = data.members[targetId];
  const name = displayName(target?.firstName ?? "", targetId);

  if (action === "trust") {
    const reason = "manual trust toggle";
    const msg = await applyAction(ctx, data, ctx.chat!.id, ctx.from!.id, "trust", targetId, reason, null);
    await putChat(ctx.chat!.id, data);
    await editOrReply(ctx, msg, { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to panel", "admin:panel")]]) });
    return;
  }

  ctx.session.step = action === "mute" ? "duration" : "reason";
  ctx.session.pendingAction = action;
  ctx.session.pendingTarget = targetId;
  await putChat(ctx.chat!.id, data);

  if (action === "mute") {
    await editOrReply(ctx,
      `How long should I mute ${name}? Send a duration like 30m, 1h, or 2d (or /cancel).`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "admin:panel")]]) },
    );
  } else {
    await editOrReply(ctx,
      `Send a reason for this ${action} of ${name} (or /cancel).`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "admin:panel")]]) },
    );
  }
});

// Cancel an in-flight reason/duration flow falls through to the admin:panel
// handler above (the Cancel / Back buttons carry data "admin:panel"), which
// resets the session step and re-renders the panel.

// Typed reason / duration input.
composer.on("message:text").filter(
  (ctx) => ctx.session.step === "reason" || ctx.session.step === "duration",
  async (ctx) => {
    const action = ctx.session.pendingAction;
    const targetId = ctx.session.pendingTarget;
    if (!action || targetId === undefined) {
      ctx.session.step = "idle";
      return;
    }
    const text = ctx.message.text.trim();
    if (/^\/cancel$/i.test(text)) {
      ctx.session.step = "idle";
      ctx.session.pendingAction = undefined;
      ctx.session.pendingTarget = undefined;
      await ctx.reply("Cancelled. You're back at the panel — tap /mod.");
      return;
    }

    const data = await requireAdmin(ctx, botRightsForAction(action));
    if (!data) return;
    const target = data.members[targetId];
    const name = displayName(target?.firstName ?? "", targetId);

    if (ctx.session.step === "duration") {
      const secs = parseDuration(text);
      if (secs === null || secs <= 0) {
        await ctx.reply(`That duration didn't parse. Try 30m, 1h, or 2d (or /cancel).`);
        return; // stay in duration step
      }
      const msg = await applyAction(ctx, data, ctx.chat.id, ctx.from.id, action, targetId, `muted ${formatDuration(secs)}`, secs);
      await putChat(ctx.chat.id, data);
      ctx.session.step = "idle";
      ctx.session.pendingAction = undefined;
      ctx.session.pendingTarget = undefined;
      await ctx.reply(msg);
      return;
    }

    if (!text) {
      await ctx.reply("Reason can't be empty. Send a short reason (or /cancel).");
      return;
    }
    const msg = await applyAction(ctx, data, ctx.chat.id, ctx.from.id, action, targetId, text, null);
    await putChat(ctx.chat.id, data);
    ctx.session.step = "idle";
    ctx.session.pendingAction = undefined;
    ctx.session.pendingTarget = undefined;
    await ctx.reply(msg);
  },
);

export default composer;
