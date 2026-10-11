import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { route } from '@/lib/background/router';
import { categorize } from '@/lib/categories';
import { bumpSearchVersion, db, getSearchVersion } from '@/lib/db';
import { exportCsv, exportHtml, exportJson, exportMarkdown, type TabfoldJsonExport } from '@/lib/exporters';
import {
  cleanFolderName,
  countFoldedTabs,
  installPlacementStamp,
  isFolderId,
  listFullError,
  listRoom,
  migrateProjectsToFolders,
  projectFolderId,
  purgeDeletedFolders,
  quietPlacement,
  siteKindRemovals,
  throwIfNoRoom,
} from '@/lib/folders';
import { parseBookmarksHtml } from '@/lib/importers';
import type { Command, CommandResponse, CommandResults } from '@/lib/messages';
import { planState, projectsState } from '@/lib/pro/state';
import { FREE_PLAN } from '@/lib/pro/types';
import { exportGraphs, importSessions, listFoldedTabs, restoreRecords, saveCapture } from '@/lib/repo';
import { getSettings, updateSettings } from '@/lib/settings';
import { siteKinds } from '@/lib/state';
import type { FolderRecord, SessionRecord, TabRecord } from '@/lib/types';
import { capturedWindow } from './fixtures';

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

async function send<C extends Command>(command: C): Promise<CommandResults[C['type']]> {
  const response = (await route(command)) as CommandResponse<CommandResults[C['type']]>;
  if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code, details: response.details });
  return response.data;
}

async function fails(command: Command): Promise<{ error: string; code?: string; details?: Record<string, number> }> {
  const response = await route(command);
  if (response.ok) throw new Error(`${command.type} should have failed`);
  return response;
}

async function fold(urls: string[], now = Date.now(), name?: string) {
  return saveCapture([capturedWindow(urls)], { name, source: 'save-all', deviceId: 'd', now }, { dedupe: false });
}

async function tab(url: string): Promise<TabRecord> {
  return (await db.tabs.where('url').equals(url).first())!;
}

const paid = () => planState.set({ ...FREE_PLAN, tier: 'pro', checkedAt: Date.now() });

