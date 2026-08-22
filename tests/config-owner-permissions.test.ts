import { afterEach, describe, expect, it } from "vitest";
import { buildBot } from "../src/bot";
import { getChat, putChat } from "../src/store";
import { callbackUpdate, textUpdate } from "../src/toolkit/harness/updates";

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

async function botWithCalls() {
  const bot = await buildBot("123456:TEST");
  bot.botInfo = botInfo;
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: (payload ?? {}) as Record<string, unknown> });
    if (method === "getChatMember") {
      return { ok: true, result: { status: "administrator", user: botInfo, can_manage_chat: true } } as any;
    }
    if (method === "editMessageText" || method === "sendMessage") {
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } } as any;
    }
    return { ok: true, result: true } as any;
  });
  return { bot, calls };
}

describe("configuration ownership", () => {
  const originalOwner = process.env.OWNER_TELEGRAM_ID;

  afterEach(() => {
    if (originalOwner === undefined) delete process.env.OWNER_TELEGRAM_ID;
    else process.env.OWNER_TELEGRAM_ID = originalOwner;
  });

  it("lets the configured global owner edit settings and records the change", async () => {
    const chatId = 1201;
    const data = await getChat(chatId);
    await putChat(chatId, data);
    process.env.OWNER_TELEGRAM_ID = "10";
    const { bot, calls } = await botWithCalls();

    await bot.handleUpdate(callbackUpdate(1, "config:edit:welcome", { chatId, userId: 10 }));
    await bot.handleUpdate(textUpdate(2, "Welcome aboard.", { chatId, userId: 10 }));

    expect(calls.some((call) => call.method === "sendMessage" && call.payload.text === "✅ Saved. New welcome text:\n\nWelcome aboard.")).toBe(true);
    const saved = await getChat(chatId);
    expect(saved.config.welcomeText).toBe("Welcome aboard.");
    expect(saved.auditIds.map((id) => saved.audit[id]?.action)).toContain("config");
  });

  it("denies non-owners and logs the denied configuration attempt", async () => {
    const chatId = 1202;
    const data = await getChat(chatId);
    await putChat(chatId, data);
    process.env.OWNER_TELEGRAM_ID = "10";
    const { bot, calls } = await botWithCalls();

    await bot.handleUpdate(callbackUpdate(1, "config:panel", { chatId, userId: 11 }));

    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toBe("Only the bot owner may edit bot settings.");
    const saved = await getChat(chatId);
    expect(saved.auditIds.map((id) => saved.audit[id]?.action)).toContain("config_denied");
  });
});
