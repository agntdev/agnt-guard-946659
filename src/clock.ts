// Injectable clock — every time-based decision (verification window, audit
// timestamps, schedule cutoffs) routes through here so a test can override it.
// Never call `new Date()` / `Date.now()` inline in a handler.

export type Clock = () => number;

let clock: Clock = () => Date.now();

/** Current time in epoch milliseconds. Route all "now" decisions through this. */
export function now(): number {
  return clock();
}

/** Override the clock (test hook). Pass a function returning a fixed epoch ms. */
export function setClock(c: Clock): void {
  clock = c;
}

/** Restore the default wall-clock clock (test hook). */
export function resetClock(): void {
  clock = () => Date.now();
}