describe('folders', () => {
  it('makes a folder last in the left column, with a 12-character id and a tidy name', async () => {
    const { folder } = await send({ type: 'folder-create', name: '  Holiday   in\nLisbon  ' });
    expect(folder).toMatchObject({ name: 'Holiday in Lisbon', order: 0, deletedAt: 0, source: 'person', color: 'blue' });
    expect(isFolderId(folder.id)).toBe(true);
    const second = (await send({ type: 'folder-create', name: 'Work', color: 'green' })).folder;
    expect(second).toMatchObject({ order: 1, color: 'green' });
    // Duplicate names are allowed; names are cut to 60 characters, never empty.
    expect((await send({ type: 'folder-create', name: 'Work' })).folder.id).not.toBe(second.id);
    expect(cleanFolderName('x'.repeat(80))).toHaveLength(60);
    expect(cleanFolderName('   ')).toBeNull();
    expect(await fails({ type: 'folder-create', name: '  ' })).toMatchObject({ code: 'invalid-name' });
  });

  it('Free has 3 live folders; paid plans have no limit; a deleted folder frees its place', async () => {
    for (const name of ['A', 'B', 'C']) await send({ type: 'folder-create', name });
    expect(await fails({ type: 'folder-create', name: 'D' })).toMatchObject({ code: 'folder-limit', details: { limit: 3 } });
    const [a] = await db.folders.toArray();
    await send({ type: 'folder-delete', id: a!.id });
    await send({ type: 'folder-create', name: 'D' });
    await paid();
    await send({ type: 'folder-create', name: 'E' });
    expect(await db.folders.where('deletedAt').equals(0).count()).toBe(4);
  });

  it('a new folder can take tabs with it', async () => {
    const { savedTabIds } = await fold(['https://a.com', 'https://b.com']);
    const { folder } = await send({ type: 'folder-create', name: 'Pair', tabRecordIds: savedTabIds });
    expect((await listFoldedTabs()).map((t) => t.folderId)).toEqual([folder.id, folder.id]);
  });

  it('renames, recolours and reorders', async () => {
    const a = (await send({ type: 'folder-create', name: 'A' })).folder;
    const b = (await send({ type: 'folder-create', name: 'B' })).folder;
    const c = (await send({ type: 'folder-create', name: 'C' })).folder;
    const renamed = (await send({ type: 'folder-update', id: a.id, name: ' Alpha ', color: 'red' })).folder;
    expect(renamed).toMatchObject({ name: 'Alpha', color: 'red' });
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect(await fails({ type: 'folder-update', id: a.id, color: 'black' as never })).toMatchObject({ code: 'invalid-color' });
    expect(await fails({ type: 'folder-update', id: a.id, name: '' })).toMatchObject({ code: 'invalid-name' });
    expect(await fails({ type: 'folder-update', id: 'nope00000000', name: 'X' })).toMatchObject({ code: 'not-found' });

    await send({ type: 'folder-reorder', ids: [c.id, a.id] });
    const order = (await db.folders.toArray()).sort((x, y) => x.order - y.order).map((f) => f.name);
    expect(order).toEqual(['C', 'Alpha', 'B']);
  });

  it('deleting a folder sends its tabs back to their kind of site, and Undo brings both back', async () => {
    installPlacementStamp(db);
    const { savedTabIds } = await fold(['https://github.com/a', 'https://youtube.com/b', 'https://c.com']);
    const { folder } = await send({ type: 'folder-create', name: 'Mixed', tabRecordIds: savedTabIds.slice(0, 2) });
    const deleted = await send({ type: 'folder-delete', id: folder.id });
    expect(deleted.tabs).toBe(2);
    expect(deleted.actionId).toBeTruthy();
    expect((await db.folders.get(folder.id))!.deletedAt).toBeGreaterThan(0);
    const out = await db.tabs.bulkGet(savedTabIds);
    expect(out.map((t) => t!.folderId)).toEqual([undefined, undefined, undefined]);
    expect(out[0]!.placedAt).toBeGreaterThan(0);
    expect(await fails({ type: 'folder-delete', id: folder.id })).toMatchObject({ code: 'not-found' });

    expect(await send({ type: 'undo', actionId: deleted.actionId! })).toEqual({ undone: true });
    expect((await db.folders.get(folder.id))!.deletedAt).toBe(0);
    expect((await db.tabs.bulkGet(savedTabIds)).map((t) => t!.folderId)).toEqual([folder.id, folder.id, undefined]);
    // Once only.
    expect(await send({ type: 'undo', actionId: deleted.actionId! })).toMatchObject({ undone: false });
  });

  it('folders deleted more than 30 days ago are dropped for good', async () => {
    const now = Date.now();
    const a = (await send({ type: 'folder-create', name: 'Old' })).folder;
    const b = (await send({ type: 'folder-create', name: 'Recent' })).folder;
    await send({ type: 'folder-create', name: 'Live' });
    await db.folders.update(a.id, { deletedAt: now - 31 * DAY });
    await db.folders.update(b.id, { deletedAt: now - 29 * DAY });
    expect(await purgeDeletedFolders(now)).toBe(1);
    expect((await db.folders.toArray()).map((f) => f.name).sort()).toEqual(['Live', 'Recent']);
  });

  it('moves tabs into a folder and out again, with Undo', async () => {
    installPlacementStamp(db);
    const { savedTabIds } = await fold(['https://a.com', 'https://b.com']);
    const { folder } = await send({ type: 'folder-create', name: 'F' });
    const moved = await send({ type: 'tabs-move', tabRecordIds: savedTabIds, folderId: folder.id });
    expect(moved.moved).toBe(2);
    // Already there: nothing moves, nothing to undo.
    expect(await send({ type: 'tabs-move', tabRecordIds: savedTabIds, folderId: folder.id })).toEqual({ moved: 0, actionId: null });
    const out = await send({ type: 'tabs-move', tabRecordIds: [savedTabIds[0]!], folderId: null });
    expect((await db.tabs.get(savedTabIds[0]!))!.folderId).toBeUndefined();
    await send({ type: 'undo', actionId: out.actionId! });
    expect((await db.tabs.get(savedTabIds[0]!))!.folderId).toBe(folder.id);
    // One Undo at a time (as with a fold): the newest change.
    expect(await send({ type: 'undo', actionId: moved.actionId! })).toMatchObject({ undone: false });
    expect(await fails({ type: 'tabs-move', tabRecordIds: savedTabIds, folderId: 'zzzzzzzzzzzz' })).toMatchObject({ code: 'not-found' });
  });

  it('a change to a tab’s folder or snooze is stamped with when it happened, and sync notices it', async () => {
    installPlacementStamp(db);
    const { savedTabIds } = await fold(['https://a.com']);
    const id = savedTabIds[0]!;
    const before = await getSearchVersion();
    // A writer that doesn't say when (as a snooze or a live folder does).
    await db.tabs.update(id, { snoozeUntil: Date.now() + DAY, snoozedOn: 'device-a' });
    const stamped = await db.tabs.get(id);
    expect(stamped!.placedAt).toBeGreaterThan(0);
    await vi.waitFor(async () => expect(await getSearchVersion()).toBeGreaterThan(before));
    // Writes that carry their own time (sync) keep it.
    await db.transaction('rw', db.tabs, async () => {
      quietPlacement();
      await db.tabs.update(id, { folderId: 'abcdefabcdef' });
    });
    expect((await db.tabs.get(id))!.placedAt).toBe(stamped!.placedAt);
    await db.tabs.update(id, { title: 'Renamed' });
    expect((await db.tabs.get(id))!.placedAt).toBe(stamped!.placedAt);
  });
});

