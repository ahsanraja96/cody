import { beforeEach, describe, expect, it } from 'vitest';
import type { SiteKinds } from '@/lib/categories';
import { TabfoldDB } from '@/lib/db';
import { addFolder, countFoldedTabs, installPlacementStamp, setTabsFolder } from '@/lib/folders';
import { FREE_LIMITS } from '@/lib/limits';
import { listFoldedTabs, saveCapture } from '@/lib/repo';
import { chromeSyncArea, syncOnce, type SiteKindsStore, type SyncDeps, type SyncRunResult } from '@/lib/sync/engine';
import { defaultSyncState, type SyncLocalState, type SyncStateStore } from '@/lib/sync/localState';
import { mergeContent, mergeFolders, planSync } from '@/lib/sync/merge';
import {
  copyHash,
  decodeFolderItem,
  decodeRecord,
  encodeFolderItem,
  FOLDERS_KEY,
  itemBytes,
  META_KEY,
  pack,
  SYNC_LIMITS,
  toSyncTime,
  unpack,
  type SyncFolder,
  type SyncRecord,
} from '@/lib/sync/records';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { capturedWindow } from './fixtures';

const DAY = 24 * 60 * 60 * 1000;
const T0 = toSyncTime(Date.UTC(2026, 9, 1));
const hex12 = (n: number) => n.toString(16).padStart(12, '0');

describe('tab records carry their folder and snooze', () => {
  const base: SyncRecord = { id: hex12(1), url: 'https://a.com/', title: 'A', savedAt: T0, keywords: [] };

  it('packs the new fields after the keywords, leaves empty ones off, and reads them back', () => {
    const plain = pack([base], [], { floor: 0 });
    // A tab with no folder or snooze is packed exactly as before 0.6.
    expect((plain.items['tf.c0'] as unknown[][])[0]).toEqual([hex12(1), 'https://a.com/', 'A', T0 / 1000]);

    const placed: SyncRecord = { ...base, folderId: 'abcdefghijkl', snoozeUntil: T0 + DAY, snoozedOn: 'device-a', placedAt: T0 + 5000 };
    const packed = pack([placed], [], { floor: 0 });
    const raw = (packed.items['tf.c0'] as unknown[][])[0]!;
    expect(raw).toEqual([hex12(1), 'https://a.com/', 'A', T0 / 1000, [], 'abcdefghijkl', (T0 + DAY) / 1000, 'device-a', (T0 + 5000) / 1000]);
    expect(unpack(packed.items).records[0]).toEqual(placed);
    // Older readers take the first five fields only; malformed new fields are dropped on their own.
    expect(decodeRecord([hex12(2), 'https://b.com', 'B', 5, ['k'], 'bad id', -1, 7, 'x'])).toEqual({
      id: hex12(2),
      url: 'https://b.com',
      title: 'B',
      savedAt: 5000,
      keywords: ['k'],
    });
  });

  it('the newest change to a tab’s folder or snooze wins, the same way on every computer', () => {
    const inFolder: SyncRecord = { ...base, folderId: 'aaaaaaaaaaaa', placedAt: T0 + 1000 };
    const movedOut: SyncRecord = { ...base, placedAt: T0 + 2000 };
    expect(mergeContent(inFolder, movedOut)).toEqual(mergeContent(movedOut, inFolder));
    expect(mergeContent(inFolder, movedOut).folderId).toBeUndefined();
    // Never changed on one side (an older version's copy): the folder stays.
    expect(mergeContent(inFolder, base).folderId).toBe('aaaaaaaaaaaa');
    const tieA: SyncRecord = { ...base, folderId: 'aaaaaaaaaaaa', placedAt: T0 };
    const tieB: SyncRecord = { ...base, folderId: 'bbbbbbbbbbbb', placedAt: T0 };
    expect(mergeContent(tieA, tieB)).toEqual(mergeContent(tieB, tieA));
  });
});

