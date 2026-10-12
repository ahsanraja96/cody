import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { route } from '@/lib/background/router';
import type { SiteKinds } from '@/lib/categories';
import { TabfoldDB } from '@/lib/db';
import { addFolder, installPlacementStamp } from '@/lib/folders';
import { DEVICE_TOKEN_KEY, peekDeviceToken, PROFILE_KEY } from '@/lib/pro/account';
import { refreshPlan, resetPlanRuntime } from '@/lib/pro/plan';
import { lastCheckoutAt, planState } from '@/lib/pro/state';
import { saveCapture } from '@/lib/repo';
import { chromeSyncArea, syncOnce, type SiteKindsStore, type SyncArea, type SyncDeps, type SyncRunResult } from '@/lib/sync/engine';
import { defaultSyncState, type SyncLocalState, type SyncStateStore } from '@/lib/sync/localState';
import { mergeFolders } from '@/lib/sync/merge';
import {
  CLOUD_LIMITS,
  copyHash,
  decodeFolderItem,
  decodeNoteItem,
  encodeNoteItem,
  FOLDERS_KEY,
  itemBytes,
  NOTES_KEY,
  pack,
  SYNC_LIMITS,
  toSyncTime,
  unpack,
  type SyncNote,
} from '@/lib/sync/records';
import type { FolderRecord } from '@/lib/types';
import { capturedWindow } from './fixtures';
import { EMAIL, giveToken, installPro, signedIn, type FakeServer } from './proServer';

// 1.0 sync: a folder's star in `tf.f` (field [6]) and folders' notes in `tf.n`, between two
// computers sharing one Chrome sync, an older version's copy, the team's copy; and deleting the
// Tabfold account.

const DAY = 24 * 60 * 60 * 1000;
const T0 = toSyncTime(Date.UTC(2026, 9, 1));
const hex12 = (n: number) => n.toString(16).padStart(12, '0');

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

function memoryKinds(): SiteKindsStore {
  let value = { kinds: {} as SiteKinds, removals: {} as Record<string, number> };
  return {
    get: async () => structuredClone(value),
    set: async (next) => {
      value = structuredClone(next);
    },
  };
}

let dbCounter = 0;
let clock = Date.now();

class Computer {
  db: TabfoldDB;
  status: SyncRunResult['status'] | undefined;
  deps: SyncDeps;
  constructor(
    readonly name: string,
    options: { area?: SyncArea; team?: { id: string; name: string } } = {},
  ) {
    this.db = new TabfoldDB(`v10-sync-${name}-${dbCounter++}`);
    installPlacementStamp(this.db);
    this.deps = {
      database: this.db,
      area: options.area ?? chromeSyncArea,
      store: memoryStore(),
      deviceId: async () => `device-${name}`,
      enabled: async () => true,
      isWiped: async () => false,
      now: () => clock,
      limits: options.area ? CLOUD_LIMITS : SYNC_LIMITS,
      ...(options.team ? { scope: async () => ({ team: options.team! }) } : { siteKinds: memoryKinds() }),
    };
  }
  async folder(name: string, extra: Partial<FolderRecord> = {}) {
    clock += 1000;
    const made = await addFolder({ name, ...(extra.teamId ? { teamId: extra.teamId } : {}) }, { unlimited: true, now: clock }, this.db);
    if (Object.keys(extra).length) await this.db.folders.update(made.id, extra);
    return (await this.db.folders.get(made.id))!;
  }
  async update(id: string, patch: Partial<FolderRecord>) {
    clock += 1000;
    await this.db.folders.update(id, patch);
  }
  async get(id: string) {
    return (await this.db.folders.get(id))!;
  }
  async sync(): Promise<SyncRunResult> {
    clock += 1000;
    const result = await syncOnce(this.deps, { previous: this.status });
    this.status = result.status;
    return result;
  }
}

