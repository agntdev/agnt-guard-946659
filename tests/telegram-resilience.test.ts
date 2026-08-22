import { describe, expect, it } from "vitest";
import { buildBot } from "../src/bot.js";
import { callbackUpdate } from "../src/toolkit/harness/updates.js";
import { getChat } from "../src/store.js";

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
  it("keeps /start responsive when Telegram denies the bot send permission", async () => {
    const bot = await buildBot("123456:TEST");
    bot.botInfo = botInfo;
    bot.api.config.use(async (_prev, method) => {
      if (method === "sendMessage") {
        return {
          ok: false,
          error_code: 400,
          description: "Bad Request: not enough rights to send messages to the chat",
        } as any;
      }
      return { ok: true, result: true } as any;
    });

    await expect(bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 76, type: "private", first_name: "User" },
        from: { id: 1, is_bot: false, first_name: "User" },
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    } as any)).resolves.toBeUndefined();
  });

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

  it("does not run a redelivered callback twice", async () => {
    const bot = await buildBot("123456:TEST");
    bot.botInfo = botInfo;
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "getChatMember") {
        const request = payload as { user_id: number };
        return { ok: true, result: request.user_id === botInfo.id
          ? { status: "administrator", user: botInfo, can_manage_chat: true }
          : { status: "administrator", user: { id: request.user_id, is_bot: false, first_name: "Admin" }, can_restrict_members: true } } as any;
      }
      return { ok: true, result: true } as any;
    });

    const update = callbackUpdate(55, "admin:commands-panel", { chatId: 79, userId: 1 });
    await bot.handleUpdate(update);
    await bot.handleUpdate(update);

    const data = await getChat(79);
    expect(data.callbackIds).toEqual(["55"]);
  });
});
