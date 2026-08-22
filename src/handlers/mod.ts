import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getChat, putChat, setModerator } from "../store.js";
import {
  modPanelKeyboard,
  requireAdmin,
  requireModeratorManager,
  memberListKeyboard,
  showMemberList,
  applyAction,
  botRightsForAction,
  parseDuration,
  formatDuration,
  displayName,
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
  // The global owner may open this panel to reach the internal moderator list
  // even if they are not an administrator in this particular group. Individual
  // Telegram moderation actions still perform their own requireAdmin checks.
  const data = await requireModeratorManager(ctx);
  if (!data) return;
  await ctx.reply(PANEL_TEXT, { reply_markup: modPanelKeyboard() });
});

composer.callbackQuery("admin:panel", async (ctx) => {
  await answerCallback(ctx);
  ctx.session.step = "idle";
  ctx.session.pendingAction = undefined;
  ctx.session.pendingTarget = undefined;
  const data = await requireModeratorManager(ctx);
  if (!data) return;
  await editOrReply(ctx, PANEL_TEXT, { reply_markup: modPanelKeyboard() });
});

function moderatorsKeyboard() {
  return inlineKeyboard([
    [inlineButton("View moderators", "admin:moderators:list")],
    [inlineButton("Add moderator", "admin:moderators:add")],
    [inlineButton("Remove moderator", "admin:moderators:remove")],
    [inlineButton("⬅️ Back to panel", "admin:panel")],
  ]);
}

function moderatorPicker(data: Awaited<ReturnType<typeof getChat>>, mode: "add" | "remove") {
  const ids = mode === "add"
    ? data.memberIds.filter((id) => !data.moderatorIds.includes(id))
    : data.moderatorIds;
  const rows = ids.map((id) => [inlineButton(displayName(data.members[id]?.firstName ?? "", id), `moderator:${mode}:${id}`)]);
  rows.push([inlineButton("⬅️ Back", "admin:moderators")]);
  return inlineKeyboard(rows);
}

composer.callbackQuery("admin:moderators", async (ctx) => {
  await answerCallback(ctx);
  const data = await requireModeratorManager(ctx);
  if (!data) return;
  const count = data.moderatorIds.length;
  await editOrReply(ctx,
    count === 0 ? "No internal moderators yet — add a trusted member to delegate moderation." : `Internal moderators: ${count}. Choose what to change.`,
    { reply_markup: moderatorsKeyboard() },
  );
});

composer.callbackQuery("admin:moderators:list", async (ctx) => {
  await answerCallback(ctx);
  const data = await requireModeratorManager(ctx);
  if (!data) return;
  const names = data.moderatorIds.map((id) => displayName(data.members[id]?.firstName ?? "", id));
  await editOrReply(ctx,
    names.length === 0 ? "No internal moderators yet — add a member when you're ready." : `Internal moderators:\n${names.map((name) => `• ${name}`).join("\n")}`,
    { reply_markup: moderatorsKeyboard() },
  );
});

composer.callbackQuery(/^admin:moderators:(add|remove)$/, async (ctx) => {
  await answerCallback(ctx);
  const data = await requireModeratorManager(ctx);
  if (!data) return;
  const mode = ctx.match![1] as "add" | "remove";
  const available = mode === "add"
    ? data.memberIds.some((id) => !data.moderatorIds.includes(id))
    : data.moderatorIds.length > 0;
  if (!available) {
    await editOrReply(ctx,
      mode === "add" ? "No eligible members yet — wait for someone to join first." : "No internal moderators to remove.",
      { reply_markup: moderatorsKeyboard() },
    );
    return;
  }
  await editOrReply(ctx, mode === "add" ? "Choose a member to make a moderator." : "Choose a moderator to remove.", {
    reply_markup: moderatorPicker(data, mode),
  });
});

composer.callbackQuery(/^moderator:(add|remove):(-?\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  const data = await requireModeratorManager(ctx);
  if (!data || !ctx.chat) return;
  const mode = ctx.match![1] as "add" | "remove";
  const targetId = Number(ctx.match![2]);
  if (!data.members[targetId] || (mode === "add" && data.moderatorIds.includes(targetId)) || (mode === "remove" && !data.moderatorIds.includes(targetId))) {
    await editOrReply(ctx, "That moderator list has changed. Open it again and choose a member.", { reply_markup: moderatorsKeyboard() });
    return;
  }
  setModerator(data, targetId, mode === "add");
  await putChat(ctx.chat.id, data);
  const name = displayName(data.members[targetId]?.firstName ?? "", targetId);
  await editOrReply(ctx,
    mode === "add" ? `${name} can now manage moderation in this group.` : `${name} can no longer manage moderation in this group.`,
    { reply_markup: moderatorsKeyboard() },
  );
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
