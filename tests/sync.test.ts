import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { TabfoldDB } from '@/lib/db';
import { clearAllData, isSyncInbox, listFoldedTabs, removeTabsWithSnapshot, saveCapture, SYNC_INBOX_NAME, putBackTabs } from '@/lib/repo';
import type { SyncStatus } from '@/lib/state';
import { chromeSyncArea, syncOnce, type SyncArea, type SyncDeps, type SyncRunResult } from '@/lib/sync/engine';
import { defaultSyncState, localSyncState, type SyncLocalState, type SyncStateStore } from '@/lib/sync/localState';
import { mergeContent, pickTitle, planSync, type LocalTab } from '@/lib/sync/merge';
import {
  capTitle,
  diffItems,
  isSyncable,
  itemBytes,
  pack,
  pruneTombstones,
  recordKey,
  SYNC_LIMITS,
  syncId,
  toSyncTime,
  unpack,
  urlKey,
  META_KEY,
  type SyncRecord,
  type Tombstone,
} from '@/lib/sync/records';
import { capturedWindow } from './fixtures';

const DAY = 24 * 60 * 60 * 1000;
const T0 = toSyncTime(Date.UTC(2026, 9, 1));

function hex12(n: number): string {
  return n.toString(16).padStart(12, '0');
}

function record(n: number, extra: Partial<SyncRecord> = {}): SyncRecord {
  return { id: hex12(n), url: `https://site${n}.example.com/page`, title: `Page ${n}`, savedAt: T0 + n * 1000, keywords: [], ...extra };
}

/** Check items against chrome.storage.sync's limits, measured as Chrome measures them. */
function expectWithinQuota(items: Record<string, unknown>) {
  const entries = Object.entries(items);
  expect(entries.length).toBeLessThanOrEqual(SYNC_LIMITS.maxItems);
  let total = 0;
  for (const [key, value] of entries) {
    const bytes = itemBytes(key, value);
    expect(bytes).toBeLessThanOrEqual(SYNC_LIMITS.quotaBytesPerItem);
    total += bytes;
  }
  expect(total).toBeLessThanOrEqual(SYNC_LIMITS.quotaBytes);
  return total;
}

