// Global owner resolution. Workers expose owner-supplied settings as bindings
// on the context; Node and the replay harness use process.env as a fallback.
// Keep this in one place so authorization never silently differs by runtime.

import type { Ctx } from "./bot.js";

type OwnerEnv = { OWNER_TELEGRAM_ID?: string | number };

function parseOwnerId(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

/** The configured global bot owner, or null while the binding is unset. */
export function configuredOwnerId(ctx: Ctx): number | null {
  const workerValue = (ctx as Ctx & { env?: OwnerEnv }).env?.OWNER_TELEGRAM_ID;
  return parseOwnerId(workerValue) ?? parseOwnerId(typeof process === "undefined" ? undefined : process.env.OWNER_TELEGRAM_ID);
}

/** True only for the owner explicitly supplied at deployment. */
export function isConfiguredOwner(ctx: Ctx): boolean {
  return ctx.from !== undefined && configuredOwnerId(ctx) === ctx.from.id;
}
