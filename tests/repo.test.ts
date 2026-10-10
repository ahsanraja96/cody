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
    const again = await saveCapture([window], meta, { dedupe: true });
    expect((await db.tabs.get(again.savedTabIds[0]!))!.title).toBe('The real guide');
  });

  it('after 50 named sessions, new saves go into Unsorted and nothing is blocked', async () => {
    for (let i = 0; i < 50; i += 1) await save([[`https://site${i}.com`]]);
    expect(await countNamedSessions()).toBe(50);
    const overflow = await save([['https://overflow.com']]);
    expect(overflow.intoUnsorted).toBe(true);
    const again = await save([['https://overflow2.com']]);
    expect(again.sessionId).toBe(overflow.sessionId);
    expect(await countNamedSessions()).toBe(50);
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
  it('creates one session per imported group, overflowing into Unsorted past the Free limit', async () => {
    const sessions = Array.from({ length: 52 }, (_, i) => ({ name: `Group ${i}`, createdAt: null, windows: [capturedWindow([`https://g${i}.com`])] }));
    const result = await importSessions(sessions, 'd1');
    expect(result).toEqual({ sessions: 50, tabs: 52, intoUnsorted: 2 });
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
});
