import { describe, expect, it } from "vitest";
import { buildBot } from "../src/bot.js";
import { callbackUpdate } from "../src/toolkit/harness/updates.js";

const botInfo = {
  id: 42,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as const;

describe("Telegram UI resilience", () => {
  it("keeps an unchanged-menu callback from aborting the update", async () => {
    const bot = await buildBot("123456:TEST");
    bot.botInfo = botInfo;
    const calls: string[] = [];
    bot.api.config.use(async (_prev, method) => {
      calls.push(method);
      if (method === "answerCallbackQuery") return { ok: true, result: true } as any;
      if (method === "editMessageText") {
        return { ok: false, error_code: 400, description: "Bad Request: message is not modified" } as any;
      }
      return { ok: true, result: true } as any;
    });

    await expect(bot.handleUpdate(callbackUpdate(1, "menu:main", { chatId: 77, userId: 1 }))).resolves.toBeUndefined();
    expect(calls).toContain("answerCallbackQuery");
    expect(calls).toContain("editMessageText");
  });

  it("keeps an expired callback acknowledgement from aborting the update", async () => {
    const bot = await buildBot("123456:TEST");
    bot.botInfo = botInfo;
    bot.api.config.use(async (_prev, method) => {
      if (method === "answerCallbackQuery") {
        return { ok: false, error_code: 400, description: "Bad Request: query is too old and response timeout expired or query ID is invalid" } as any;
      }
      return { ok: true, result: true } as any;
    });

    await expect(bot.handleUpdate(callbackUpdate(2, "verification:confirm", { chatId: 78, userId: 1 }))).resolves.toBeUndefined();
  });
});
