// Durable per-chat storage for GroupGuard. Backed by the toolkit's persistent
// storage adapter (Redis in production, in-memory under the test harness) —
// never a process-level Map used as a database. One record per chat, addressed
// directly by chat id (no keyspace scans); each record carries explicit index
// arrays (memberIds, infractionIds, auditIds) so collections are read through
// those indices, never enumerated.

import type { StorageAdapter } from "grammy";
import { resolveSessionStorage } from "./toolkit/session/redis.js";
import { now } from "./clock.js";

export type Action = "warn" | "mute" | "kick" | "ban" | "trust" | "verify" | "join" | "spam";

export interface MemberRecord {
  userId: number;
  firstName: string;
  joinTime: number;
  trusted: boolean;
  admin: boolean;
  infractions: number;
}

export interface InfractionRecord {
  id: string;
  actor: number; // user id of the admin who acted (0 = system)
  target: number; // user id acted upon
  action: Action;
  reason: string;
  timestamp: number;
}

export interface ChatConfig {
  welcomeText: string;
  rules: string;
  spamThreshold: number; // spam hits before escalation beyond a plain warn
  enabledActions: { warn: boolean; mute: boolean; kick: boolean; ban: boolean };
  notifyTarget: number | null; // chat id to receive summary reports
}

export interface ChatData {
  seq: number;
  config: ChatConfig;
  memberIds: number[];
  members: Record<number, MemberRecord>;
  adminIds: number[];
  trustedIds: number[];
  pending: Record<number, { timestamp: number; expiry: number; status: "pending" | "verified" | "expired" }>;
  infractionIds: string[];
  infractions: Record<string, InfractionRecord>;
  auditIds: string[]; // newest first; capped at 200
  audit: Record<string, InfractionRecord>;
}

/** Join verification window: new members must tap "I'm human" within this time. */
export const VERIFICATION_WINDOW_MS = 120_000;
/** Human-readable form of VERIFICATION_WINDOW_MS for user-facing copy and audit logs. */
export const VERIFICATION_WINDOW_LABEL = "2 minutes";
export const AUDIT_CAP = 200;
export const DEFAULT_MUTE_SECONDS = 3600;

const DEFAULT_RULES =
  "1. Be respectful.\n2. No spam or unsolicited links.\n3. No harassment.\n4. Keep it on-topic.";

export function defaultConfig(): ChatConfig {
  return {
    welcomeText: "Welcome to the group! Tap the button below to verify you're human.",
    rules: DEFAULT_RULES,
    spamThreshold: 2,
    enabledActions: { warn: true, mute: true, kick: true, ban: true },
    notifyTarget: null,
  };
}

export function blankChat(): ChatData {
  return {
    seq: 0,
    config: defaultConfig(),
    memberIds: [],
    members: {},
    adminIds: [],
    trustedIds: [],
    pending: {},
    infractionIds: [],
    infractions: {},
    auditIds: [],
    audit: {},
  };
}

const KEY = (chatId: number | string) => `gg:chat:${chatId}`;

// One adapter for the whole bot (auto-selects Redis when REDIS_URL is set, else
// in-memory — the toolkit's persistent storage, not a hand-rolled Map). Each
// chat is its own record addressed directly by chat id — no keyspace scans, and
// each record carries explicit index arrays (memberIds, infractionIds, auditIds)
// so collections are read through those indices.
const adapter: StorageAdapter<ChatData> = resolveSessionStorage<ChatData>(undefined);

/** Read a chat's record (creating + persisting a blank one if absent). */
export async function getChat(chatId: number | string): Promise<ChatData> {
  const v = await Promise.resolve(adapter.read(KEY(chatId)));
  if (!v) {
    const fresh = blankChat();
    await adapter.write(KEY(chatId), fresh);
    return fresh;
  }
  return v;
}

/** Persist a (possibly mutated) chat record. */
export async function putChat(chatId: number | string, data: ChatData): Promise<void> {
  await adapter.write(KEY(chatId), data);
}

function nextId(data: ChatData, chatId: number | string): string {
  data.seq += 1;
  return `${chatId}-${data.seq}`;
}

/** Record an infraction + audit entry (audit capped at AUDIT_CAP, oldest dropped). */
export function logAction(
  data: ChatData,
  chatId: number | string,
  entry: Omit<InfractionRecord, "id" | "timestamp"> & { timestamp?: number },
): InfractionRecord {
  const id = nextId(data, chatId);
  const rec: InfractionRecord = {
    id,
    actor: entry.actor,
    target: entry.target,
    action: entry.action,
    reason: entry.reason,
    timestamp: entry.timestamp ?? now(),
  };
  data.infractionIds.push(id);
  data.infractions[id] = rec;
  data.auditIds.unshift(id);
  while (data.auditIds.length > AUDIT_CAP) {
    const dropped = data.auditIds.pop()!;
    delete data.audit[dropped];
  }
  data.audit[id] = rec;
  return rec;
}

export function isAdmin(data: ChatData, userId: number): boolean {
  return data.adminIds.includes(userId);
}

/** First caller to run /mod in a chat becomes its admin (the owner who added the
 *  bot). Subsequent admins are synced from Telegram when reachable. */
export async function ensureAdmin(chatId: number | string, userId: number): Promise<boolean> {
  const data = await getChat(chatId);
  if (data.adminIds.includes(userId)) return true;
  if (data.adminIds.length === 0) {
    data.adminIds.push(userId);
    const m = data.members[userId];
    if (m) m.admin = true;
    await putChat(chatId, data);
    return true;
  }
  return false;
}

/** Mark a member record (creating a minimal one if absent). */
export function upsertMember(
  data: ChatData,
  userId: number,
  firstName: string,
  patch: Partial<MemberRecord> = {},
): MemberRecord {
  let m = data.members[userId];
  if (!m) {
    m = {
      userId,
      firstName,
      joinTime: now(),
      trusted: false,
      admin: false,
      infractions: 0,
    };
    if (!data.memberIds.includes(userId)) data.memberIds.push(userId);
    data.members[userId] = m;
  }
  if (firstName && !m.firstName) m.firstName = firstName;
  Object.assign(m, patch);
  return m;
}

export function setTrusted(data: ChatData, userId: number, trusted: boolean): void {
  upsertMember(data, userId, "", { trusted });
  data.trustedIds = data.trustedIds.filter((id) => id !== userId);
  if (trusted) data.trustedIds.push(userId);
}