describe('kinds of site', () => {
  it('moves a site (and its subdomains) to another kind, counts its tabs, and Undo puts it back', async () => {
    await fold(['https://mail.zoho.eu/inbox', 'https://www.mail.zoho.eu/x', 'https://notes.example.org/1', 'https://example.org/2']);
    const moved = await send({ type: 'site-kind-set', host: 'example.org', kind: 'docs' });
    expect(moved.tabs).toBe(2);
    expect((await siteKinds.get())['example.org']).toMatchObject({ kind: 'docs' });
    expect(categorize('https://notes.example.org/1', await siteKinds.get())).toBe('docs');
    await send({ type: 'undo', actionId: moved.actionId! });
    expect(await siteKinds.get()).toEqual({});

    // Moving a site to the kind it has anyway changes nothing.
    expect(await send({ type: 'site-kind-set', host: 'www.mail.zoho.eu', kind: 'mail' })).toEqual({ tabs: 2, actionId: null });
    expect(await siteKinds.get()).toEqual({});

    // Putting a moved site back is remembered (so other computers put it back too), with Undo.
    await send({ type: 'site-kind-set', host: 'https://www.Example.org:8080/page', kind: 'reading' });
    expect(Object.keys(await siteKinds.get())).toEqual(['example.org']);
    const back = await send({ type: 'site-kind-set', host: 'example.org', kind: null });
    expect(await siteKinds.get()).toEqual({});
    expect(Object.keys(await siteKindRemovals.get())).toEqual(['example.org']);
    await send({ type: 'undo', actionId: back.actionId! });
    expect((await siteKinds.get())['example.org']).toMatchObject({ kind: 'reading' });
    expect(await siteKindRemovals.get()).toEqual({});

    expect(await fails({ type: 'site-kind-set', host: 'example.org', kind: 'nope' as never })).toMatchObject({ code: 'invalid-kind' });
    expect(await fails({ type: 'site-kind-set', host: '   ', kind: 'dev' })).toMatchObject({ code: 'invalid-host' });
  });
});