async function settle(...computers: Computer[]) {
  for (let round = 0; round < 6; round += 1) {
    let wrote = false;
    for (const computer of computers) wrote = (await computer.sync()).wrote || wrote;
    if (!wrote) return round;
  }
  throw new Error('Computers kept writing');
}

/** A memory copy with versions, like the Tabfold server's (the account's or a team's). */
function memoryArea(): SyncArea & { items: Record<string, unknown> } {
  const area = {
    items: {} as Record<string, unknown>,
    checksVersion: true,
    async getAll() {
      return structuredClone(area.items);
    },
    async set(items: Record<string, unknown>) {
      Object.assign(area.items, structuredClone(items));
    },
    async remove(keys: string[]) {
      for (const key of keys) delete area.items[key];
    },
  };
  return area;
}

// ---------------------------------------------------------------------------------------------

describe('a folder’s star in tf.f', () => {
  let a: Computer;
  let b: Computer;
  beforeEach(() => {
    clock = Date.now();
    a = new Computer('a');
    b = new Computer('b');
  });

  it('travels as field [6] (only when starred), both ways, and an echo never writes again', async () => {
    const work = await a.folder('Work');
    await a.folder('Plain');
    await a.update(work.id, { starredAt: clock, updatedAt: clock });
    await settle(a, b);
    const raw = (await chromeSyncArea.getAll())[FOLDERS_KEY] as { f: unknown[][] };
    expect(raw.f.find((f) => f[0] === work.id)).toHaveLength(7);
    expect(raw.f.find((f) => f[0] !== work.id)).toHaveLength(6);
    expect((await b.get(work.id)).starredAt).toBeGreaterThan(0);
    expect(await settle(a, b)).toBe(0);

    // Unstarred on B, later: A follows.
    await b.update(work.id, { starredAt: 0, updatedAt: clock });
    await settle(a, b);
    expect((await a.get(work.id)).starredAt ?? 0).toBe(0);
    expect(await settle(a, b)).toBe(0);
  });

  it('an older version that wrote the folder back without its star doesn’t take turns rewriting it', async () => {
    const work = await a.folder('Work');
    await a.update(work.id, { starredAt: clock, updatedAt: clock });
    await settle(a, b);
    // 0.6 knows six fields: it writes the same folder back without [6].
    const items = await chromeSyncArea.getAll();
    const item = items[FOLDERS_KEY] as { v: 1; f: unknown[][]; k: unknown[] };
    await fakeBrowser.storage.sync.set({ [FOLDERS_KEY]: { ...item, f: item.f.map((f) => f.slice(0, 6)) } });
    const run = await a.sync();
    expect(run.wrote).toBe(false);
    // The star stays here.
    expect((await a.get(work.id)).starredAt).toBeGreaterThan(0);
    expect(await settle(a, b)).toBe(0);
  });

  it('decodes the star, and drops a malformed one on its own', () => {
    expect(decodeFolderItem({ v: 1, f: [[hex12(1), 'A', 'blue', 0, 5, 0, 9]], k: [] })!.folders[0]).toMatchObject({ starredAt: 9000 });
    expect(decodeFolderItem({ v: 1, f: [[hex12(1), 'A', 'blue', 0, 5, 0, 'x']], k: [] })!.folders[0]).not.toHaveProperty('starredAt');
  });
});