describe('the tf.f item', () => {
  const folder = (n: number, extra: Partial<SyncFolder> = {}): SyncFolder => ({
    id: hex12(n),
    name: `Folder ${n}`,
    color: 'blue',
    order: n,
    updatedAt: T0 + n * 1000,
    deletedAt: 0,
    ...extra,
  });

  it('round-trips folders and site kinds in one canonical order', () => {
    const shared = {
      folders: [folder(2), folder(1, { deletedAt: T0 + 9000 })],
      kinds: [
        { host: 'zoho.eu', kind: 'mail' as const, at: T0 },
        { host: 'example.org', kind: '' as const, at: T0 + 1000 },
      ],
    };
    const item = encodeFolderItem(shared)!;
    expect(item).toEqual(encodeFolderItem({ folders: [...shared.folders].reverse(), kinds: [...shared.kinds].reverse() }));
    expect(item.f.map((f) => f[0])).toEqual([hex12(1), hex12(2)]);
    const back = decodeFolderItem(item)!;
    expect(back.folders.sort((a, b) => a.order - b.order)).toEqual([folder(1, { deletedAt: T0 + 9000 }), folder(2)]);
    expect(back.kinds.map((k) => k.host).sort()).toEqual(['example.org', 'zoho.eu']);
    expect(decodeFolderItem({ v: 2 })).toBeNull();
    expect(decodeFolderItem({ v: 1, f: [['bad'], [hex12(3), '', 'blue', 0, 1, 0]], k: [['Not A Host!', 'mail', 1], ['a.com', 'nope', 1]] })).toEqual({
      folders: [],
      kinds: [],
    });
    expect(encodeFolderItem({ folders: [], kinds: [] })).toBeNull();
  });

  it('fits in one Chrome sync item: the oldest deleted folders go first, then the oldest site kinds', () => {
    const folders = [
      ...Array.from({ length: 20 }, (_, i) => folder(i + 1, { name: `Live folder with a long name ${'x'.repeat(30)} ${i}` })),
      ...Array.from({ length: 40 }, (_, i) => folder(100 + i, { name: `Deleted ${'y'.repeat(40)} ${i}`, deletedAt: T0 + i * 1000 })),
    ];
    const kinds = Array.from({ length: 200 }, (_, i) => ({ host: `site-number-${i}.example.com`, kind: 'docs' as const, at: T0 + i * 1000 }));
    const item = encodeFolderItem({ folders, kinds })!;
    expect(itemBytes(FOLDERS_KEY, item)).toBeLessThanOrEqual(SYNC_LIMITS.quotaBytesPerItem);
    const back = decodeFolderItem(item)!;
    // Every live folder is there; deleted folders went before any site kind did.
    expect(back.folders.filter((f) => !f.deletedAt)).toHaveLength(20);
    expect(back.folders.filter((f) => f.deletedAt)).toHaveLength(0);
    expect(back.kinds.length).toBeGreaterThan(0);
    expect(back.kinds.length).toBeLessThan(200);
    const oldestKept = Math.min(...back.kinds.map((k) => k.at));
    expect(oldestKept).toBeGreaterThan(T0);
    // The records make room for it within the total quota.
    const packed = pack([], [], { floor: 0, folderItem: item });
    expect(packed.items[FOLDERS_KEY]).toEqual(item);
    expect(copyHash(packed.items)).not.toBe(packed.hash);
  });

  it('an unchanged copy without folders hashes as before 0.6', () => {
    const packed = pack([{ id: hex12(1), url: 'https://a.com', title: 'A', savedAt: T0, keywords: [] }], [], { floor: 0 });
    expect(copyHash(packed.items)).toBe((packed.items[META_KEY] as { h: string }).h);
  });

  it('merges per folder (newest change wins), keeps 30 days of deletions, and drops what was cleared', () => {
    const now = T0 + 60 * DAY;
    const local: FolderRecord[] = [
      { id: hex12(1), name: 'Mine renamed', color: 'red', order: 0, createdAt: T0, updatedAt: now - 1000, deletedAt: 0, shareId: 'share1', shareLive: true },
      { id: hex12(2), name: 'Old deleted', color: 'red', order: 1, createdAt: T0, updatedAt: T0, deletedAt: T0 },
    ];
    const remote = { folders: [folder(1, { name: 'Theirs', updatedAt: now - 5000 }), folder(3, { updatedAt: now - 2000 })], kinds: [] };
    const merged = mergeFolders({ folders: local, kinds: {}, removals: {} }, remote, now);
    expect(merged.drop).toEqual([hex12(2)]);
    expect(merged.write.map((f) => f.id)).toEqual([hex12(3)]);
    expect(merged.shared.folders.map((f) => [f.id, f.name])).toEqual([
      [hex12(1), 'Mine renamed'],
      [hex12(3), 'Folder 3'],
    ]);
    // A share is this computer's: it's never sent, and a folder from elsewhere keeps the local one.
    const theirsNewer = mergeFolders({ folders: local, kinds: {}, removals: {} }, { folders: [folder(1, { updatedAt: now })], kinds: [] }, now);
    expect(theirsNewer.write[0]).toMatchObject({ name: 'Folder 1', shareId: 'share1', shareLive: true, createdAt: T0 });
    expect(JSON.stringify(encodeFolderItem(theirsNewer.shared))).not.toContain('share1');
  });
});

