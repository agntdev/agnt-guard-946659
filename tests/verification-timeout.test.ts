import { afterEach, describe, expect, it } from "vitest";
import { buildBot } from "../src/bot.js";
import { now, resetClock, setClock } from "../src/clock.js";
import { getChat } from "../src/store.js";

const botInfo = {
  id: 42,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as const;

describe("verification timeout", () => {
  afterEach(resetClock);

  it("removes an unverified member on the next group activity after the deadline", async () => {
    const fixed = 1_700_000_000_000;
    setClock(() => fixed);
    const bot = await buildBot("123456:TEST");
    bot.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: (payload ?? {}) as Record<string, unknown> });
      return { ok: true, result: true } as any;
    });

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 990, type: "supergroup", title: "Timeout" },
        from: { id: 1, is_bot: false, first_name: "Admin" },
        new_chat_members: [{ id: 55, is_bot: false, first_name: "Late" }],
      },
    } as any);

    setClock(() => fixed + 120_001);
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        chat: { id: 990, type: "supergroup", title: "Timeout" },
        from: { id: 1, is_bot: false, first_name: "Admin" },
        text: "still here",
      },
    } as any);

    expect(calls.some((call) => call.method === "banChatMember" && call.payload.user_id === 55)).toBe(true);
    expect((await getChat(990)).pending[55]?.status).toBe("expired");
    expect(now()).toBe(fixed + 120_001);
  });
});
