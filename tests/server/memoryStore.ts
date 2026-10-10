import type { ExtPayUser } from '../../server/supabase/functions/_shared/plan.ts';
import {
  RUN_LIMIT_REACHED,
  SYNC_CONFLICT,
  SYNC_TOO_LARGE,
  type Backup,
  type BackupInfo,
  type Store,
  type UsageKind,
} from '../../server/supabase/functions/tabfold/app.ts';

/**
 * An in-memory Store for the server tests and the end-to-end Pro test (e2e/pro.mjs), with no
 * test-runner imports so plain Node can load it.
 */

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (text: string) => new TextEncoder().encode(text).length;

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