describe('the free list’s limit', () => {
  async function filler(tabs: number, createdAt = Date.now() - 1000): Promise<void> {
    const session: SessionRecord = {
      id: `filler-${tabs}-${createdAt}`,
      name: 'Old fold',
      tags: [],
      pinned: 0,
      color: null,
      kind: 'session',
      source: 'save-all',
      createdAt,
      updatedAt: createdAt,
      deletedAt: 0,
      deviceId: 'd',
      version: 1,
      tabCount: tabs,
      windowCount: 1,
      preview: [],
    };
    await db.sessions.add(session);
  }

  it('counts folded tabs (snoozed ones too) and says how much room is left', async () => {
    await filler(480);
    await fold(['https://a.com', 'https://b.com']);
    expect(await countFoldedTabs()).toBe(482);
    expect(await listRoom()).toEqual({ tabs: 482, limit: 500, room: 18 });
    await expect(throwIfNoRoom(18)).resolves.toMatchObject({ room: 18 });
    await expect(throwIfNoRoom(23)).rejects.toMatchObject({
      code: 'list-full',
      details: { room: 18, needed: 23, limit: 500 },
      message: 'This needs room for 23 tabs; your free list has room for 18.',
    });
    await filler(18);
    await expect(throwIfNoRoom(1)).rejects.toMatchObject({ message: 'Your free list is full (500 tabs). Make room or upgrade for unlimited.' });
    expect(listFullError(0, 3).details).toEqual({ room: 0, needed: 3, limit: 500 });
    await paid();
    expect(await listRoom()).toEqual({ tabs: 500, limit: null, room: Number.POSITIVE_INFINITY });
    await expect(throwIfNoRoom(10_000)).resolves.toBeTruthy();
  });

  it('Make room lists the oldest folds first and what was folded more than 60 days ago', async () => {
    const now = Date.now();
    const old = await fold(['https://old1.com', 'https://old2.com'], now - 90 * DAY, 'Old');
    await fold(['https://mid.com'], now - 30 * DAY, 'Mid');
    await fold(['https://new.com'], now, 'New');
    // A snoozed old tab waits to come back: "older than" leaves it.
    await db.tabs.update(old.savedTabIds[1]!, { snoozeUntil: now + DAY });
    const list = await send({ type: 'room-list' });
    expect(list).toMatchObject({ tabs: 4, limit: 500, olderThan: { days: 60, tabs: 1 } });
    expect(list.folds.map((f) => [f.name, f.tabCount, f.windowCount])).toEqual([
      ['Old', 2, 1],
      ['Mid', 1, 1],
      ['New', 1, 1],
    ]);

    const freed = await send({ type: 'room-free', olderThanDays: 60 });
    expect(freed.removed).toBe(1);
    expect((await listFoldedTabs()).map((t) => t.url).sort()).toEqual(['https://mid.com', 'https://new.com', 'https://old2.com']);
    await send({ type: 'undo', actionId: freed.actionId! });
    expect(await listFoldedTabs()).toHaveLength(4);

    const mid = list.folds[1]!.sessionId;
    const removed = await send({ type: 'room-free', sessionIds: [mid, 'gone'] });
    expect(removed.removed).toBe(1);
    expect((await db.sessions.get(mid))!.deletedAt).toBeGreaterThan(0);
    await send({ type: 'undo', actionId: removed.actionId! });
    expect((await db.sessions.get(mid))!.deletedAt).toBe(0);
    expect(await send({ type: 'room-free' })).toEqual({ removed: 0, actionId: null });
  });

  it('tabs in folders are tabs too: Make room removes them, and Undo puts them back in their folder', async () => {
    const now = Date.now();
    const old = await fold(['https://old.com'], now - 100 * DAY);
    const { folder } = await send({ type: 'folder-create', name: 'Keep', tabRecordIds: old.savedTabIds });
    const freed = await send({ type: 'room-free', olderThanDays: 60 });
    expect(freed.removed).toBe(1);
    await send({ type: 'undo', actionId: freed.actionId! });
    expect((await tab('https://old.com')).folderId).toBe(folder.id);
  });
});

