import { afterEach, describe, expect, it } from "vitest";
import { buildBot } from "../src/bot";
import { getChat, putChat, upsertMember } from "../src/store";
import { callbackUpdate, textUpdate } from "../src/toolkit/harness/updates";

const botInfo = {
  id: 42, is_bot: true, first_name: "TestBot", username: "test_bot",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
} as const;

async function botWithApi() {
  const bot = await buildBot("123456:TEST");
  bot.botInfo = botInfo;
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    const request = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: request });
    if (method === "getChat") {
      return { ok: true, result: { id: request.chat_id, type: "private", first_name: "Owner" } } as any;
    }
    if (method === "getChatMember") {
      const userId = request.user_id as number;
      return { ok: true, result: userId === botInfo.id
        ? { status: "member", user: botInfo }
        : { status: "member", user: { id: userId, is_bot: false, first_name: "Member" } } } as any;
    }
    return { ok: true, result: true } as any;
  });
  return { bot, calls };
}

describe("bot owner workflow", () => {
  const priorBotOwner = process.env.BOT_OWNER_ID;
  const priorOperator = process.env.OWNER_TELEGRAM_ID;
  afterEach(() => {
    if (priorBotOwner === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = priorBotOwner;
    if (priorOperator === undefined) delete process.env.OWNER_TELEGRAM_ID;
    else process.env.OWNER_TELEGRAM_ID = priorOperator;
  });

  it("seeds and persists the owner from BOT_OWNER_ID", async () => {
    const chatId = 1910;
    process.env.BOT_OWNER_ID = "10";
    const { bot } = await botWithApi();
    await bot.handleUpdate(callbackUpdate(1, "config:panel", { chatId, userId: 10 }));
    const data = await getChat(chatId);
    expect(data.config.botOwnerId).toBe(10);
    expect(data.auditIds.map((id) => data.audit[id]?.action)).toContain("owner_change");
  });

  it("lets the owner transfer ownership after validating the Telegram user", async () => {
    const chatId = 1911;
    const data = await getChat(chatId);
    data.config.botOwnerId = 10;
    await putChat(chatId, data);
    const { bot, calls } = await botWithApi();
    await bot.handleUpdate(textUpdate(1, "/set_owner 22", { chatId, userId: 10 }));
    const saved = await getChat(chatId);
    expect(calls.some((call) => call.method === "getChat" && call.payload.chat_id === 22)).toBe(true);
    expect(saved.config.botOwnerId).toBe(22);
    expect(saved.auditIds.map((id) => saved.audit[id]?.action)).toContain("owner_change");
  });

  it("lets the bot owner manage moderators without Telegram admin rights", async () => {
    const chatId = 1912;
    const data = await getChat(chatId);
    data.config.botOwnerId = 10;
    upsertMember(data, 22, "New moderator");
    await putChat(chatId, data);
    const { bot } = await botWithApi();
    await bot.handleUpdate(textUpdate(1, "/mod", { chatId, userId: 10 }));
    await bot.handleUpdate(callbackUpdate(2, "moderator:add:22", { chatId, userId: 10 }));
    expect((await getChat(chatId)).moderatorIds).toContain(22);
  });
});
