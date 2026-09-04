import { afterEach, describe, expect, it } from "vitest";
import type { StorageAdapter } from "grammy";
import { getChat, putChat, useStoreStorage, type ChatData } from "../src/store.js";

class SharedStorage implements StorageAdapter<ChatData | { chatIds: string[] }> {
  static readonly values = new Map<string, ChatData | { chatIds: string[] }>();

  read(key: string) {
    return Promise.resolve(SharedStorage.values.get(key));
  }

  write(key: string, value: ChatData | { chatIds: string[] }) {
    SharedStorage.values.set(key, structuredClone(value));
    return Promise.resolve();
  }

  delete(key: string) {
    SharedStorage.values.delete(key);
    return Promise.resolve();
  }
}

describe("durable domain storage", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    SharedStorage.values.clear();
  });

  it("uses the runtime adapter for moderation records", async () => {
    restore = useStoreStorage(new SharedStorage());
    const first = await getChat(1234);
    first.config.welcomeText = "Configured welcome";
    await putChat(1234, first);

    const second = await getChat(1234);
    expect(second.config.welcomeText).toBe("Configured welcome");
    expect(SharedStorage.values.has("gg:chat:1234")).toBe(true);
  });
});