// ---------------------------------------------------------------------------------------------
// Two computers sharing one chrome.storage.sync, with folders and site kinds

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

function memoryKinds(): SiteKindsStore & { value: { kinds: SiteKinds; removals: Record<string, number> } } {
  const store = {
    value: { kinds: {} as SiteKinds, removals: {} as Record<string, number> },
    get: async () => structuredClone(store.value),
    set: async (value: { kinds: SiteKinds; removals: Record<string, number> }) => {
      store.value = structuredClone(value);
    },
  };
  return store;
}

let dbCounter = 0;
let clock = Date.now();

class Computer {
  db: TabfoldDB;
  status: SyncRunResult['status'] | undefined;
  kinds = memoryKinds();
  /** A Free list: at most 500 tabs. */
  free = false;
  deps: SyncDeps;
  constructor(readonly name: string) {
    this.db = new TabfoldDB(`sync-folders-${name}-${dbCounter++}`);
    installPlacementStamp(this.db);
    this.deps = {
      database: this.db,
      area: chromeSyncArea,
      store: memoryStore(),
      deviceId: async () => `device-${name}`,
      enabled: async () => true,
      isWiped: async () => false,
      now: () => clock,
      siteKinds: this.kinds,
      room: async () => (this.free ? Math.max(0, FREE_LIMITS.tabs - (await countFoldedTabs(this.db))) : Number.POSITIVE_INFINITY),
    };
  }
  async fold(urls: string[]) {
    clock += 2000;
    return saveCapture([capturedWindow(urls)], { source: 'save-all', deviceId: `device-${this.name}`, now: clock }, { dedupe: true }, this.db);
  }
  async folder(name: string) {
    clock += 1000;
    return addFolder({ name }, { unlimited: true, now: clock }, this.db);
  }
  async move(urls: string[], folderId: string | null) {
    clock += 1000;
    const ids = (await this.tabs()).filter((t) => urls.includes(t.url)).map((t) => t.id);
    return setTabsFolder(ids, folderId, { now: clock }, this.db);
  }
  async sync(): Promise<SyncRunResult> {
    clock += 1000;
    const result = await syncOnce(this.deps, { previous: this.status });
    this.status = result.status;
    return result;
  }
  async tabs(): Promise<TabRecord[]> {
    return listFoldedTabs(this.db);
  }
  async placement(): Promise<Record<string, string | null>> {
    const folders = new Map((await this.db.folders.toArray()).map((f) => [f.id, f.name]));
    return Object.fromEntries((await this.tabs()).map((t) => [t.url, t.folderId ? (folders.get(t.folderId) ?? '?') : null]));
  }
  async liveFolders(): Promise<string[]> {
    return (await this.db.folders.where('deletedAt').equals(0).toArray()).map((f) => f.name).sort();
  }
}

async function settle(...computers: Computer[]) {
  for (let round = 0; round < 6; round += 1) {
    let wrote = false;
    for (const computer of computers) wrote = (await computer.sync()).wrote || wrote;
    if (!wrote) return round;
  }
  throw new Error('Computers kept writing to Chrome sync');
}