describe('sync records', () => {
  it('gives a tab the same short id everywhere', () => {
    const uuid = '3f2b8c1e-9a7d-4e21-b5c3-0d9e8f7a6b5c';
    expect(syncId(uuid)).toBe('3f2b8c1e9a7d');
    expect(syncId(syncId(uuid))).toBe('3f2b8c1e9a7d');
    const other = syncId('not-a-uuid');
    expect(other).toMatch(/^[0-9a-z]{12}$/);
    expect(syncId(other)).toBe(other);
  });

  it('shortens titles without cutting a character in half, and skips long or script addresses', () => {
    const emoji = '😀'.repeat(130);
    expect(Array.from(capTitle(emoji))).toHaveLength(SYNC_LIMITS.maxTitleLength);
    expect(capTitle('  short  ')).toBe('short');
    expect(isSyncable(`https://a.com/?q=${'x'.repeat(1990)}`)).toBe(false);
    expect(isSyncable(`https://a.com/?q=${'x'.repeat(1900)}`)).toBe(true);
    expect(isSyncable('data:text/html,hi')).toBe(false);
    expect(isSyncable('javascript:alert(1)')).toBe(false);
    expect(urlKey('https://a.com/')).toBe(urlKey('https://a.com'));
  });

  it('shares at most the newest 500, within the quota', () => {
    const records = Array.from({ length: 600 }, (_, i) => record(i));
    const packed = pack(records, [], { floor: 0 });
    expect(packed.records).toHaveLength(500);
    expect(packed.records[0]!.id).toBe(hex12(599));
    expect(packed.records.at(-1)!.id).toBe(hex12(100));
    expectWithinQuota(packed.items);
    const meta = packed.items[META_KEY] as { n: number };
    expect(Object.keys(packed.items).filter((k) => k.startsWith('tf.c'))).toHaveLength(meta.n);
  });

  it('fills up to the quota with long addresses, skipping ones that no longer fit for smaller ones', () => {
    const long = Array.from({ length: 500 }, (_, i) => record(i + 10, { url: `https://long${i}.com/?q=${'x'.repeat(1_950)}` }));
    const small = [record(1), record(2)];
    const packed = pack([...long, ...small], [], { floor: 0 });
    const total = expectWithinQuota(packed.items);
    expect(total).toBeGreaterThan(SYNC_LIMITS.quotaBytes * 0.9);
    expect(packed.records.length).toBeLessThan(60);
    // Older but small: they still fit after the long ones stopped fitting.
    expect(packed.records.map((r) => r.id)).toEqual(expect.arrayContaining([hex12(1), hex12(2)]));
  });

  it('counts titles in bytes, not characters', () => {
    const records = Array.from({ length: 500 }, (_, i) => record(i, { title: '漢字'.repeat(60), url: `https://k${i}.jp/${'p'.repeat(60)}` }));
    const packed = pack(records, [], { floor: 0 });
    expectWithinQuota(packed.items);
    expect(packed.records.length).toBeLessThan(500);
  });

  it('packs the same records the same way whatever their order, and reads them back', () => {
    const records = Array.from({ length: 120 }, (_, i) => record(i, { keywords: i % 3 ? [] : ['b', 'a'] }));
    const shuffled = [...records].sort(() => Math.random() - 0.5);
    const a = pack(records, [], { floor: 0 });
    const b = pack(shuffled, [], { floor: 0 });
    expect(b.items).toEqual(a.items);
    expect(diffItems(a.items, b.items)).toEqual({ set: {}, remove: [] });

    const back = unpack(a.items);
    expect(back.complete).toBe(true);
    expect(back.records).toHaveLength(120);
    expect(back.records.find((r) => r.id === hex12(3))!.keywords).toEqual(['a', 'b']);
  });

  it('reads a copy that arrived in part, ignores leftover and malformed chunks', () => {
    const packed = pack(Array.from({ length: 300 }, (_, i) => record(i, { title: `A longer title for page ${i} to fill chunks` })), [], {
      floor: 0,
    });
    const meta = packed.items[META_KEY] as { n: number };
    expect(meta.n).toBeGreaterThan(2);
    const partial = { ...packed.items };
    delete partial[recordKey(1)];
    const read = unpack(partial);
    expect(read.complete).toBe(false);
    expect(read.records.length).toBeGreaterThan(0);
    expect(read.records.length).toBeLessThan(300);

    const leftovers = { ...packed.items, [recordKey(meta.n)]: [[hex12(9999), 'https://stale.com', 'Stale', 1]] };
    expect(unpack(leftovers).records.some((r) => r.url === 'https://stale.com')).toBe(false);
    expect(diffItems(leftovers, packed.items).remove).toEqual([recordKey(meta.n)]);

    const junk = unpack({ [META_KEY]: { v: 1, n: 1, t: 0, h: 'x', c: 0 }, [recordKey(0)]: [['bad id', 'https://a.com', 'A', 1], 'nope', [hex12(1), 'https://ok.com', 'OK', 5]] });
    expect(junk.records.map((r) => r.url)).toEqual(['https://ok.com']);
    expect(junk.complete).toBe(false);
  });

  it('keeps nothing in Chrome sync when there is nothing to share', () => {
    expect(pack([], [], { floor: 0 })).toMatchObject({ items: {}, hash: null });
    expect(unpack({})).toMatchObject({ records: [], tombstones: [], meta: null, complete: true });
  });

  it('prunes tombstones after 30 days, keeps the newest 300 and one per id', () => {
    const now = T0 + 100 * DAY;
    const old: Tombstone = { id: hex12(1), at: now - 31 * DAY, key: 'k1' };
    const twice: Tombstone[] = [
      { id: hex12(2), at: now - 2 * DAY, key: 'k2' },
      { id: hex12(2), at: now - DAY, key: 'k2' },
    ];
    expect(pruneTombstones([old, ...twice], now)).toEqual([twice[1]]);
    const many = Array.from({ length: 400 }, (_, i) => ({ id: hex12(i + 10), at: now - i * 1000, key: `k${i}` }));
    const kept = pruneTombstones(many, now);
    expect(kept).toHaveLength(SYNC_LIMITS.maxTombstones);
    expect(kept.at(-1)!.id).toBe(hex12(10 + 299));
    // Tombstones travel with the records and leave room for them.
    const packed = pack(Array.from({ length: 600 }, (_, i) => record(i)), kept, { floor: 0 });
    expectWithinQuota(packed.items);
    expect(unpack(packed.items).tombstones).toHaveLength(300);
  });
});