describe('the same page twice', () => {
  it('lists pages folded more than once and keeps the newest copy, moved into an older copy’s folder', async () => {
    const now = Date.now();
    const first = await fold(['https://dup.com/page', 'https://twice.com'], now - 3000);
    await fold(['https://dup.com/page/', 'https://once.com'], now - 2000);
    const third = await fold(['https://dup.com/page', 'https://twice.com/'], now - 1000);
    const { folder } = await send({ type: 'folder-create', name: 'Research', tabRecordIds: [first.savedTabIds[0]!] });
    // A snoozed copy is left alone; an Incognito copy isn't the same tab.
    const snoozed = await fold(['https://dup.com/page'], now);
    await db.tabs.update(snoozed.savedTabIds[0]!, { snoozeUntil: now + DAY });
    await saveCapture([{ ...capturedWindow(['https://twice.com']), incognito: true }], { source: 'save-all', deviceId: 'd', now }, { dedupe: false });

    const { groups } = await send({ type: 'duplicates-list' });
    expect(groups.map((g) => [g.url, g.tabRecordIds.length]).sort()).toEqual([
      ['https://dup.com/page', 3],
      ['https://twice.com/', 2],
    ]);
    expect(groups.find((g) => g.url === 'https://dup.com/page')!.tabRecordIds[0]).toBe(third.savedTabIds[0]);

    const result = await send({ type: 'duplicates-remove', urls: ['https://dup.com/page/'] });
    expect(result.removed).toBe(2);
    const dupCopies = async () => (await listFoldedTabs()).filter((t) => t.url.startsWith('https://dup.com') && !t.snoozeUntil);
    expect((await dupCopies()).map((t) => [t.id, t.folderId])).toEqual([[third.savedTabIds[0], folder.id]]);
    expect((await send({ type: 'duplicates-list' })).groups).toHaveLength(1);

    await send({ type: 'undo', actionId: result.actionId! });
    const back = await dupCopies();
    expect(back).toHaveLength(3);
    expect(back.find((t) => t.id === third.savedTabIds[0])!.folderId).toBeUndefined();
    expect(back.find((t) => t.id === first.savedTabIds[0])!.folderId).toBe(folder.id);

    expect((await send({ type: 'duplicates-remove' })).removed).toBe(3);
    expect(await send({ type: 'duplicates-remove' })).toEqual({ removed: 0, actionId: null });
  });
});

