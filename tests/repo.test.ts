import { describe, expect, it } from 'vitest';
import { db, getSearchVersion } from '@/lib/db';
import {
  countNamedSessions,
  deleteSessionsForever,
  getSessionGraph,
  importSessions,
  keywordVocabulary,
  LimitError,
  listLiveSessions,
  listTrash,
  moveTab,
  pruneSnapshots,
  purgeTrash,
  removeTabs,
  restoreFromTrash,
  saveCapture,
  setSessionTags,
  renameTag,
  deleteTag,
  setTabKeywords,
  trashSessions,
  TRASH_RETENTION_MS,
  findSavedCopies,
  fillTabTitle,
  listSnapshots,
} from '@/lib/repo';
import { capturedTab, capturedWindow } from './fixtures';

const meta = { source: 'save-all' as const, deviceId: 'd1', now: 1_000 };

async function save(urls: string[][], extra: Partial<Parameters<typeof saveCapture>[2]> = {}) {
  return saveCapture(urls.map((u) => capturedWindow(u)), meta, { dedupe: true, ...extra });
}

describe('saving', () => {
  it('writes a session with its windows and tabs, and bumps the search version', async () => {
    const before = await getSearchVersion();
    const result = await save([['https://a.com', 'https://b.com'], ['https://c.com']]);
    const graph = await getSessionGraph(result.sessionId);
    expect(graph!.windows.map((w) => w.tabs.map((t) => t.url))).toEqual([['https://a.com', 'https://b.com'], ['https://c.com']]);
    expect(graph!.session.tabCount).toBe(3);
    expect(await getSearchVersion()).toBe(before + 1);
  });

  it('adds single tabs to the first window of an existing session, skipping duplicates but keeping their keywords', async () => {
    const first = await save([['https://a.com']]);
    const window = capturedWindow([]);
    window.tabs = [capturedTab('https://a.com', { keywords: ['alpha'] }), capturedTab('https://new.com', { keywords: ['beta'] })];
    const second = await saveCapture([window], { ...meta, source: 'save-tabs' }, { dedupe: true, targetSessionId: first.sessionId });
    expect(second.createdSession).toBe(false);
    expect(second.skippedDuplicates).toBe(1);
    const graph = await getSessionGraph(first.sessionId);
    expect(graph!.windows).toHaveLength(1);
    expect(graph!.windows[0]!.tabs.map((t) => [t.url, t.keywords])).toEqual([
      ['https://a.com', ['alpha']],
      ['https://new.com', ['beta']],
    ]);
  });

  it('reuses a saved title for a tab captured before it ever loaded', async () => {
    await save([['https://docs.example.com/guide']]);
    await db.tabs.toCollection().modify({ title: 'The real guide' });
    const window = capturedWindow([]);
    window.tabs = [capturedTab('https://docs.example.com/guide', { title: 'docs.example.com' })];
    const again = await saveCapture([window], meta, { dedupe: false });
    expect((await db.tabs.get(again.savedTabIds[0]!))!.title).toBe('The real guide');
  });

  it('skips an address saved in any live session, not only the target, and never writes an empty session', async () => {
    const first = await save([['https://a.com/', 'https://b.com']]);
    const trashed = await save([['https://t.com']]);
    await trashSessions([trashed.sessionId]);
    const again = await save([['https://a.com', 'https://c.com', 'https://c.com/', 'https://t.com']]);
    expect(again.skippedDuplicates).toBe(2);
    expect(again.skippedTabs.map((s) => s.tab.url)).toEqual(['https://a.com', 'https://c.com/']);
    expect((await getSessionGraph(again.sessionId))!.windows[0]!.tabs.map((t) => t.url)).toEqual(['https://c.com', 'https://t.com']);

    const sessions = await db.sessions.count();
    const none = await save([['https://b.com']]);
    expect(none).toMatchObject({ savedTabIds: [], skippedDuplicates: 1, sessionId: first.sessionId, createdSession: false });
    expect(await db.sessions.count()).toBe(sessions);
  });

  it('finds where an address is saved, preferring the given session, then the most recently updated', async () => {
    const old = await saveCapture([capturedWindow(['https://x.com/'])], { ...meta, now: 1 }, { dedupe: false });
    const recent = await saveCapture([capturedWindow(['https://x.com'])], { ...meta, now: 2 }, { dedupe: false });
    expect((await findSavedCopies(['https://x.com/'])).get('https://x.com')!.session.id).toBe(recent.sessionId);
    expect((await findSavedCopies(['https://x.com'], old.sessionId)).get('https://x.com')!.session.id).toBe(old.sessionId);
    expect((await findSavedCopies(['https://y.com'])).size).toBe(0);
  });

  it('fills in a title that arrived after saving, in the row and the favicon strip, without moving the session', async () => {
    const window = capturedWindow([]);
    window.tabs = [capturedTab('https://docs.example.com/guide', { title: 'docs.example.com' })];
    const result = await saveCapture([window], meta, { dedupe: false });
    const before = (await db.sessions.get(result.sessionId))!;
    expect(await fillTabTitle(result.savedTabIds[0]!, '  The real guide ')).toBe(true);
    expect((await db.tabs.get(result.savedTabIds[0]!))!.title).toBe('The real guide');
    const after = (await db.sessions.get(result.sessionId))!;
    expect(after.preview[0]!.title).toBe('The real guide');
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(await fillTabTitle('missing', 'x')).toBe(false);
  });

  it('every save gets its own session; only with a plan given do saves past its cap go into Unsorted', async () => {
    for (let i = 0; i < 50; i += 1) await save([[`https://site${i}.com`]]);
    expect(await countNamedSessions()).toBe(50);
    expect((await save([['https://uncapped.com']])).intoUnsorted).toBe(false);
    expect(await countNamedSessions()).toBe(51);
    const overflow = await save([['https://overflow.com']], { plan: 'free' });
    expect(overflow.intoUnsorted).toBe(true);
    const again = await save([['https://overflow2.com']], { plan: 'free' });
    expect(again.sessionId).toBe(overflow.sessionId);
    expect(await countNamedSessions()).toBe(51);
    const unsorted = (await listLiveSessions()).find((s) => s.kind === 'unsorted');
    expect(unsorted?.tabCount).toBe(2);
  });
});