describe('folders’ notes in tf.n', () => {
  let a: Computer;
  let b: Computer;
  beforeEach(() => {
    clock = Date.now();
    a = new Computer('a');
    b = new Computer('b');
  });

  it('reach the other computer, the newest note wins, and a removal travels too', async () => {
    const work = await a.folder('Work');
    await a.update(work.id, { note: 'Waiting on the client', noteAt: clock });
    await settle(a, b);
    expect(await b.get(work.id)).toMatchObject({ note: 'Waiting on the client', noteAt: toSyncTime((await a.get(work.id)).noteAt!) });
    // The note isn't a change to the folder: its updatedAt stays.
    expect((await b.get(work.id)).updatedAt).toBe(toSyncTime((await a.get(work.id)).updatedAt));
    expect(await settle(a, b)).toBe(0);

    // Both change it; B's is later.
    await a.update(work.id, { note: 'From A', noteAt: clock });
    await b.update(work.id, { note: 'From B', noteAt: clock });
    await settle(a, b);
    expect((await a.get(work.id)).note).toBe('From B');
    expect((await b.get(work.id)).note).toBe('From B');

    // Removed on A ('' keeps when): B's goes too.
    await a.update(work.id, { note: '', noteAt: clock });
    await settle(a, b);
    expect((await b.get(work.id)).note).toBe('');
    expect(await settle(a, b)).toBe(0);
  });

  it('a note may arrive with a folder new to this computer', async () => {
    const trip = await a.folder('Trip');
    await a.update(trip.id, { note: 'Book the flat', noteAt: clock });
    await settle(a, b);
    expect(await b.get(trip.id)).toMatchObject({ name: 'Trip', note: 'Book the flat' });
  });

  it('when they don’t fit in one item, the oldest are left out (and stay on the computer that has them)', async () => {
    const long = 'é'.repeat(140);
    for (let i = 0; i < 40; i += 1) {
      const f = await a.folder(`Folder ${i}`);
      await a.update(f.id, { note: `${i} ${long}`.slice(0, 140), noteAt: T0 + i * 1000 });
    }
    await settle(a, b);
    const item = (await chromeSyncArea.getAll())[NOTES_KEY];
    expect(itemBytes(NOTES_KEY, item)).toBeLessThanOrEqual(SYNC_LIMITS.quotaBytesPerItem);
    const shared = decodeNoteItem(item)!;
    expect(shared.length).toBeGreaterThan(5);
    expect(shared.length).toBeLessThan(40);
    const oldestShared = Math.min(...shared.map((n) => n.noteAt));
    expect(oldestShared).toBeGreaterThan(T0);
    // A keeps all of its notes; B has the ones shared.
    expect((await a.db.folders.toArray()).filter((f) => f.note).length).toBe(40);
    expect((await b.db.folders.toArray()).filter((f) => f.note).length).toBe(shared.length);
    expect(await settle(a, b)).toBe(0);
  });

  it('an older version removing tf.n: not written back for that alone; back with the next change or a new note', async () => {
    const work = await a.folder('Work');
    await a.update(work.id, { note: 'Keep me', noteAt: clock });
    await settle(a, b);
    // 0.6 removes keys it doesn't know whenever it writes.
    await fakeBrowser.storage.sync.remove(NOTES_KEY);
    expect((await a.sync()).wrote).toBe(false);
    expect((await chromeSyncArea.getAll())[NOTES_KEY]).toBeUndefined();
    expect(await settle(a, b)).toBe(0);
    // The next real change carries it again.
    await saveCapture([capturedWindow(['https://new.com'])], { source: 'save-all', deviceId: 'device-a', now: clock }, { dedupe: true }, a.db);
    await settle(a, b);
    expect(decodeNoteItem((await chromeSyncArea.getAll())[NOTES_KEY])).toEqual([{ folderId: work.id, note: 'Keep me', noteAt: toSyncTime((await a.get(work.id)).noteAt!) }]);
    // A new note goes at once.
    await fakeBrowser.storage.sync.remove(NOTES_KEY);
    await a.update(work.id, { note: 'Changed', noteAt: clock });
    expect((await a.sync()).wrote).toBe(true);
    expect(decodeNoteItem((await chromeSyncArea.getAll())[NOTES_KEY])![0]!.note).toBe('Changed');
    expect(await settle(a, b)).toBe(0);
  });

  it('round-trip, budget and hash of the item', () => {
    const notes: SyncNote[] = [
      { folderId: hex12(2), note: 'Second', noteAt: T0 + 2000 },
      { folderId: hex12(1), note: '', noteAt: T0 + 1000 },
    ];
    const item = encodeNoteItem(notes)!;
    expect(item).toEqual({ v: 1, n: [[hex12(1), '', T0 / 1000 + 1], [hex12(2), 'Second', T0 / 1000 + 2]] });
    expect(encodeNoteItem([...notes].reverse())).toEqual(item);
    expect(decodeNoteItem(item)!.sort((x, y) => x.noteAt - y.noteAt)).toEqual([...notes].reverse());
    expect(decodeNoteItem({ v: 1, n: [['bad', 'x', 1], [hex12(3), 7, 1], [hex12(3), 'x', -1]] })).toEqual([]);
    expect(encodeNoteItem([])).toBeNull();
    // The account's copy holds every note.
    const many = Array.from({ length: 500 }, (_, i) => ({ folderId: hex12(i + 1), note: 'n'.repeat(140), noteAt: T0 + i }));
    expect(encodeNoteItem(many, CLOUD_LIMITS)!.n).toHaveLength(500);
    expect(encodeNoteItem(many, SYNC_LIMITS)!.n.length).toBeLessThan(500);
    // tf.n takes room from the records, and joins the copy's fingerprint.
    const packed = pack([], [], { floor: 0, extras: { noteItem: item } });
    expect(packed.items[NOTES_KEY]).toEqual(item);
    expect(copyHash(packed.items)).not.toBe(copyHash(pack([], [], { floor: 0 }).items));
    expect(unpack(packed.items).notes).toHaveLength(2);
  });

  it('a removal is shared for 30 days, and only live folders’ notes are shared', () => {
    const now = T0 + 60 * DAY;
    const local: FolderRecord[] = [
      { id: hex12(1), name: 'Live', color: 'blue', order: 0, createdAt: T0, updatedAt: T0, deletedAt: 0, note: '', noteAt: now - 40 * DAY },
      { id: hex12(2), name: 'Live 2', color: 'blue', order: 1, createdAt: T0, updatedAt: T0, deletedAt: 0, note: '', noteAt: now - DAY },
      { id: hex12(3), name: 'Gone', color: 'blue', order: 2, createdAt: T0, updatedAt: now - DAY, deletedAt: now - DAY, note: 'Old', noteAt: now - DAY },
    ];
    const merged = mergeFolders({ folders: local, kinds: {}, removals: {} }, null, now);
    expect(merged.notes.map((n) => n.folderId)).toEqual([hex12(2)]);
  });
});

