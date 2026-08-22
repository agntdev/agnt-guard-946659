// Global owner resolution. Workers expose owner-supplied settings as bindings
// on the context; Node and the replay harness use process.env as a fallback.
// Keep this in one place so authorization never silently differs by runtime.

import type { Ctx } from "./bot.js";
import { logAction, putChat, type ChatData } from "./store.js";

type OwnerEnv = { OWNER_TELEGRAM_ID?: string | number; BOT_OWNER_ID?: string | number };

function parseOwnerId(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

/** Deployment-provided initial owner. It seeds a new per-group record only. */
export function deploymentOwnerId(ctx: Ctx): number | null {
  const env = (ctx as Ctx & { env?: OwnerEnv }).env;
  return parseOwnerId(env?.BOT_OWNER_ID)
    ?? parseOwnerId(typeof process === "undefined" ? undefined : process.env.BOT_OWNER_ID);
}

/** Platform/deployer operator. This is deliberately separate from bot ownership. */
export function operatorId(ctx: Ctx): number | null {
  const env = (ctx as Ctx & { env?: OwnerEnv }).env;
  return parseOwnerId(env?.OWNER_TELEGRAM_ID)
    ?? parseOwnerId(typeof process === "undefined" ? undefined : process.env.OWNER_TELEGRAM_ID);
}

export function isOperator(ctx: Ctx): boolean {
  return ctx.from?.id === operatorId(ctx);
}

/** The deployment owner controls bot-wide privacy operations. Per-group bot
 * ownership is intentionally insufficient for an action that affects every
 * group using this bot. */
export function isDeploymentOwner(ctx: Ctx): boolean {
  return ctx.from?.id === deploymentOwnerId(ctx);
}

/**
 * Resolve the durable owner and seed it once from BOT_OWNER_ID. The deployment
 * binding is never allowed to overwrite a deliberate in-bot ownership transfer.
 */
export async function botOwnerId(ctx: Ctx, data: ChatData): Promise<number | null> {
  if (data.config.botOwnerId !== null) return data.config.botOwnerId;
  const seeded = deploymentOwnerId(ctx);
  if (seeded === null || !ctx.chat) return null;
  data.config.botOwnerId = seeded;
  logAction(data, ctx.chat.id, {
    actor: 0,
    target: seeded,
    action: "owner_change",
    reason: "initialized bot owner from deployment setting",
  });
  await putChat(ctx.chat.id, data);
  return seeded;
}

/** Bot owner and platform operator both bypass internal authorization checks. */
export async function isBotOwner(ctx: Ctx, data: ChatData): Promise<boolean> {
  if (!ctx.from) return false;
  return isOperator(ctx) || (await botOwnerId(ctx, data)) === ctx.from.id;
}
