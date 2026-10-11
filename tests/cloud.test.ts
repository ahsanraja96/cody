import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabfoldDB } from '@/lib/db';
import { route } from '@/lib/background/router';
import { api, errorFromResponse } from '@/lib/pro/api';
import { cloudSyncStatus, planEnded, planState } from '@/lib/pro/state';
import { FREE_PLAN } from '@/lib/pro/types';
import { clearAllData, listFoldedTabs, removeTabsWithSnapshot, saveCapture } from '@/lib/repo';
import { syncStatus, type SyncStatus } from '@/lib/state';
import { cloudSyncArea, cloudSyncState, describeCloudError } from '@/lib/sync/cloud';
import { chromeSyncArea, cloudSync, cloudSyncNow, runSync, syncOnce, type SyncDeps, type SyncRunResult } from '@/lib/sync/engine';
import { defaultSyncState, type SyncLocalState, type SyncStateStore } from '@/lib/sync/localState';
import {
  capTitle,
  CLOUD_LIMITS,
  itemBytes,
  META_KEY,
  pack,
  SYNC_LIMITS,
  toSyncTime,
  unpack,
  type SyncRecord,
} from '@/lib/sync/records';
import { capturedWindow } from './fixtures';
import { EMAIL, FakeServer, giveToken, installPro, planOf } from './proServer';

let pro: ReturnType<typeof installPro>;
let server: FakeServer;

beforeEach(async () => {
  pro = installPro();
  server = pro.server;
  // This computer is signed in to an account paying for Pro (the plan stored here is up to each test).
  server.account(EMAIL, { tier: 'pro', interval: 'month', status: 'active' });
  server.link(await giveToken());
});

/** The account stops paying (the server answers 402 to sync). */
const planEndsOnServer = () => {
  server.account(EMAIL).subscription = null;
};

afterEach(() => {
  pro.restore();
  vi.restoreAllMocks();
});

function memoryStore(): SyncStateStore & { value: SyncLocalState } {
  const store = {
    value: defaultSyncState(),
    get: async () => store.value,
    set: async (state: SyncLocalState) => {
      store.value = state;
    },
  };
  return store;
}

let dbCounter = 0;
let clock = Date.now();

/** A computer syncing with the Tabfold account (the fake server). */
class Computer {
  db: TabfoldDB;
  status: SyncStatus | undefined;
  deps: SyncDeps;
  constructor(
    readonly name: string,
    readonly store: SyncStateStore = memoryStore(),
  ) {
    this.db = new TabfoldDB(`cloud-test-${name}-${dbCounter++}`);
    this.deps = {
      database: this.db,
      area: cloudSyncArea(api),
      store: this.store,
      deviceId: async () => `device-${name}`,
      enabled: async () => true,
      isWiped: async () => false,
      now: () => clock,
      limits: CLOUD_LIMITS,
    };
  }
  async fold(urls: string[], title?: (url: string) => string) {
    clock += 2000;
    const window = capturedWindow(urls);
    if (title) for (const tab of window.tabs) tab.title = title(tab.url);
    return saveCapture([window], { source: 'save-all', deviceId: `device-${this.name}`, now: clock }, { dedupe: true }, this.db);
  }
  async sync(force = false): Promise<SyncRunResult> {
    clock += 1000;
    const result = await syncOnce(this.deps, { previous: this.status, force });
    this.status = result.status;
    return result;
  }
  async urls() {
    return (await listFoldedTabs(this.db)).map((t) => t.url).sort();
  }
}

async function settle(...computers: Computer[]) {
  for (let round = 0; round < 6; round += 1) {
    let wrote = false;
    for (const computer of computers) wrote = (await computer.sync()).wrote || wrote;
    if (!wrote) return round;
  }
  throw new Error('Computers kept writing to the Tabfold account');
}

const posts = () => server.apiCalls('/sync', 'POST');

describe('cloud sync limits', () => {
  it('fits thousands of tabs with 200-character titles, well inside the server’s 8 MB', () => {
    const T0 = toSyncTime(Date.UTC(2026, 9, 1));
    const records: SyncRecord[] = Array.from({ length: 5_000 }, (_, i) => ({
      id: i.toString(16).padStart(12, '0'),
      url: `https://site${i}.example.com/some/longer/path?id=${i}`,
      title: capTitle('T'.repeat(250), CLOUD_LIMITS),
      savedAt: T0 + i * 1000,
      keywords: ['work'],
    }));
    const packed = pack(records, [], { floor: 0, limits: CLOUD_LIMITS });
    expect(packed.records).toHaveLength(5_000);
    let total = 0;
    for (const [key, value] of Object.entries(packed.items)) {
      const bytes = itemBytes(key, value);
      expect(bytes).toBeLessThanOrEqual(CLOUD_LIMITS.quotaBytesPerItem);
      total += bytes;
    }
    expect(total).toBeLessThan(CLOUD_LIMITS.quotaBytes);
    expect(Object.keys(packed.items).length).toBeLessThan(CLOUD_LIMITS.maxItems);
    // Read back with the cloud limits, titles keep their 200 characters (Chrome sync's would cut to 120).
    expect(unpack(packed.items, CLOUD_LIMITS).records[0]!.title).toHaveLength(200);
    expect(unpack(packed.items).records[0]!.title).toHaveLength(SYNC_LIMITS.maxTitleLength);
    // The same records through Chrome sync's limits: the newest 500.
    expect(pack(records, [], { floor: 0 }).records.length).toBeLessThanOrEqual(500);
  });
});

