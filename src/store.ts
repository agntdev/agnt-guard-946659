// Durable per-chat storage for GroupGuard. Backed by the toolkit's persistent
// storage adapter (Redis in production, in-memory under the test harness) —
// never a process-level Map used as a database. One record per chat, addressed
// directly by chat id (no keyspace scans); each record carries explicit index
// arrays (memberIds, infractionIds, auditIds) so collections are read through
// those indices, never enumerated.

import type { StorageAdapter } from "grammy";
import { resolveSessionStorage } from "./toolkit/session/redis.js";
import { now } from "./clock.js";

export type Action =
  | "warn"
  | "mute"
  | "kick"
  | "ban"
  | "trust"
  | "verify"
  | "join"
  | "spam"
  | "config"
  | "config_denied"
  | "owner_change";

export interface MemberRecord {
  userId: number;
  firstName: string;
  /** Last observed username; Telegram users may change it later. */
  username?: string;
  joinTime: number;
  trusted: boolean;
  admin: boolean;
  infractions: number;
  /** Manual warnings are independent of automatic moderation infractions. */
  warningCount: number;
}

export interface InfractionRecord {
  id: string;
  actor: number; // user id of the admin who acted (0 = system)
  target: number; // user id acted upon
  action: Action;
  reason: string;
  warningCount?: number;
  timestamp: number;
}

export interface ChatConfig {
  welcomeText: string;
  rules: string;
  spamThreshold: number; // spam hits before escalation beyond a plain warn
  enabledActions: { warn: boolean; mute: boolean; kick: boolean; ban: boolean };
  notifyTarget: number | null; // chat id to receive summary reports
  /** Internal GroupGuard owner for this group. This is not Telegram token ownership. */
  botOwnerId: number | null;
}

export interface ChatData {
  seq: number;
  config: ChatConfig;
  memberIds: number[];
  members: Record<number, MemberRecord>;
  /** Explicit bot-managed moderators. Telegram administrators are discovered
   * separately and must never overwrite this opt-in role list. */
  moderatorIds: number[];
  /** Observed Telegram administrators, used for spam exemptions and display. */
  adminIds: number[];
  trustedIds: number[];
  pending: Record<number, { timestamp: number; expiry: number; status: "pending" | "verified" | "expired" }>;
  infractionIds: string[];
  infractions: Record<string, InfractionRecord>;
  auditIds: string[]; // newest first; capped at 200
  audit: Record<string, InfractionRecord>;
  /** Recently claimed Telegram callback ids. Telegram can redeliver a callback
   * when its acknowledgement or the accompanying message edit failed. Keeping
   * this bounded, durable list makes state-changing button actions idempotent
   * across those retries without any keyspace scan. */
  callbackIds: string[];
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
    botOwnerId: null,
  };
}

export function blankChat(): ChatData {
  return {
    seq: 0,
    config: defaultConfig(),
    memberIds: [],
    members: {},
    moderatorIds: [],
    adminIds: [],
    trustedIds: [],
    pending: {},
    infractionIds: [],
    infractions: {},
    auditIds: [],
    audit: {},
    callbackIds: [],
  };
}

const KEY = (chatId: number | string) => `gg:chat:${chatId}`;
const CHAT_INDEX_KEY = "gg:chat-index";

interface ChatIndex {
  chatIds: string[];
}

// One adapter for the whole bot (auto-selects Redis when REDIS_URL is set, else
// in-memory — the toolkit's persistent storage, not a hand-rolled Map). Each
// chat is its own record addressed directly by chat id — no keyspace scans, and
// each record carries explicit index arrays (memberIds, infractionIds, auditIds)
// so collections are read through those indices.
const adapter: StorageAdapter<ChatData | ChatIndex> = resolveSessionStorage<ChatData | ChatIndex>(undefined);

/** Keep a direct, bounded list of chat records. This is an explicit index, not
 * a keyspace scan, and lets an authorized privacy reset reach every record the
 * bot has created. */
async function trackChat(chatId: number | string): Promise<void> {
  const id = String(chatId);
  const existing = await Promise.resolve(adapter.read(CHAT_INDEX_KEY)) as ChatIndex | undefined;
  const index = existing && Array.isArray(existing.chatIds) ? existing : { chatIds: [] };
  if (index.chatIds.includes(id)) return;
  index.chatIds.push(id);
  await adapter.write(CHAT_INDEX_KEY, index);
}