describe('folders between two computers', () => {
  let a: Computer;
  let b: Computer;
  beforeEach(() => {
    clock = Date.now();
    a = new Computer('a');
    b = new Computer('b');
  });

  it('a folder and the tabs in it reach the other computer, and an echo never writes again', async () => {
    await a.fold(['https://a.com', 'https://b.com', 'https://c.com']);
    const work = await a.folder('Work');
    await a.move(['https://a.com', 'https://b.com'], work.id);
    await settle(a, b);
    expect(await b.liveFolders()).toEqual(['Work']);
    expect(await b.placement()).toEqual({ 'https://a.com': 'Work', 'https://b.com': 'Work', 'https://c.com': null });
    expect(await settle(a, b)).toBe(0);

    // Moved out on B, later: A follows.
    await b.move(['https://b.com'], null);
    await settle(a, b);
    expect((await a.placement())['https://b.com']).toBeNull();
    // A rename travels too.
    clock += 1000;
    await a.db.folders.update(work.id, { name: 'Work stuff', updatedAt: clock });
    await settle(a, b);
    expect(await b.liveFolders()).toEqual(['Work stuff']);
  });

  it('rename on one computer, delete on the other: the later change wins everywhere', async () => {
    await a.fold(['https://a.com']);
    const f = await a.folder('Trip');
    await a.move(['https://a.com'], f.id);
    await settle(a, b);

    // A renames, then B deletes (later).
    clock += 1000;
    await a.db.folders.update(f.id, { name: 'Trip to Lisbon', updatedAt: clock });
    clock += 1000;
    await b.db.transaction('rw', b.db.folders, b.db.tabs, async () => {
      await b.db.folders.update(f.id, { deletedAt: clock, updatedAt: clock });
    });
    await settle(a, b);
    for (const c of [a, b]) {
      expect(await c.liveFolders()).toEqual([]);
      // Its tabs went back to their kind of site.
      expect(await c.placement()).toEqual({ 'https://a.com': null });
    }

    // Now the other order: a delete, then a later rename brings it back (empty).
    const g = await a.folder('Books');
    await settle(a, b);
    clock += 1000;
    await a.db.folders.update(g.id, { deletedAt: clock, updatedAt: clock });
    clock += 1000;
    await b.db.folders.update(g.id, { name: 'Books to read', updatedAt: clock });
    await settle(a, b);
    expect(await a.liveFolders()).toEqual(['Books to read']);
    expect(await b.liveFolders()).toEqual(['Books to read']);
  });

  it('sites moved to another kind, and put back, travel both ways', async () => {
    clock += 1000;
    a.kinds.value = { kinds: { 'zoho.eu': { kind: 'mail', at: clock } }, removals: {} };
    await settle(a, b);
    expect(b.kinds.value.kinds['zoho.eu']).toMatchObject({ kind: 'mail' });
    clock += 1000;
    b.kinds.value = { kinds: {}, removals: { 'zoho.eu': clock } };
    await settle(a, b);
    expect(a.kinds.value.kinds).toEqual({});
    expect(Object.keys(a.kinds.value.removals)).toEqual(['zoho.eu']);
    expect(await settle(a, b)).toBe(0);
  });

  it('a snooze travels with the tab, with the computer that snoozed it', async () => {
    await a.fold(['https://later.com']);
    await settle(a, b);
    const [tab] = await a.tabs();
    const until = clock + DAY + 123;
    await a.db.tabs.update(tab!.id, { snoozeUntil: until, snoozedOn: 'device-a' });
    // The stamp says when it changed (whole seconds in sync).
    expect((await a.db.tabs.get(tab!.id))!.placedAt).toBeGreaterThan(0);
    await settle(a, b);
    const [there] = await b.tabs();
    expect(there).toMatchObject({ snoozeUntil: toSyncTime(until), snoozedOn: 'device-a' });
    expect(await settle(a, b)).toBe(0);
  });

  it('a Free list takes only what fits; the rest waits in Chrome sync and comes in when there is room', async () => {
    a.free = true;
    await a.fold(Array.from({ length: 497 }, (_, i) => `https://mine${i}.com`));
    await b.fold(Array.from({ length: 5 }, (_, i) => `https://theirs${i}.com`));
    await b.sync();
    const result = await a.sync();
    expect(await countFoldedTabs(a.db)).toBe(500);
    expect(result.status).toMatchObject({ state: 'synced', waiting: 2 });
    await settle(a, b);
    // Nothing was lost on the way: B still has all of its tabs, and they're still shared.
    expect((await b.tabs()).filter((t) => t.url.startsWith('https://theirs'))).toHaveLength(5);
    expect(unpack(await chromeSyncArea.getAll()).records.filter((r) => r.url.startsWith('https://theirs'))).toHaveLength(5);
    expect(await settle(a, b)).toBe(0);

    // Room again: the waiting tabs come in.
    const old = (await a.tabs()).filter((t) => t.url.startsWith('https://mine')).slice(0, 2);
    await a.db.tabs.bulkDelete(old.map((t) => t.id));
    const session = (await a.db.sessions.toArray()).find((s) => s.tabCount === 497)!;
    await a.db.sessions.update(session.id, { tabCount: 495 });
    await a.db.meta.put({ key: 'searchVersion', value: 9999 });
    await settle(a, b);
    expect((await a.tabs()).filter((t) => t.url.startsWith('https://theirs'))).toHaveLength(5);
    expect(a.status?.waiting).toBeUndefined();
  });

  it('a plan with folders from an older copy (no tf.f) leaves the copy readable by older versions', async () => {
    await a.fold(['https://a.com']);
    await a.sync();
    const items = await chromeSyncArea.getAll();
    expect(items[FOLDERS_KEY]).toBeUndefined();
    const plan = planSync({ local: [], remote: unpack(items), known: {}, mine: {}, floor: 0, now: clock });
    expect(plan.folders).toBeNull();
    expect(plan.insert).toHaveLength(1);
  });
});