describe('sync with the Tabfold account', () => {
  beforeEach(() => {
    clock = Date.now();
  });

  it('two computers share well over 500 tabs, and an echo never writes again', async () => {
    const a = new Computer('a');
    const b = new Computer('b');
    const long = (url: string) => `${'A long title '.repeat(14)}${url}`.slice(0, 190);
    await a.fold(Array.from({ length: 1_200 }, (_, i) => `https://a${i}.example.com/page`), long);
    const first = await a.sync();
    expect(first).toMatchObject({ wrote: true, status: { state: 'synced', syncedTabs: 1_200, localOnly: 0 } });
    expect(posts()).toBe(1);
    expect(server.version).toBe(1);

    await b.fold(Array.from({ length: 300 }, (_, i) => `https://b${i}.example.com/page`));
    expect(await b.sync()).toMatchObject({ applied: true, wrote: true, status: { syncedTabs: 1_500, localOnly: 0 } });
    expect(await b.urls()).toHaveLength(1_500);
    await a.sync();
    expect(await a.urls()).toHaveLength(1_500);
    // Titles keep up to 200 characters.
    const titles = (await listFoldedTabs(b.db)).filter((t) => t.url.startsWith('https://a1.')).map((t) => t.title);
    expect(titles[0]).toHaveLength(190);

    expect(await settle(a, b)).toBe(0);
    const writes = posts();
    await settle(a, b);
    expect(posts()).toBe(writes);
    // 1,500 tabs through two computers several times: slow on a busy machine.
  }, 30_000);

  it('a write based on an out-of-date copy is refused, read again and merged', async () => {
    const a = new Computer('a');
    const b = new Computer('b');
    await a.fold(['https://x.com', 'https://x2.com']);
    await b.fold(['https://y.com']);
    // B writes between A reading the account and A writing to it.
    server.beforeNextPost = () => b.sync();
    const raced = await a.sync();
    expect(raced).toMatchObject({ wrote: false, skipped: 'raced', status: { state: 'syncing' } });
    expect(raced.retryAt).toBeGreaterThan(clock - 1000);
    expect(server.requests.filter((r) => r.method === 'POST').map((r) => (r.body as { baseVersion: number }).baseVersion)).toEqual([0, 0]);
    expect(unpack(server.items, CLOUD_LIMITS).records.map((r) => r.url)).toEqual(['https://y.com']);

    await settle(a, b);
    expect(await a.urls()).toEqual(['https://x.com', 'https://x2.com', 'https://y.com']);
    expect(await b.urls()).toEqual(['https://x.com', 'https://x2.com', 'https://y.com']);
    expect(a.status).toMatchObject({ state: 'synced', syncedTabs: 3 });
  });

  it('removals travel through the account too', async () => {
    const a = new Computer('a');
    const b = new Computer('b');
    const saved = await a.fold(['https://a.com', 'https://b.com', 'https://c.com']);
    await settle(a, b);
    await removeTabsWithSnapshot([saved.savedTabIds[1]!], a.db);
    await settle(a, b);
    expect(await b.urls()).toEqual(['https://a.com', 'https://c.com']);
    expect(unpack(server.items, CLOUD_LIMITS).tombstones).toHaveLength(1);
  });

  it('explains failures and keeps every tab: offline, plan ended, account full', async () => {
    const a = new Computer('a');
    await a.fold(['https://a.com']);
    server.offline = true;
    const offline = await a.sync();
    expect(offline.status).toMatchObject({ state: 'error', error: 'Can’t reach your Tabfold account. Trying again soon.' });
    expect(await a.urls()).toEqual(['https://a.com']);

    server.offline = false;
    planEndsOnServer();
    const ended = await a.sync(true);
    expect(ended.status).toMatchObject({ state: 'error', error: 'Needs Pro.' });
    expect(ended.retryAt! - clock).toBeGreaterThanOrEqual(15 * 60_000);

    expect(describeCloudError(new Error('x'))).toEqual({
      message: 'Couldn’t sync with your Tabfold account. Trying again later.',
      minDelayMs: 0,
      shrink: false,
    });
    expect(describeCloudError(errorFromResponse(413, { error: 'server' }))).toMatchObject({ shrink: true });
    expect(describeCloudError(errorFromResponse(409, { error: 'conflict' }))).toMatchObject({ raced: true });
  });

  it('asks for the plan again when the server says it doesn’t include sync', async () => {
    planEndsOnServer();
    const mismatch = vi.fn();
    const area = cloudSyncArea(api, mismatch);
    await expect(area.getAll()).rejects.toMatchObject({ code: 'needs-pro', status: 402 });
    expect(mismatch).toHaveBeenCalledTimes(1);
  });

  it('"Clear all data" empties the account, and the other computer doesn’t bring the old tabs back', async () => {
    await planState.set(planOf({ tier: 'pro' }));
    const a = new Computer('a', cloudSyncState);
    const b = new Computer('b');
    await a.fold(['https://a.com', 'https://b.com']);
    await b.fold(['https://from-b.com']);
    await settle(a, b);
    expect(await a.urls()).toHaveLength(3);

    clock += 1000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(clock);
    await clearAllData(a.db);
    now.mockRestore();
    expect(Object.keys(server.items)).toEqual([META_KEY]);

    await settle(a, b);
    expect(await a.urls()).toEqual([]);
    expect(await b.urls()).toHaveLength(3);
    expect(b.status).toMatchObject({ state: 'synced', syncedTabs: 0, localOnly: 3 });
    await a.fold(['https://after.com']);
    await settle(a, b);
    expect(await b.urls()).toContain('https://after.com');
  });
});