describe('editing', () => {
  it('stores clean keywords per tab and lists the vocabulary by use', async () => {
    const { sessionId } = await save([['https://a.com', 'https://b.com']]);
    const tabs = await db.tabs.where('sessionId').equals(sessionId).toArray();
    await setTabKeywords(tabs[0]!.id, ['Stripe', '#webhooks']);
    await setTabKeywords(tabs[1]!.id, ['webhooks']);
    expect((await db.tabs.get(tabs[0]!.id))!.keywords).toEqual(['stripe', 'webhooks']);
    expect(await keywordVocabulary()).toEqual([
      { keyword: 'webhooks', count: 2 },
      { keyword: 'stripe', count: 1 },
    ]);
    expect(await db.tabs.where('keywords').equals('webhooks').count()).toBe(2);
  });

  it('moves a tab between sessions and keeps both counts right', async () => {
    const a = await save([['https://a1.com', 'https://a2.com']]);
    const b = await save([['https://b1.com']]);
    const tab = (await db.tabs.where('sessionId').equals(a.sessionId).toArray()).find((t) => t.url === 'https://a2.com')!;
    const firstB = (await db.tabs.where('sessionId').equals(b.sessionId).toArray())[0]!;
    await moveTab(tab.id, { windowId: firstB.windowId, beforeTabId: firstB.id });
    const graphB = await getSessionGraph(b.sessionId);
    expect(graphB!.windows[0]!.tabs.map((t) => t.url)).toEqual(['https://a2.com', 'https://b1.com']);
    expect(graphB!.session.tabCount).toBe(2);
    expect((await db.sessions.get(a.sessionId))!.tabCount).toBe(1);
  });

  it('sends a session to Trash when its last tab is removed', async () => {
    const { sessionId } = await save([['https://only.com']]);
    const tab = (await db.tabs.where('sessionId').equals(sessionId).toArray())[0]!;
    await removeTabs([tab.id]);
    expect((await db.sessions.get(sessionId))!.deletedAt).toBeGreaterThan(0);
  });

  it('limits Free to 5 distinct tags across sessions', async () => {
    const a = await save([['https://a.com']]);
    const b = await save([['https://b.com']]);
    await setSessionTags(a.sessionId, ['one', 'two', 'three', 'four', 'five']);
    await setSessionTags(b.sessionId, ['one', 'five']);
    await expect(setSessionTags(b.sessionId, ['six'])).rejects.toBeInstanceOf(LimitError);
  });

  it('lets a session over the tag limit (after a downgrade) reuse and remove tags, but not add new ones', async () => {
    const a = await save([['https://a.com']]);
    const b = await save([['https://b.com']]);
    // Written directly, as a downgraded Pro user's data would be.
    await db.sessions.update(a.sessionId, { tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'] });
    await setSessionTags(b.sessionId, ['t1', 't6']);
    expect((await db.sessions.get(b.sessionId))!.tags).toEqual(['t1', 't6']);
    await expect(setSessionTags(b.sessionId, ['t1', 'brand-new'])).rejects.toBeInstanceOf(LimitError);
    await setSessionTags(a.sessionId, ['t1', 't2']);
    expect((await db.sessions.get(a.sessionId))!.tags).toEqual(['t1', 't2']);
    // Back under the limit: new tags are fine again.
    await setSessionTags(b.sessionId, ['t1', 'brand-new']);
  });

  it('swaps a tag only this session uses for a new one without hitting the limit', async () => {
    const a = await save([['https://a.com']]);
    const b = await save([['https://b.com']]);
    await setSessionTags(a.sessionId, ['one', 'two', 'three', 'four']);
    await setSessionTags(b.sessionId, ['five']);
    await setSessionTags(b.sessionId, ['six']);
    expect((await db.sessions.get(b.sessionId))!.tags).toEqual(['six']);
  });

  it('renames a tag everywhere (merging duplicates) and deletes a tag from every session', async () => {
    const a = await save([['https://a.com']]);
    const b = await save([['https://b.com']]);
    await setSessionTags(a.sessionId, ['client', 'react']);
    await setSessionTags(b.sessionId, ['client']);
    expect(await renameTag('client', 'react')).toBe(2);
    expect((await db.sessions.get(a.sessionId))!.tags).toEqual(['react']);
    expect((await db.sessions.get(b.sessionId))!.tags).toEqual(['react']);
    await trashSessions([b.sessionId]);
    expect(await deleteTag('react')).toBe(2);
    expect((await db.sessions.get(a.sessionId))!.tags).toEqual([]);
    expect((await db.sessions.get(b.sessionId))!.tags).toEqual([]);
  });
});

describe('trash', () => {
  it('moves to Trash, restores, and purges after 30 days', async () => {
    const { sessionId } = await save([['https://a.com']]);
    await trashSessions([sessionId], db, 5_000);
    expect((await listTrash()).map((s) => s.id)).toEqual([sessionId]);
    await restoreFromTrash([sessionId]);
    expect(await listTrash()).toEqual([]);
    await trashSessions([sessionId], db, 5_000);
    expect(await purgeTrash(5_000 + TRASH_RETENTION_MS - 1)).toBe(0);
    expect(await purgeTrash(5_000 + TRASH_RETENTION_MS + 1)).toBe(1);
    expect(await db.tabs.where('sessionId').equals(sessionId).count()).toBe(0);
  });

  it('deletes forever with its windows and tabs', async () => {
    const { sessionId } = await save([['https://a.com'], ['https://b.com']]);
    await deleteSessionsForever([sessionId]);
    expect(await db.windows.where('sessionId').equals(sessionId).count()).toBe(0);
    expect(await db.tabs.count()).toBe(0);
  });
});

describe('import', () => {
  it('creates one session per imported group, never capped', async () => {
    const sessions = Array.from({ length: 52 }, (_, i) => ({ name: `Group ${i}`, createdAt: null, windows: [capturedWindow([`https://g${i}.com`])] }));
    const result = await importSessions(sessions, 'd1');
    expect(result).toEqual({ sessions: 52, tabs: 52, intoUnsorted: 0 });
  });
});

describe('snapshots', () => {
  it('keeps one rolling timer snapshot, one shutdown snapshot and recent safety copies', async () => {
    const add = (reason: 'timer' | 'shutdown' | 'before-restore', createdAt: number) =>
      db.snapshots.add({ reason, createdAt, hash: String(createdAt), tabCount: 1, windowCount: 1, windows: [] });
    await add('timer', 1);
    await add('timer', 2);
    await add('shutdown', 3);
    await add('shutdown', 4);
    for (let i = 0; i < 7; i += 1) await add('before-restore', 10 + i);
    await pruneSnapshots(undefined, 20);
    const left = await db.snapshots.toArray();
    expect(left.filter((s) => s.reason === 'timer').map((s) => s.createdAt)).toEqual([2]);
    expect(left.filter((s) => s.reason === 'shutdown').map((s) => s.createdAt)).toEqual([4]);
    expect(left.filter((s) => s.reason === 'before-restore')).toHaveLength(5);
  });

  it('lists every snapshot newest first, including the automatic one', async () => {
    const add = (reason: 'timer' | 'shutdown' | 'manual', createdAt: number) =>
      db.snapshots.add({ reason, createdAt, hash: String(createdAt), tabCount: 1, windowCount: 1, windows: [] });
    await add('shutdown', 1);
    await add('timer', 3);
    await add('manual', 2);
    expect((await listSnapshots()).map((s) => s.reason)).toEqual(['timer', 'manual', 'shutdown']);
  });
});

describe('remove with undo', () => {
  it('puts removed tabs back, including the window and the session they emptied', async () => {
    const { removeTabsWithSnapshot, putBackTabs } = await import('@/lib/repo');
    const { sessionId } = await save([['https://a.com', 'https://b.com'], ['https://c.com']]);
    const all = await db.tabs.where('sessionId').equals(sessionId).toArray();
    const removed = await removeTabsWithSnapshot(all.map((t) => t.id));
    expect((await db.sessions.get(sessionId))!.deletedAt).toBeGreaterThan(0);
    expect(await db.windows.where('sessionId').equals(sessionId).count()).toBe(0);
    await putBackTabs(removed);
    const graph = await getSessionGraph(sessionId);
    expect(graph!.session.deletedAt).toBe(0);
    expect(graph!.windows.map((w) => w.tabs.map((t) => t.url))).toEqual([['https://a.com', 'https://b.com'], ['https://c.com']]);
    expect(graph!.session.tabCount).toBe(3);
  });
});