describe('sync merge', () => {
  const uuid = (n: number) => `${hex12(n).slice(0, 8)}-${hex12(n).slice(8)}-4000-8000-000000000000`;
  function local(n: number, extra: Partial<LocalTab> = {}): LocalTab {
    return { id: uuid(n), url: `https://site${n}.example.com/page`, title: `Page ${n}`, savedAt: T0 + n * 1000, keywords: [], ...extra };
  }
  const base = { known: {}, mine: {}, floor: 0, now: T0 + DAY };
  const remote = (records: SyncRecord[] = [], tombstones: Tombstone[] = [], floor = 0) => ({ records, tombstones, floor });

  it('picks titles and merges keywords the same way in either order', () => {
    const a = record(1, { title: 'site1.example.com', keywords: ['x'] });
    const b = record(1, { title: 'Real title', keywords: ['y', 'x'] });
    expect(mergeContent(a, b)).toEqual(mergeContent(b, a));
    expect(mergeContent(a, b)).toMatchObject({ title: 'Real title', keywords: ['x', 'y'] });
    expect(pickTitle('Alpha', 'Beta', 'https://a.com')).toBe(pickTitle('Beta', 'Alpha', 'https://a.com'));
  });

  it('shares the newest tab per address and counts the rest as local only', () => {
    const tabs = [local(1), local(2), local(3, { url: 'https://site2.example.com/page/' }), local(4, { url: `https://x.com/${'y'.repeat(2100)}` })];
    const plan = planSync({ ...base, local: tabs, remote: remote() });
    expect(plan.packed.records.map((r) => r.id)).toEqual([syncId(uuid(3)), syncId(uuid(1))]);
    // The older copy of the same address is represented by the newer one; the long address stays here.
    expect(plan.counts).toEqual({ synced: 2, localOnly: 1, waiting: 0 });
    expect(plan.known).toEqual({ [syncId(uuid(3))]: urlKey(tabs[2]!.url), [syncId(uuid(1))]: urlKey(tabs[0]!.url) });
  });

  it('brings in new tabs, and newer titles or more keywords for tabs it has', () => {
    const tabs = [local(1, { title: 'site1.example.com' }), local(2, { keywords: ['a'] })];
    const incoming = [
      record(0, { id: syncId(uuid(1)), url: tabs[0]!.url, savedAt: toSyncTime(tabs[0]!.savedAt), title: 'Real one' }),
      record(0, { id: syncId(uuid(2)), url: tabs[1]!.url, savedAt: toSyncTime(tabs[1]!.savedAt), title: 'Page 2', keywords: ['b'] }),
      record(9),
    ];
    const plan = planSync({ ...base, local: tabs, remote: remote(incoming) });
    expect(plan.insert.map((r) => r.id)).toEqual([hex12(9)]);
    expect([...plan.update].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: uuid(1), title: 'Real one' },
      { id: uuid(2), keywords: ['a', 'b'] },
    ]);
    expect(plan.remove).toEqual([]);
  });

  it('turns tabs removed here into tombstones, and removes tabs removed elsewhere', () => {
    const tabs = [local(1), local(2)];
    const first = planSync({ ...base, local: tabs, remote: remote() });
    // Tab 2 is removed here.
    const second = planSync({ ...base, local: [tabs[0]!], remote: remote(first.packed.records), known: first.known });
    expect(second.packed.tombstones).toEqual([{ id: syncId(uuid(2)), at: base.now, key: urlKey(tabs[1]!.url) }]);
    expect(second.packed.records.map((r) => r.id)).toEqual([syncId(uuid(1))]);
    expect(Object.keys(second.mine)).toEqual([syncId(uuid(2))]);

    // Elsewhere, a copy of tab 2 is removed by id; a copy of the same address folded earlier goes
    // too, one folded after the removal stays.
    const elsewhere = [
      local(20, { id: syncId(uuid(2)), url: tabs[1]!.url, savedAt: tabs[1]!.savedAt }),
      local(21, { url: tabs[1]!.url, savedAt: tabs[1]!.savedAt - 5000 }),
      local(22, { url: tabs[1]!.url, savedAt: base.now + 60_000 }),
    ];
    const there = planSync({ ...base, local: elsewhere, remote: remote(second.packed.records, second.packed.tombstones), now: base.now + 120_000 });
    expect(there.remove.sort()).toEqual([syncId(uuid(2)), uuid(21)].sort());
    expect(there.packed.records.map((r) => r.id)).toContain(syncId(uuid(22)));
  });

  it('takes its own tombstone back when the tab comes back (Undo)', () => {
    const tabs = [local(1), local(2)];
    const first = planSync({ ...base, local: tabs, remote: remote() });
    const removed = planSync({ ...base, local: [tabs[0]!], remote: remote(first.packed.records), known: first.known });
    const undone = planSync({
      ...base,
      local: tabs,
      remote: remote(removed.packed.records, removed.packed.tombstones),
      known: removed.known,
      mine: removed.mine,
    });
    expect(undone.packed.tombstones).toEqual([]);
    expect(undone.remove).toEqual([]);
    expect(undone.packed.records).toHaveLength(2);
    // Someone else's tombstone is never taken back.
    const theirs = planSync({ ...base, local: tabs, remote: remote(removed.packed.records, removed.packed.tombstones), known: removed.known });
    expect(theirs.remove).toEqual([uuid(2)]);
  });

  it('two computers folding the same address end up with one copy, the newest', () => {
    const url = 'https://same.com/doc';
    const onA = local(1, { url, title: 'Doc', keywords: ['a'] });
    const onB = local(2, { url, title: 'Doc (edited)' });
    const a1 = planSync({ ...base, local: [onA], remote: remote() });
    // B folded it later: B keeps its own, and its copy wins in the shared list.
    const b1 = planSync({ ...base, local: [onB], remote: remote(a1.packed.records) });
    expect(b1.adopt).toEqual([]);
    expect(b1.insert).toEqual([]);
    expect(b1.packed.records.map((r) => r.id)).toEqual([syncId(uuid(2))]);
    // A takes B's newer copy in place of its own, keeping its keywords.
    const a2 = planSync({ ...base, local: [onA], remote: remote(b1.packed.records), known: a1.known });
    expect(a2.adopt).toEqual([{ localId: uuid(1), record: { ...b1.packed.records[0]!, keywords: ['a'] } }]);
    expect(a2.packed.tombstones).toEqual([]);
    expect(a2.counts).toEqual({ synced: 1, localOnly: 0, waiting: 0 });
  });

  it('after "Clear all data", tabs folded before it are neither shared nor brought in, and nothing here is deleted', () => {
    const tabs = [local(1), local(2, { savedAt: T0 + 10 * DAY })];
    const floor = T0 + 5 * DAY;
    const plan = planSync({ ...base, now: T0 + 11 * DAY, local: tabs, remote: remote([record(3)], [], floor) });
    expect(plan.insert).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.packed.records.map((r) => r.id)).toEqual([syncId(uuid(2))]);
    expect(plan.floor).toBe(floor);
    expect(plan.counts).toEqual({ synced: 1, localOnly: 1, waiting: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// Two computers sharing one chrome.storage.sync

/** chrome.storage.sync with Chrome's quota checks, and a count of writes. */
class QuotaArea implements SyncArea {
  writes = 0;
  failNext: Error | null = null;
  /** Reads return this while `staleReads` lasts (a computer that hasn't received the latest write yet). */
  stale: Record<string, unknown> | null = null;
  staleReads = 0;
  async getAll() {
    if (this.stale && this.staleReads > 0) {
      this.staleReads -= 1;
      return this.stale;
    }
    return chromeSyncArea.getAll();
  }
  async set(items: Record<string, unknown>) {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const after = { ...(await fakeBrowser.storage.sync.get(null)), ...items };
    let total = 0;
    for (const [key, value] of Object.entries(after)) {
      const bytes = itemBytes(key, value);
      if (bytes > SYNC_LIMITS.quotaBytesPerItem) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
      total += bytes;
    }
    if (total > SYNC_LIMITS.quotaBytes) throw new Error('QUOTA_BYTES quota exceeded');
    if (Object.keys(after).length > SYNC_LIMITS.maxItems) throw new Error('MAX_ITEMS quota exceeded');
    this.writes += 1;
    await chromeSyncArea.set(items);
  }
  async remove(keys: string[]) {
    this.writes += 1;
    await chromeSyncArea.remove(keys);
  }
}

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

class Computer {
  db: TabfoldDB;
  status: SyncStatus | undefined;
  enabled = true;
  wiped = false;
  deps: SyncDeps;
  constructor(
    readonly name: string,
    readonly area: QuotaArea,
    readonly store: SyncStateStore = memoryStore(),
  ) {
    this.db = new TabfoldDB(`sync-test-${name}-${dbCounter++}`);
    this.deps = {
      database: this.db,
      area,
      store: this.store,
      deviceId: async () => `device-${name}`,
      enabled: async () => this.enabled,
      isWiped: async () => this.wiped,
      now: () => clock,
    };
  }
  async fold(urls: string[], keywords: string[] = []) {
    clock += 2000;
    const window = capturedWindow(urls);
    for (const tab of window.tabs) tab.keywords = keywords;
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
  async tabs() {
    return listFoldedTabs(this.db);
  }
}

/** Run both until neither writes; fail if they keep writing (a write loop). */
async function settle(...computers: Computer[]) {
  for (let round = 0; round < 6; round += 1) {
    let wrote = false;
    for (const computer of computers) wrote = (await computer.sync()).wrote || wrote;
    if (!wrote) return round;
  }
  throw new Error('Computers kept writing to Chrome sync');
}

describe('sync between two computers', () => {
  let area: QuotaArea;
  let a: Computer;
  let b: Computer;

  beforeEach(() => {
    clock = Date.now();
    area = new QuotaArea();
    a = new Computer('a', area);
    b = new Computer('b', area);
  });

  it('shares folded tabs into "From your other computers", and an echo never writes again', async () => {
    await a.fold(['https://a.com', 'https://b.com', 'https://c.com'], ['work']);
    const first = await a.sync();
    expect(first).toMatchObject({ wrote: true, status: { state: 'synced', syncedTabs: 3, localOnly: 0 } });
    expect(area.writes).toBe(1);

    // Our own write coming back: nothing to do.
    expect(await a.sync()).toMatchObject({ wrote: false, skipped: 'unchanged' });
    expect(await a.sync(true)).toMatchObject({ wrote: false, applied: false });

    const onB = await b.sync();
    expect(onB).toMatchObject({ applied: true, wrote: false, status: { state: 'synced', syncedTabs: 3 } });
    expect(await b.urls()).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    const inbox = (await b.db.sessions.toArray()).find(isSyncInbox)!;
    expect(inbox).toMatchObject({ name: SYNC_INBOX_NAME, tabCount: 3, deletedAt: 0 });
    expect((await b.tabs()).every((t) => t.keywords.join() === 'work')).toBe(true);

    expect(await settle(a, b)).toBe(0);
    expect(area.writes).toBe(1);
    // Merged tabs keep their ids, so they never come back to A as copies.
    expect(await a.urls()).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('never shares tabs folded from Incognito, and they stay here when the other computer has the same address', async () => {
    clock += 2000;
    const secret = { ...capturedWindow(['https://private.com', 'https://both.com']), incognito: true };
    await saveCapture([capturedWindow(['https://a.com']), secret], { source: 'save-all', deviceId: 'device-a', now: clock }, { dedupe: true }, a.db);
    expect(await a.sync()).toMatchObject({ wrote: true, status: { state: 'synced', syncedTabs: 1, localOnly: 0 } });
    expect(JSON.stringify(await area.getAll())).toContain('a.com');
    expect(JSON.stringify(await area.getAll())).not.toContain('private.com');

    await b.fold(['https://both.com']);
    await settle(a, b);
    expect(await b.urls()).toEqual(['https://a.com', 'https://both.com']);
    const both = (await a.tabs()).filter((t) => t.url === 'https://both.com');
    expect(both.map((t) => !!t.incognito).sort()).toEqual([false, true]);
    expect(JSON.stringify(await area.getAll())).not.toContain('private.com');
  });

  it('removals travel both ways, including at the same time', async () => {
    await a.fold(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com']);
    await a.sync();
    await b.sync();

    const removeUrl = async (computer: Computer, url: string) => {
      const tab = (await computer.tabs()).find((t) => t.url === url)!;
      await removeTabsWithSnapshot([tab.id], computer.db);
    };
    await removeUrl(b, 'https://b.com');
    expect((await b.sync()).wrote).toBe(true);
    await a.sync();
    expect(await a.urls()).toEqual(['https://a.com', 'https://c.com', 'https://d.com']);

    // Both remove a different tab before either syncs.
    await removeUrl(a, 'https://c.com');
    await removeUrl(b, 'https://d.com');
    await settle(a, b);
    expect(await a.urls()).toEqual(['https://a.com']);
    expect(await b.urls()).toEqual(['https://a.com']);
    expect(unpack(await area.getAll()).tombstones.map((t) => t.id)).toHaveLength(3);
  });

  it('the same address folded on both computers shows once, the newest copy', async () => {
    await a.fold(['https://same.com/doc', 'https://only-a.com']);
    await b.fold(['https://same.com/doc/', 'https://only-b.com']);
    await settle(a, b);
    for (const computer of [a, b]) {
      const tabs = await computer.tabs();
      expect(tabs.map((t) => t.url).sort()).toEqual(['https://only-a.com', 'https://only-b.com', 'https://same.com/doc/']);
    }
    const ids = async (c: Computer) => (await c.tabs()).map((t) => syncId(t.id)).sort();
    expect(await ids(a)).toEqual(await ids(b));
    const writes = area.writes;
    await settle(a, b);
    expect(area.writes).toBe(writes);
  });

  it('two computers writing at the same moment still end up with the same list', async () => {
    await a.fold(['https://x.com', 'https://x2.com']);
    await b.fold(['https://y.com']);
    const before = await area.getAll();
    expect((await a.sync()).wrote).toBe(true);
    // B hasn't received A's write and overwrites it.
    area.stale = before;
    area.staleReads = 3;
    expect((await b.sync()).wrote).toBe(true);
    area.staleReads = 0;
    expect(unpack(await area.getAll()).records.map((r) => r.url)).toEqual(['https://y.com']);
    await settle(a, b);
    expect(await a.urls()).toEqual(['https://x.com', 'https://x2.com', 'https://y.com']);
    expect(await b.urls()).toEqual(['https://x.com', 'https://x2.com', 'https://y.com']);
    expect(unpack(await area.getAll()).tombstones).toEqual([]);
  });

  it('starts again instead of writing an out-of-date plan when Chrome sync changed during the run', async () => {
    await a.fold(['https://x.com']);
    await b.fold(['https://y.com']);
    await a.sync();
    // B's first read misses A's write, but by the time it would write, A's copy is there.
    area.stale = {};
    area.staleReads = 1;
    expect(await b.sync()).toMatchObject({ skipped: 'raced', wrote: false, applied: false });
    expect(unpack(await area.getAll()).records.map((r) => r.url)).toEqual(['https://x.com']);
    await settle(a, b);
    expect(await b.urls()).toEqual(['https://x.com', 'https://y.com']);
    expect(await a.urls()).toEqual(['https://x.com', 'https://y.com']);
  });

  it('shares the newest 500 and says how many stay on this computer', async () => {
    await a.fold(Array.from({ length: 300 }, (_, i) => `https://old${i}.com`));
    await a.fold(Array.from({ length: 300 }, (_, i) => `https://new${i}.com`));
    const result = await a.sync();
    expect(result.status).toMatchObject({ state: 'synced', syncedTabs: 500, localOnly: 100 });
    expectWithinQuota(await area.getAll());
    await b.sync();
    const onB = await b.urls();
    expect(onB).toHaveLength(500);
    expect(onB.filter((u) => u.includes('new'))).toHaveLength(300);
    expect(await settle(a, b)).toBe(0);
  });

  it('backs off when Chrome sync is full, keeps every tab, and tries again with less', async () => {
    await a.fold(['https://a.com', 'https://b.com']);
    area.failNext = new Error('QUOTA_BYTES quota exceeded');
    const failed = await a.sync();
    expect(failed.status).toMatchObject({ state: 'error', error: 'Chrome sync is full. Trying again soon.' });
    expect(failed.retryAt).toBeGreaterThan(clock);
    expect(await a.urls()).toEqual(['https://a.com', 'https://b.com']);
    expect(await a.sync()).toMatchObject({ skipped: 'backoff', wrote: false });

    clock += 2 * 60_000;
    const retried = await a.sync();
    expect(retried).toMatchObject({ wrote: true, status: { state: 'synced', syncedTabs: 2 } });
    expect((a.store as ReturnType<typeof memoryStore>).value).toMatchObject({ failures: 0, budgetFactor: 0.85 });
  });

  it('a write-limit error says it is busy and waits at least a minute', async () => {
    await a.fold(['https://a.com']);
    area.failNext = new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.');
    const failed = await a.sync();
    expect(failed.status.error).toBe('Chrome sync is busy. Trying again in a minute.');
    expect(failed.retryAt! - clock).toBeGreaterThanOrEqual(59_000);
  });

  it('"Clear all data" empties Chrome sync, and the other computer doesn\'t bring the old tabs back', async () => {
    a = new Computer('a', area, localSyncState);
    await a.fold(['https://a.com', 'https://b.com']);
    await b.fold(['https://from-b.com']);
    await settle(a, b);
    expect(await a.urls()).toHaveLength(3);

    clock += 1000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(clock);
    await clearAllData(a.db);
    now.mockRestore();
    const left = await area.getAll();
    expect(Object.keys(left)).toEqual([META_KEY]);
    expect(unpack(left)).toMatchObject({ records: [], tombstones: [] });

    await settle(a, b);
    expect(await a.urls()).toEqual([]);
    // B keeps its copies (sync never deletes them), but they are no longer shared.
    expect(await b.urls()).toHaveLength(3);
    expect(b.status).toMatchObject({ state: 'synced', syncedTabs: 0, localOnly: 3 });

    // Folded after the clear: shared again.
    await a.fold(['https://after.com']);
    await settle(a, b);
    expect(await b.urls()).toContain('https://after.com');
    expect(await a.urls()).toEqual(['https://after.com']);
  });

  it('an emptied Chrome sync store never removes anything here: each computer shares its newest tabs again', async () => {
    await a.fold(['https://a.com', 'https://b.com']);
    await b.fold(['https://c.com']);
    await settle(a, b);
    await fakeBrowser.storage.sync.clear();
    await settle(a, b);
    expect(await a.urls()).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    expect(await b.urls()).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    expect(unpack(await area.getAll())).toMatchObject({ tombstones: [] });
    expect(unpack(await area.getAll()).records).toHaveLength(3);
  });

  it('"Clear all data" followed by the page clearing Chrome sync: the old tabs stay gone here and are not deleted there', async () => {
    a = new Computer('a', area, localSyncState);
    await a.fold(['https://a.com', 'https://b.com']);
    await b.fold(['https://from-b.com']);
    await settle(a, b);
    clock += 1000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(clock);
    await clearAllData(a.db);
    now.mockRestore();
    await fakeBrowser.storage.sync.clear();
    // B runs first and shares its copies again, not knowing about the clear.
    await b.sync();
    await settle(a, b);
    expect(await a.urls()).toEqual([]);
    expect(await b.urls()).toHaveLength(3);
    // A put the clear time back in Chrome sync, so B stops sharing the old tabs.
    expect(unpack(await area.getAll()).records).toEqual([]);
    expect(b.status).toMatchObject({ state: 'synced', syncedTabs: 0, localOnly: 3 });
  });

  it('undo of a fold already shared removes it on the other computer too', async () => {
    await a.fold(['https://a.com']);
    const fold = await a.fold(['https://x.com', 'https://y.com']);
    await settle(a, b);
    const removed = await removeTabsWithSnapshot(fold.savedTabIds, a.db);
    await settle(a, b);
    expect(await b.urls()).toEqual(['https://a.com']);
    // Putting them back (Undo of a removal) shares them again.
    await putBackTabs(removed, a.db);
    await settle(a, b);
    expect(await b.urls()).toEqual(['https://a.com', 'https://x.com', 'https://y.com']);
    expect(unpack(await area.getAll()).tombstones).toEqual([]);
  });

  it('waits for a copy that arrived in part before writing over it', async () => {
    await a.fold(Array.from({ length: 200 }, (_, i) => `https://page${i}.com/${'p'.repeat(40)}`));
    await a.sync();
    const full = await area.getAll();
    await fakeBrowser.storage.sync.remove(recordKey(1));
    await b.fold(['https://b-only.com']);
    const partial = await b.sync();
    expect(partial).toMatchObject({ skipped: 'partial', wrote: false, applied: true });
    expect((await b.urls()).length).toBeGreaterThan(1);
    // The rest arrives.
    await fakeBrowser.storage.sync.set({ [recordKey(1)]: full[recordKey(1)] });
    await settle(a, b);
    expect(await b.urls()).toHaveLength(201);
    expect(await a.urls()).toHaveLength(201);
  });

  it('a removal made while Chrome sync\'s copy is still arriving is written once it has arrived', async () => {
    await a.fold(Array.from({ length: 200 }, (_, i) => `https://page${i}.com/${'p'.repeat(40)}`));
    await a.sync();
    await b.sync();
    const full = await area.getAll();
    // A writes again (a new fold); B has received only part of it when B removes a tab.
    await a.fold(['https://late.com']);
    await a.sync();
    const newer = await area.getAll();
    await fakeBrowser.storage.sync.set(full);
    await fakeBrowser.storage.sync.set({ [META_KEY]: newer[META_KEY] });
    const gone = (await b.tabs()).find((t) => t.url.startsWith('https://page7.com'))!;
    await removeTabsWithSnapshot([gone.id], b.db);
    expect(await b.sync()).toMatchObject({ skipped: 'partial', wrote: false });
    await fakeBrowser.storage.sync.set(newer);
    await settle(a, b);
    expect((await a.urls()).some((u) => u.startsWith('https://page7.com'))).toBe(false);
    expect(await b.urls()).toContain('https://late.com');
  });

  it('does nothing while off, and pauses on a list that looks erased', async () => {
    await a.fold(['https://a.com']);
    a.enabled = false;
    expect(await a.sync()).toMatchObject({ skipped: 'off', status: { state: 'off' } });
    expect(area.writes).toBe(0);

    a.enabled = true;
    await a.sync();
    await b.sync();
    b.wiped = true;
    const paused = await b.sync(true);
    expect(paused).toMatchObject({ skipped: 'wiped', wrote: false, status: { state: 'error' } });
    expect((b.store as ReturnType<typeof memoryStore>).value.known).toEqual({});
    // Erased here is not "removed here": nothing is tombstoned for the other computer.
    await b.db.tabs.clear();
    b.wiped = false;
    await settle(a, b);
    expect(await a.urls()).toEqual(['https://a.com']);
    expect(await b.urls()).toEqual(['https://a.com']);
  });
});