describe('the team’s copy', () => {
  it('carries the team folders’ notes but never anyone’s star', async () => {
    clock = Date.now();
    const area = memoryArea();
    const team = { id: 'team1', name: 'Truewidgets' };
    const a = new Computer('team-a', { area, team });
    const b = new Computer('team-b', { area, team });
    const launch = await a.folder('Launch', { teamId: 'team1' });
    // Even if a star were on a team folder's row here, it stays here.
    await a.update(launch.id, { starredAt: clock, note: 'Ship on Friday', noteAt: clock });
    await settle(a, b);
    const raw = area.items[FOLDERS_KEY] as { f: unknown[][] };
    expect(raw.f[0]).toHaveLength(6);
    expect(await b.get(launch.id)).toMatchObject({ teamId: 'team1', note: 'Ship on Friday' });
    expect((await b.get(launch.id)).starredAt ?? 0).toBe(0);
    expect(await settle(a, b)).toBe(0);
  });

  it('a person’s own copy leaves team folders’ notes out', async () => {
    clock = Date.now();
    const a = new Computer('own-a');
    const team = await a.folder('Launch', { teamId: 'team1' });
    await a.update(team.id, { note: 'Team only', noteAt: clock });
    const mine = await a.folder('Mine');
    await a.update(mine.id, { note: 'Mine', noteAt: clock });
    await saveCapture([capturedWindow(['https://a.com'])], { source: 'save-all', deviceId: 'device-own-a', now: clock }, { dedupe: true }, a.db);
    await a.sync();
    expect(decodeNoteItem((await chromeSyncArea.getAll())[NOTES_KEY])!.map((n) => n.note)).toEqual(['Mine']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('Delete my Tabfold account', () => {
  let server: FakeServer;
  let restore: () => void;
  beforeEach(() => {
    ({ server, restore } = installPro());
  });
  afterEach(() => restore());

  it('asks the server with the typed email, then signs this computer out (the folded tabs stay)', async () => {
    await signedIn(server, 'pro');
    await fakeBrowser.storage.sync.set({ [PROFILE_KEY]: 'profile-key-'.padEnd(43, 'b') });
    await saveCapture([capturedWindow(['https://a.com'])], { source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: false });
    server.overrides.set('POST /account/delete', { status: 200, body: { ok: true } });
    expect(await route({ type: 'account-delete', confirm: `  ${EMAIL.toUpperCase()} ` })).toEqual({ ok: true, data: { deleted: true } });
    const request = server.requests.find((r) => r.path === '/account/delete')!;
    expect(request).toMatchObject({ method: 'POST', body: { confirm: EMAIL.toUpperCase() } });
    expect(await planState.get()).toMatchObject({ tier: 'free', email: null });
    expect((await fakeBrowser.storage.local.get(DEVICE_TOKEN_KEY))[DEVICE_TOKEN_KEY]).toBeUndefined();
    expect((await fakeBrowser.storage.sync.get(PROFILE_KEY))[PROFILE_KEY]).toBeUndefined();
    const { db } = await import('@/lib/db');
    expect(await db.tabs.count()).toBe(1);
  });

  it('a typo is caught before asking; the server’s refusal reads like other Pro errors', async () => {
    await signedIn(server, 'pro');
    expect(await route({ type: 'account-delete', confirm: 'someone@else.com' })).toMatchObject({ ok: false, code: 'confirm-mismatch', error: 'Type your account’s email to confirm.' });
    expect(server.requests.some((r) => r.path === '/account/delete')).toBe(false);
    server.overrides.set('POST /account/delete', { status: 400, body: { error: 'invalid', message: 'Type your account’s email to confirm.' } });
    expect(await route({ type: 'account-delete', confirm: EMAIL })).toMatchObject({ ok: false, error: 'Type your account’s email to confirm.' });
    expect((await planState.get()).email).toBe(EMAIL);
  });

  it('needs to be signed in', async () => {
    expect(await route({ type: 'account-delete', confirm: EMAIL })).toMatchObject({ ok: false, code: 'not-signed-in' });
  });
});

describe('signed out from elsewhere (the account deleted on another computer)', () => {
  let server: FakeServer;
  let restore: () => void;
  beforeEach(() => {
    ({ server, restore } = installPro());
  });
  afterEach(() => restore());

  it('drops its device token when the server no longer knows it, and asks nothing more', async () => {
    await signedIn(server, 'pro');
    // Deleted elsewhere: the server forgets every computer of the account.
    server.tokens.clear();
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'free', email: null });
    expect(await peekDeviceToken()).toBeNull();
    const asked = server.requests.length;
    resetPlanRuntime();
    await refreshPlan({ force: true });
    expect(server.requests).toHaveLength(asked);
  });

  it('keeps a token a checkout from here may still sign in (a day), or a payment waiting for a code', async () => {
    const token = await giveToken();
    await lastCheckoutAt.set(Date.now());
    await refreshPlan({ force: true });
    expect(await peekDeviceToken()).toBe(token);

    await lastCheckoutAt.set(Date.now() - 25 * 60 * 60_000);
    server.paidElsewhere.set(token, 'someone@example.com');
    resetPlanRuntime();
    await refreshPlan({ force: true });
    expect(await peekDeviceToken()).toBe(token);

    server.paidElsewhere.clear();
    resetPlanRuntime();
    await refreshPlan({ force: true });
    expect(await peekDeviceToken()).toBeNull();
  });

  it('a computer that never signed in still asks nothing', async () => {
    await refreshPlan({ force: true });
    expect(server.requests).toHaveLength(0);
  });
});
