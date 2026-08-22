import { afterEach, describe, expect, it } from "vitest";
import { buildBot } from "../src/bot";
import { getChat, putChat, setModerator, upsertMember } from "../src/store";
import { callbackUpdate } from "../src/toolkit/harness/updates";

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
        result: {
          status: userStatus,
          user: { id: userId, is_bot: false, first_name: "Moderator" },
          ...(userStatus === "administrator" ? { can_restrict_members: true } : {}),
        },
      } as any;
    }
    return { ok: true, result: true } as any;
  });
  await instance.handleUpdate(commandUpdate(chatId, 9, chatType, command));
  return calls;
}

describe("moderator authorization", () => {
  const originalOwner = process.env.OWNER_TELEGRAM_ID;
  const originalBotOwner = process.env.BOT_OWNER_ID;

  afterEach(() => {
    if (originalOwner === undefined) delete process.env.OWNER_TELEGRAM_ID;
    else process.env.OWNER_TELEGRAM_ID = originalOwner;
    if (originalBotOwner === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = originalBotOwner;
  });

  it("denies a regular member with a useful explanation", async () => {
    const calls = await runMod(801, "member", { status: "administrator", can_manage_chat: true });
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("You must be the bot owner, a chat admin with Promote/Restrict rights, or a designated moderator to manage moderators. If you are an admin, ensure the bot is also an admin with Promote/Restrict rights.");
  });

  it("allows an administrator and a creator", async () => {
    for (const [chatId, status] of [[802, "administrator"], [803, "creator"]] as const) {
      const calls = await runMod(chatId, status, { status: "administrator", can_manage_chat: true });
      expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
        .toBe("Moderation panel. Pick an action, then choose a member to apply it to.");
    }
  });

  it("does not require bot moderation rights to open internal moderator management", async () => {
    const calls = await runMod(804, "administrator", { status: "administrator", can_manage_chat: false });
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("Moderation panel. Pick an action, then choose a member to apply it to.");
  });

  it("names the restrict-members right for a mute", async () => {
    const calls = await runMod(807, "administrator", { status: "administrator", can_manage_chat: true }, "supergroup", "/mute");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("I must be an administrator with restrict members to perform this action.");
  });

  it("rejects private-chat members while allowing a limited administrator to open the panel", async () => {
    const privateCalls = await runMod(805, "member", { status: "administrator", can_manage_chat: true }, "private");
    expect(privateCalls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("You must be the bot owner, a chat admin with Promote/Restrict rights, or a designated moderator to manage moderators. If you are an admin, ensure the bot is also an admin with Promote/Restrict rights.");

    const limitedCalls = await runMod(806, "administrator", { status: "administrator", can_manage_chat: true });
    expect(limitedCalls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("Moderation panel. Pick an action, then choose a member to apply it to.");
  });

  it("lets a bot-designated moderator manage the moderator list", async () => {
    const chatId = 808;
    const data = await getChat(chatId);
    upsertMember(data, 9, "Moderator");
    setModerator(data, 9, true);
    await putChat(chatId, data);
    const calls = await runMod(chatId, "member", { status: "administrator", can_manage_chat: true });
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("Moderation panel. Pick an action, then choose a member to apply it to.");
  });

  it("lets the configured owner manage moderators without being a group administrator", async () => {
    const chatId = 809;
    const data = await getChat(chatId);
    upsertMember(data, 12, "New moderator");
    await putChat(chatId, data);
    process.env.BOT_OWNER_ID = "9";

    const instance = await buildBot("123456:TEST");
    instance.botInfo = botInfo;
    instance.api.config.use(async (_prev, method, payload) => {
      const request = (payload ?? {}) as Record<string, unknown>;
      if (method === "getChatMember") {
        const userId = request.user_id as number;
        return {
          ok: true,
          result: userId === botInfo.id
            ? { status: "administrator", user: botInfo, can_manage_chat: true, can_restrict_members: true }
            : { status: "member", user: { id: userId, is_bot: false, first_name: "Member" } },
        } as any;
      }
      return { ok: true, result: true } as any;
    });
    await instance.handleUpdate(callbackUpdate(1, "moderator:add:12", { chatId, userId: 9 }));

    const saved = await getChat(chatId);
    expect(saved.moderatorIds).toContain(12);
    expect(saved.members[12]?.admin).toBe(true);

    await instance.handleUpdate(callbackUpdate(2, "moderator:remove:12", { chatId, userId: 9 }));
    const removed = await getChat(chatId);
    expect(removed.moderatorIds).not.toContain(12);
  });

  it("lets a group administrator manage moderators", async () => {
    const chatId = 810;
    const data = await getChat(chatId);
    upsertMember(data, 12, "New moderator");
    await putChat(chatId, data);

    const instance = await buildBot("123456:TEST");
    instance.botInfo = botInfo;
    instance.api.config.use(async (_prev, method, payload) => {
      const request = (payload ?? {}) as Record<string, unknown>;
      if (method === "getChatMember") {
        const userId = request.user_id as number;
        return { ok: true, result: userId === botInfo.id
          ? { status: "administrator", user: botInfo, can_manage_chat: true, can_restrict_members: true }
          : { status: "administrator", user: { id: userId, is_bot: false, first_name: "Admin" }, can_promote_members: true } } as any;
      }
      return { ok: true, result: true } as any;
    });
    await instance.handleUpdate(callbackUpdate(1, "moderator:add:12", { chatId, userId: 10 }));
    expect((await getChat(chatId)).moderatorIds).toContain(12);
  });

  it("denies a non-owner, non-administrator from a moderator callback", async () => {
    const chatId = 811;
    const data = await getChat(chatId);
    upsertMember(data, 12, "New moderator");
    await putChat(chatId, data);
    const instance = await buildBot("123456:TEST");
    instance.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    instance.api.config.use(async (_prev, method, payload) => {
      const request = (payload ?? {}) as Record<string, unknown>;
      calls.push({ method, payload: request });
      if (method === "getChatMember") {
        const userId = request.user_id as number;
        return { ok: true, result: { status: userId === botInfo.id ? "administrator" : "member", user: userId === botInfo.id ? botInfo : { id: userId, is_bot: false, first_name: "Member" }, can_manage_chat: true } } as any;
      }
      return { ok: true, result: true } as any;
    });
    await instance.handleUpdate(callbackUpdate(1, "moderator:add:12", { chatId, userId: 11 }));
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("You must be the bot owner, a chat admin with Promote/Restrict rights, or a designated moderator to manage moderators. If you are an admin, ensure the bot is also an admin with Promote/Restrict rights.");
    expect((await getChat(chatId)).moderatorIds).not.toContain(12);
  });

  it("denies an administrator without promote or restrict rights", async () => {
    const chatId = 812;
    const instance = await buildBot("123456:TEST");
    instance.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    instance.api.config.use(async (_prev, method, payload) => {
      const request = (payload ?? {}) as Record<string, unknown>;
      calls.push({ method, payload: request });
      if (method === "getChatMember") {
        const userId = request.user_id as number;
        return { ok: true, result: userId === botInfo.id
          ? { status: "administrator", user: botInfo, can_restrict_members: true }
          : { status: "administrator", user: { id: userId, is_bot: false, first_name: "Limited admin" } } } as any;
      }
      return { ok: true, result: true } as any;
    });
    await instance.handleUpdate(commandUpdate(chatId, 13));
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("You must be the bot owner, a chat admin with Promote/Restrict rights, or a designated moderator to manage moderators. If you are an admin, ensure the bot is also an admin with Promote/Restrict rights.");
  });

  it("does not change moderators when the bot lacks promote and restrict rights", async () => {
    const chatId = 813;
    const data = await getChat(chatId);
    upsertMember(data, 12, "New moderator");
    await putChat(chatId, data);
    const instance = await buildBot("123456:TEST");
    instance.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    instance.api.config.use(async (_prev, method, payload) => {
      const request = (payload ?? {}) as Record<string, unknown>;
      calls.push({ method, payload: request });
      if (method === "getChatMember") {
        const userId = request.user_id as number;
        return { ok: true, result: userId === botInfo.id
          ? { status: "administrator", user: botInfo }
          : { status: "administrator", user: { id: userId, is_bot: false, first_name: "Admin" }, can_promote_members: true } } as any;
      }
      return { ok: true, result: true } as any;
    });
    await instance.handleUpdate(callbackUpdate(1, "moderator:add:12", { chatId, userId: 10 }));
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text)
      .toBe("Bot must be an admin with Promote/Restrict members permission to change moderators.");
    expect((await getChat(chatId)).moderatorIds).not.toContain(12);
  });
});