describe('switching between Chrome sync and the Tabfold account', () => {
  const proPlan = () => planOf({ tier: 'pro', interval: 'year' });
  const chromeKeys = async () => Object.keys(await chromeSyncArea.getAll());

  it('Pro pauses Chrome sync (off, no error) and syncs through the account; Free resumes Chrome sync', async () => {
    await saveCapture([capturedWindow(['https://a.com', 'https://b.com', 'https://c.com'])], { source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: true });

    // Free: Chrome sync runs; the account is never contacted and has no status.
    expect(await cloudSync.run()).toMatchObject({ skipped: 'off' });
    expect(await cloudSyncStatus.get()).toBeUndefined();
    expect(server.requests.filter((r) => r.url.includes('/sync'))).toHaveLength(0);

    await planState.set(proPlan());
    const paused = await runSync({ force: true });
    expect(paused).toMatchObject({ skipped: 'off', wrote: false, status: { state: 'off' } });
    expect((await syncStatus.get())?.error).toBeUndefined();
    expect(await chromeKeys()).toEqual([]);

    expect(await cloudSyncNow()).toEqual({ ok: true });
    expect(await cloudSyncStatus.get()).toMatchObject({ state: 'synced', syncedTabs: 3, localOnly: 0 });
    expect(unpack(server.items, CLOUD_LIMITS).records).toHaveLength(3);

    // The plan ends: Chrome sync picks up on its own, the account sync stops, nothing here is removed.
    await planState.set({ ...FREE_PLAN, checkedAt: Date.now() });
    expect(await runSync({ force: true })).toMatchObject({ wrote: true, status: { state: 'synced', syncedTabs: 3 } });
    expect(await chromeKeys()).toContain(META_KEY);
    expect(await cloudSync.run({ force: true })).toMatchObject({ skipped: 'off' });
    expect(await cloudSyncStatus.get()).toMatchObject({ state: 'off' });
    expect(await listFoldedTabs()).toHaveLength(3);
    expect(await cloudSyncNow()).toEqual({ ok: false });
  });

  it('the cloud-sync-now command does nothing without Pro', async () => {
    expect(await route({ type: 'cloud-sync-now' })).toEqual({ ok: true, data: { ok: false } });
    expect(server.requests).toHaveLength(0);
    await planState.set(proPlan());
    await saveCapture([capturedWindow(['https://a.com'])], { source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: true });
    expect(await route({ type: 'cloud-sync-now' })).toEqual({ ok: true, data: { ok: true } });
    expect(server.apiCalls('/sync', 'POST')).toBe(1);
  });

  it('signing out here pauses the account sync and Chrome sync picks up, with no “plan ended” notice', async () => {
    await planState.set(server.planFor(EMAIL));
    await saveCapture([capturedWindow(['https://a.com', 'https://b.com'])], { source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: true });
    expect(await runSync({ force: true })).toMatchObject({ skipped: 'off' });
    expect(await cloudSyncNow()).toEqual({ ok: true });
    expect(Object.keys((await cloudSyncState.get()).known)).toHaveLength(2);

    expect(await route({ type: 'signout' })).toEqual({ ok: true, data: { ok: true } });
    expect(await planState.get()).toMatchObject({ tier: 'free', email: null });
    expect(await planEnded.get()).toBeUndefined();
    expect(server.tokens.size).toBe(0);
    // Chrome sync runs again; the account isn't asked anything.
    expect(await runSync({ force: true })).toMatchObject({ wrote: true, status: { state: 'synced', syncedTabs: 2 } });
    expect(await chromeKeys()).toContain(META_KEY);
    const calls = server.requests.length;
    expect(await cloudSync.run({ force: true })).toMatchObject({ skipped: 'off' });
    expect(server.requests).toHaveLength(calls);
    // What this computer knew about the account's copy is forgotten; the next sign-in starts afresh.
    expect(await cloudSyncState.get()).toEqual(defaultSyncState());
    expect(await listFoldedTabs()).toHaveLength(2);
  });
});