describe('moving AI projects into folders (once)', () => {
  it('every project becomes a folder with its tabs, By site comes back, and running again changes nothing', async () => {
    const { savedTabIds } = await fold(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com']);
    await db.tabs.update(savedTabIds[0]!, { project: 'Checkout app' });
    await db.tabs.update(savedTabIds[1]!, { project: 'Checkout app' });
    await db.tabs.update(savedTabIds[2]!, { project: 'Old one' });
    await projectsState.set({ projects: [{ name: 'Checkout app', color: 'purple' }, { name: 'Empty project', color: 'green' }], organisedAt: 1 });
    await updateSettings({ groupBy: 'project' });
    // Free already has 3 folders: projects aren't limited (nothing is taken away).
    for (const name of ['X', 'Y', 'Z']) await send({ type: 'folder-create', name });

    expect(await migrateProjectsToFolders()).toEqual({ folders: 3, tabs: 3 });
    const folders = (await db.folders.toArray()).filter((f) => f.source === 'ai');
    expect(folders.map((f) => [f.name, f.color]).sort()).toEqual([
      ['Checkout app', 'purple'],
      ['Empty project', 'green'],
      ['Old one', expect.any(String)],
    ]);
    const checkout = folders.find((f) => f.name === 'Checkout app')!;
    expect(checkout.id).toBe(projectFolderId('Checkout app'));
    const rows = await db.tabs.bulkGet(savedTabIds);
    expect(rows.map((t) => t!.folderId)).toEqual([checkout.id, checkout.id, projectFolderId('Old one'), undefined]);
    expect(rows.some((t) => t!.project !== undefined)).toBe(false);
    expect((await getSettings()).groupBy).toBe('site');
    expect(await projectsState.get()).toEqual({ projects: [], organisedAt: 0 });

    expect(await migrateProjectsToFolders()).toBeNull();
    await db.meta.delete('foldersMigrated');
    expect(await migrateProjectsToFolders()).toEqual({ folders: 0, tabs: 0 });
    expect(await db.folders.count()).toBe(6);
  });

  it('two computers that both had a project end up with one folder (the same id)', () => {
    expect(projectFolderId('Checkout app')).toBe(projectFolderId(' checkout APP '));
    expect(isFolderId(projectFolderId('Checkout app'))).toBe(true);
  });
});

describe('imports into folders', () => {
  const collections = (names: string[], urls: (i: number) => string[]) =>
    names.map((name, i) => ({ name, createdAt: null, windows: [capturedWindow(urls(i))] }));

  it('each collection becomes a folder while Free allows; the rest go by site; repeats are left out', async () => {
    const { folder: existing } = await send({ type: 'folder-create', name: 'Reading' });
    await fold(['https://already.com']);
    const result = await importSessions(
      collections(['reading', 'Work', 'Travel', 'Recipes'], (i) => [`https://site${i}.com`, 'https://already.com', `https://shared.com`]),
      { deviceId: 'd', asFolders: true },
    );
    expect(result).toEqual({ sessions: 4, tabs: 5, intoUnsorted: 0, folders: 3, skippedOverLimit: 0, withoutFolder: 1, duplicates: 4 + 3 });
    const live = await db.folders.where('deletedAt').equals(0).toArray();
    expect(live.map((f) => [f.name, f.source]).sort()).toEqual([
      ['Reading', 'person'],
      ['Travel', 'import'],
      ['Work', 'import'],
    ]);
    // "reading" went into the folder already called Reading.
    expect((await tab('https://site0.com')).folderId).toBe(existing.id);
    expect((await tab('https://site3.com')).folderId).toBeUndefined();
  });

  it('stops at the free list’s 500 tabs and says how many were left out; paid plans have no limit', async () => {
    const session: SessionRecord = {
      id: 'big',
      name: 'Big',
      tags: [],
      pinned: 0,
      color: null,
      kind: 'session',
      source: 'save-all',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: 0,
      deviceId: 'd',
      version: 1,
      tabCount: 497,
      windowCount: 1,
      preview: [],
    };
    await db.sessions.add(session);
    const progress: number[] = [];
    const result = await importSessions(
      collections(['A', 'B'], (i) => [`https://a${i}.com`, `https://b${i}.com`, `https://c${i}.com`]),
      { deviceId: 'd', onProgress: (n) => progress.push(n) },
    );
    expect(result).toMatchObject({ tabs: 3, skippedOverLimit: 3, sessions: 1 });
    expect(progress).toEqual([3]);
    const unlimited = await importSessions(collections(['C'], () => ['https://x.com', 'https://y.com']), { deviceId: 'd', unlimited: true });
    expect(unlimited).toMatchObject({ tabs: 2, skippedOverLimit: 0 });
  });

  it('a backup restore puts tabs back in their folders when the folder still exists, within the room', async () => {
    const { folder } = await send({ type: 'folder-create', name: 'Kept' });
    const result = await restoreRecords(
      [
        { url: 'https://a.com', title: 'A', keywords: [], savedAt: 3000, folderId: folder.id },
        { url: 'https://b.com', title: 'B', keywords: [], savedAt: 2000, folderId: 'deleted00000' },
        { url: 'https://c.com', title: 'C', keywords: [], savedAt: 1000 },
      ],
      'Restored',
      { deviceId: 'd', room: 2 },
    );
    expect(result).toMatchObject({ restored: 2, skippedOverLimit: 1 });
    expect((await tab('https://a.com')).folderId).toBe(folder.id);
    expect((await tab('https://b.com')).folderId).toBeUndefined();
    expect(await tab('https://c.com')).toBeUndefined();
  });
});

describe('exports with folders', () => {
  it('lists folders first, names each tab’s folder, and reads back as bookmarks', async () => {
    const at = new Date(2026, 9, 10, 14, 32).getTime();
    const { savedTabIds } = await fold(['https://a.com', 'https://b.com', 'https://c.com'], at, 'Fold');
    const { folder } = await send({ type: 'folder-create', name: 'Holiday [Lisbon]', tabRecordIds: savedTabIds.slice(0, 2) });
    const graphs = await exportGraphs();
    const folders = await db.folders.toArray();

    const md = exportMarkdown(graphs, at, { folders });
    expect(md).toContain('1 fold · 3 tabs · 1 folder · exported 10 Oct 2026');
    expect(md.indexOf('## Holiday \\[Lisbon\\]')).toBeLessThan(md.indexOf('## Fold'));
    expect(md).toContain('Folder · 2 tabs');
    // Each tab once: folder tabs aren't repeated under their fold.
    expect(md.match(/\(https:\/\/a\.com\)/g)).toHaveLength(1);

    const csv = exportCsv(graphs, { folders }).split('\r\n');
    expect(csv[0]).toBe('fold,window,title,url,saved_at,keywords,folder');
    expect(csv.filter((row) => row.endsWith(',Holiday [Lisbon]'))).toHaveLength(2);

    const json = JSON.parse(exportJson(graphs, at, { folders })) as TabfoldJsonExport;
    expect(json.folders).toEqual([{ name: 'Holiday [Lisbon]', color: folder.color }]);
    expect(json.folds[0]!.windows[0]!.tabs.map((t) => t.folder ?? null)).toEqual(['Holiday [Lisbon]', 'Holiday [Lisbon]', null]);

    const html = exportHtml(graphs, at, { folders });
    expect(html.indexOf('Holiday [Lisbon]')).toBeLessThan(html.indexOf('>Fold<'));
    const back = parseBookmarksHtml(html);
    expect(back.sessions.map((s) => [s.name, s.windows[0]!.tabs.length])).toEqual([
      ['Holiday [Lisbon]', 2],
      ['Fold / Window 1', 1],
    ]);
    // Without folders (or with a deleted one), exports are as before.
    const deleted: FolderRecord[] = folders.map((f) => ({ ...f, deletedAt: 1 }));
    expect(exportMarkdown(graphs, at, { folders: deleted })).toBe(exportMarkdown(graphs, at));
  });
});

describe('search version', () => {
  it('moves when folders change, so search and sync notice', async () => {
    await bumpSearchVersion();
    const before = await getSearchVersion();
    const { folder } = await send({ type: 'folder-create', name: 'A' });
    const { savedTabIds } = await fold(['https://a.com']);
    const mid = await getSearchVersion();
    await send({ type: 'tabs-move', tabRecordIds: savedTabIds, folderId: folder.id });
    expect(await getSearchVersion()).toBeGreaterThan(mid);
    await send({ type: 'folder-update', id: folder.id, name: 'B' });
    expect(await getSearchVersion()).toBeGreaterThan(before);
    void fakeBrowser;
  });
});
