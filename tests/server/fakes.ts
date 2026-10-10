import { vi } from 'vitest';
import type { ExtPayUser } from '../../server/supabase/functions/_shared/plan.ts';
import { createModel, type CallJson } from '../../server/supabase/functions/tabfold/ai.ts';
import {
  handle,
  RUN_LIMIT_REACHED,
  SYNC_CONFLICT,
  SYNC_TOO_LARGE,
  type Backup,
  type BackupInfo,
  type Deps,
  type Store,
  type UsageKind,
} from '../../server/supabase/functions/tabfold/app.ts';

/** Fakes for the server tests: an in-memory Store that behaves like the SQL, ExtensionPay and the model. */

export const DAY = 24 * 60 * 60 * 1000;
export const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
export const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const iso = (ms: number) => new Date(ms).toISOString();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (text: string) => new TextEncoder().encode(text).length;

export const USERS = {
  free: { paid: false, email: 'free@example.com', installedAt: iso(NOW - 40 * DAY) },
  proMonthly: {
    paid: true,
    paidAt: iso(NOW - 10 * DAY),
    email: 'Pro@Example.com',
    plan: { unitAmountCents: 500, currency: 'usd', nickname: 'pro-monthly', interval: 'month', intervalCount: 1 },
    subscriptionStatus: 'active',
  },
  proYearly: {
    paid: true,
    email: 'yearly@example.com',
    plan: { unitAmountCents: 4800, currency: 'usd', nickname: 'pro-yearly', interval: 'year', intervalCount: 1 },
    subscriptionStatus: 'active',
  },
  proAiMonthly: {
    paid: true,
    email: 'ai@example.com',
    plan: { unitAmountCents: 900, currency: 'usd', nickname: 'pro-ai-monthly', interval: 'month', intervalCount: 1 },
    subscriptionStatus: 'active',
  },
  proAiYearly: {
    paid: true,
    email: 'ai-yearly@example.com',
    plan: { unitAmountCents: 8400, currency: 'usd', nickname: 'pro-ai-yearly', interval: 'year', intervalCount: 1 },
    subscriptionStatus: 'active',
    subscriptionCancelAt: iso(NOW + 100 * DAY),
  },
  trialRunning: { paid: false, email: 'trial@example.com', trialStartedAt: iso(NOW - 2 * DAY) },
  trialEnded: { paid: false, email: 'ended@example.com', trialStartedAt: iso(NOW - 8 * DAY) },
  proDuringTrial: {
    paid: true,
    email: 'both@example.com',
    trialStartedAt: iso(NOW - 1 * DAY),
    plan: { nickname: 'pro-monthly', interval: 'month' },
    subscriptionStatus: 'active',
  },
  cancelled: {
    paid: true,
    email: 'gone@example.com',
    plan: { nickname: 'pro-monthly', interval: 'month' },
    subscriptionStatus: 'canceled',
  },
  pastDue: {
    paid: true,
    email: 'late@example.com',
    plan: { nickname: 'pro-ai-monthly', interval: 'month' },
    subscriptionStatus: 'past_due',
  },
  noEmail: {
    paid: true,
    email: null,
    plan: { nickname: 'pro-ai-monthly', interval: 'month' },
    subscriptionStatus: 'active',
  },
} satisfies Record<string, ExtPayUser>;

export type UserName = keyof typeof USERS;

/** The ExtensionPay key each test user's extension sends. */
export const keyOf = (name: UserName) => `key-${name}-0123456789`;

/** Behaves like the SQL in server/supabase/migrations, including tabfold_sync_write and tabfold_take_run. */
export class MemoryStore implements Store {
  accounts = new Map<string, string>();
  sync = new Map<string, { version: number; items: Record<string, unknown> }>();
  backups = new Map<string, Map<string, Backup>>();
  usage = new Map<string, { runs: number; light: number }>();
  cache = new Map<string, { user: ExtPayUser; checkedAt: number }>();

  async accountId(email: string) {
    let id = this.accounts.get(email);
    if (!id) {
      id = `account-${this.accounts.size + 1}`;
      this.accounts.set(email, id);
    }
    return id;
  }

  async syncRead(account: string) {
    const state = this.sync.get(account);
    return { items: copy(state?.items ?? {}), version: state?.version ?? 0 };
  }