/**
 * Records created before dedicated warning counts used `infractions` for the
 * value shown by /warnings. Preserve that visible count once, then all future
 * warning mutations use the separate field and no longer include mutes/kicks.
 */
function migrateWarningCounts(data: ChatData): boolean {
  let changed = false;
  // Older records predate explicit internal moderators. Keep their Telegram
  // admin cache intact, but do not reinterpret it as a manually delegated role.
  if (!Array.isArray(data.moderatorIds)) {
    data.moderatorIds = [];
    changed = true;
  }
  // Records created before internal ownership was introduced have no owner
  // field. Do not infer one from the first user who speaks or from a Telegram
  // admin: it is set only by BOT_OWNER_ID or an authorized transfer.
  if (!Number.isSafeInteger(data.config.botOwnerId)) {
    data.config.botOwnerId = null;
    changed = true;
  }
  if (!Array.isArray(data.callbackIds)) {
    data.callbackIds = [];
    changed = true;
  }
  for (const id of data.memberIds) {
    const member = data.members[id];
    if (member && !Number.isInteger(member.warningCount)) {
      member.warningCount = Math.min(3, Math.max(0, member.infractions ?? 0));
      changed = true;
    }
  }
  return changed;
}

/** Read a chat's record (creating + persisting a blank one if absent). */
export async function getChat(chatId: number | string): Promise<ChatData> {
  await trackChat(chatId);
  const v = await Promise.resolve(adapter.read(KEY(chatId))) as ChatData | undefined;
  if (!v) {
    const fresh = blankChat();
    await adapter.write(KEY(chatId), fresh);
    return fresh;
  }
  if (migrateWarningCounts(v)) await adapter.write(KEY(chatId), v);
  return v;
}

/** Persist a (possibly mutated) chat record. */
export async function putChat(chatId: number | string, data: ChatData): Promise<void> {
  await adapter.write(KEY(chatId), data);
}

/**
 * Remove every item of user-generated moderation activity while retaining the
 * group's operating configuration. Records are single per-chat documents, so
 * overwriting these fields also removes the stored verification responses,
 * member metadata, counters, action records, logs, and callback cache.
 *
 * This deliberately walks only the explicit chat index. It never scans the
 * backing store, which would be unsafe on a production Redis deployment.
 */
export async function purgeActivityAcrossChats(): Promise<number> {
  const existing = await Promise.resolve(adapter.read(CHAT_INDEX_KEY)) as ChatIndex | undefined;
  const chatIds = existing?.chatIds ?? [];
  let cleared = 0;
  for (const chatId of chatIds) {
    const stored = await Promise.resolve(adapter.read(KEY(chatId))) as ChatData | undefined;
    if (!stored) continue;
    stored.seq = 0;
    stored.memberIds = [];
    stored.members = {};
    stored.trustedIds = [];
    stored.pending = {};
    stored.infractionIds = [];
    stored.infractions = {};
    stored.auditIds = [];
    stored.audit = {};
    stored.callbackIds = [];
    // moderatorIds/adminIds and config are operating settings, not activity.
    await adapter.write(KEY(chatId), stored);
    cleared += 1;
  }
  return cleared;
}

/**
 * Claim a callback before its handler runs. Returns false for a previously
 * processed callback, which is Telegram retry delivery rather than a new user
 * action. The list follows the same 200-record privacy bound as the audit log.
 */
export async function claimCallback(chatId: number | string, callbackId: string): Promise<boolean> {
  const data = await getChat(chatId);
  if (data.callbackIds.includes(callbackId)) return false;
  data.callbackIds.unshift(callbackId);
  if (data.callbackIds.length > AUDIT_CAP) data.callbackIds.length = AUDIT_CAP;
  await putChat(chatId, data);
  return true;
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
    ...(entry.warningCount === undefined ? {} : { warningCount: entry.warningCount }),
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
  return data.adminIds.includes(userId) || data.moderatorIds.includes(userId) || data.members[userId]?.admin === true;
}

/** Grant or revoke the bot's explicit moderator role for this group. */
export function setModerator(data: ChatData, userId: number, moderator: boolean): void {
  upsertMember(data, userId, "", { admin: moderator });
  data.moderatorIds = data.moderatorIds.filter((id) => id !== userId);
  if (moderator) data.moderatorIds.push(userId);
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
      warningCount: 0,
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
