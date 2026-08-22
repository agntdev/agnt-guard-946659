import { describe, expect, it } from "vitest";
import { buildBot } from "../src/bot";

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

function commandUpdate(
  chatId: number,
  userId: number,
  chatType: "private" | "supergroup" = "supergroup",
  command = "/mod",
) {
  return {
    update_id: chatId,
    message: {
      message_id: chatId,
      date: 0,
      chat: chatType === "private"
        ? { id: chatId, type: "private" as const, first_name: "Permissions" }
        : { id: chatId, type: "supergroup" as const, title: "Permissions" },
      from: { id: userId, is_bot: false, first_name: "Moderator" },
      text: command,
      entities: [{ type: "bot_command" as const, offset: 0, length: command.length }],
    },
  };
}

async function runMod(
  chatId: number,
  userStatus: "member" | "administrator" | "creator",
  bot: { status: "member" | "administrator"; can_manage_chat?: boolean; can_restrict_members?: boolean },
  chatType: "private" | "supergroup" = "supergroup",
  command = "/mod",
) {
  const instance = await buildBot("123456:TEST");
  instance.botInfo = botInfo;
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  instance.api.config.use(async (_prev, method, payload) => {
    const request = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: request });
    if (method === "getChatMember") {
      const userId = request.user_id as number;
      if (userId === botInfo.id) {
        return { ok: true, result: { status: bot.status, user: botInfo, ...bot } } as any;
      }
      return {
        ok: true,
        result: { status: userStatus, user: { id: userId, is_bot: false, first_name: "Moderator" } },
      } as any;
    }
    return { ok: true, result: true } as any;
  });
  await instance.handleUpdate(commandUpdate(chatId, 9, chatType, command));
  return calls;
}

describe("moderator authorization", () => {
  it("tells a non-admin exactly what they need", async () => {
    const calls = await runMod(801, "member", { status: "administrator", can_manage_chat: true });
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("You must be a group administrator to manage moderators.");
  });

  it("allows an administrator and a creator", async () => {
    for (const [chatId, status] of [[802, "administrator"], [803, "creator"]] as const) {
      const calls = await runMod(chatId, status, { status: "administrator", can_manage_chat: true });
      expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
        .toBe("Moderation panel. Pick an action, then choose a member to apply it to.");
    }
  });

  it("explains the bot right that is missing", async () => {
    const calls = await runMod(804, "administrator", { status: "administrator", can_manage_chat: false });
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("I must be an administrator with manage chat to perform this action.");
  });

  it("names the restrict-members right for a mute", async () => {
    const calls = await runMod(807, "administrator", { status: "administrator", can_manage_chat: true }, "supergroup", "/mute");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("I must be an administrator with restrict members to perform this action.");
  });

  it("rejects private-chat members while allowing a limited administrator to open the panel", async () => {
    const privateCalls = await runMod(805, "member", { status: "administrator", can_manage_chat: true }, "private");
    expect(privateCalls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("You must be a group administrator to manage moderators.");

    const limitedCalls = await runMod(806, "administrator", { status: "administrator", can_manage_chat: true });
    expect(limitedCalls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("Moderation panel. Pick an action, then choose a member to apply it to.");
  });
});