  async syncWrite(account: string, baseVersion: number, set: Record<string, unknown>, remove: string[], maxBytes: number) {
    const state = this.sync.get(account) ?? { version: 0, items: {} };
    if (state.version !== baseVersion) return SYNC_CONFLICT;
    const next = { ...state.items };
    for (const key of remove) delete next[key];
    Object.assign(next, copy(set));
    let total = 0;
    for (const [key, value] of Object.entries(next)) total += bytes(key) + bytes(JSON.stringify(value));
    if (total > maxBytes) return SYNC_TOO_LARGE;
    this.sync.set(account, { version: state.version + 1, items: next });
    return state.version + 1;
  }

  async syncVersion(account: string) {
    return this.sync.get(account)?.version ?? 0;
  }

  private backupsOf(account: string) {
    let map = this.backups.get(account);
    if (!map) this.backups.set(account, (map = new Map()));
    return map;
  }

  async backupExists(account: string, day: string) {
    return this.backupsOf(account).has(day);
  }

  async backupPut(account: string, backup: Backup) {
    const map = this.backupsOf(account);
    if (!map.has(backup.day)) map.set(backup.day, copy(backup));
  }

  async backupList(account: string): Promise<BackupInfo[]> {
    return [...this.backupsOf(account).values()]
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .map(({ day, tabCount, createdAt }) => ({ day, tabCount, createdAt }));
  }

  async backupGet(account: string, day: string) {
    const backup = this.backupsOf(account).get(day);
    return backup ? { day, items: copy(backup.items) } : null;
  }

  async backupPrune(account: string, beforeDay: string) {
    const map = this.backupsOf(account);
    for (const day of [...map.keys()]) if (day < beforeDay) map.delete(day);
  }

  async aiUsage(account: string, month: string) {
    return { ...(this.usage.get(`${account}|${month}`) ?? { runs: 0, light: 0 }) };
  }

  async takeRun(account: string, month: string, kind: UsageKind, limit: number) {
    const key = `${account}|${month}`;
    const row = this.usage.get(key) ?? { runs: 0, light: 0 };
    this.usage.set(key, row);
    if (row[kind] >= limit) return RUN_LIMIT_REACHED;
    row[kind] += 1;
    return row[kind];
  }

  async extpayCacheGet(keyHash: string) {
    const entry = this.cache.get(keyHash);
    return entry ? copy(entry) : null;
  }

  async extpayCachePut(keyHash: string, user: ExtPayUser, checkedAt: number) {
    this.cache.set(keyHash, { user: copy(user), checkedAt });
  }

  /** Usage for an email this month (or the month given). */
  async usageOf(email: string, month = '2026-10') {
    return this.aiUsage(await this.accountId(email), month);
  }

  async setUsage(email: string, usage: { runs?: number; light?: number }, month = '2026-10') {
    const account = await this.accountId(email);
    this.usage.set(`${account}|${month}`, { runs: 0, light: 0, ...usage });
  }
}

export interface RequestOptions {
  key?: UserName | string | null;
  body?: unknown;
  rawBody?: string;
  origin?: string;
  headers?: Record<string, string>;
}

export function createServer(options: { allowedOrigins?: string[] } = {}) {
  const store = new MemoryStore();
  const users = new Map<string, ExtPayUser>(Object.entries(USERS).map(([name, user]) => [keyOf(name as UserName), user]));
  const extpayUser = vi.fn(async (key: string) => users.get(key) ?? null);
  const callJson = vi.fn<CallJson>();
  const log = vi.fn<(message: string) => void>();
  const clock = { now: NOW };
  const deps: Deps = {
    store,
    extpayUser,
    model: createModel(callJson),
    now: () => clock.now,
    config: { extpayId: 'tabfold', allowedOrigins: options.allowedOrigins ?? [EXTENSION] },
    log,
  };

  async function request(method: string, path: string, opts: RequestOptions = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    const key = opts.key === undefined ? 'proAiMonthly' : opts.key;
    if (key) headers.authorization = `Bearer ${key in USERS ? keyOf(key as UserName) : key}`;
    if (opts.origin) headers.origin = opts.origin;
    let body: string | undefined = opts.rawBody;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const url = path.startsWith('http') ? path : `https://example.supabase.co/functions/v1/tabfold${path}`;
    const response = await handle(new Request(url, { method, headers, body }), deps);
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? (JSON.parse(text) as any) : null };
  }

  return { store, users, extpayUser, callJson, log, clock, deps, request };
}

export type Server = ReturnType<typeof createServer>;
