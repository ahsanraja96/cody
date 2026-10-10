import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { resetGroupsFlagCache } from '@/lib/background/browserState';
import { forgetUnfinishedFold, handleFold } from '@/lib/background/fold';
import { handleMessage } from '@/lib/background';
import { createMenus, MENU, onCommand, onMenuClicked } from '@/lib/background/menus';
import { handleOpenTabs } from '@/lib/background/restore';
import { route } from '@/lib/background/router';
import { handleUndo } from '@/lib/background/save';
import { resetTitleCache } from '@/lib/background/titles';
import { db } from '@/lib/db';
import type { FoldOutcome } from '@/lib/messages';
import { saveCapture } from '@/lib/repo';
import { updateSettings } from '@/lib/settings';
import { activeFold, lastAction, pendingKeywordSave, type ActiveFold } from '@/lib/state';
import { FakeChrome } from './chrome';
import { capturedWindow } from './fixtures';

// Folding waits for "Leave site?" answers and for memory to settle in Chrome; tests don't need to.
vi.mock('@/lib/background/browserState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/background/browserState')>()),
  sleep: async () => undefined,
}));

let chrome: FakeChrome;

beforeEach(() => {
  chrome = new FakeChrome().install();
  resetTitleCache();
  resetGroupsFlagCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const GB = 1024 ** 3;

async function seed(name: string, urls: string[]) {
  return saveCapture([capturedWindow(urls)], { name, source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: false });
}

function progress(): ActiveFold[] {
  return chrome.events('fold-progress').map((e) => e.fold as ActiveFold);
}

describe('fold', () => {
  it('saves every tab in every normal window and closes it; pinned, playing and Incognito tabs stay', async () => {
    await seed('Earlier', ['https://already.com']);
    chrome.openWindow(
      [
        { url: 'https://mail.com', pinned: true },
        { url: 'https://music.com', audible: true },
        'https://a.com',
        'https://already.com/',
        'chrome://newtab/',
      ],
      { focused: true },
    );
    chrome.openWindow(['https://b.com', { url: 'https://c.com', discarded: true }]);
    chrome.openWindow(['https://private.com'], { incognito: true });

    const outcome = await handleFold();
    expect(outcome).toMatchObject({
      savedTabs: 3,
      skippedDuplicates: 1,
      // a, already (a duplicate), the new tab page, b and c.
      closedTabs: 5,
      stayedOpen: { pinned: 1, audible: 1 },
      keptOpen: { pinned: 1, audible: 1 },
      failedToClose: [],
      // Three loaded tabs closed (c was asleep); the estimate stays as it was.
      freedBytes: 4 * 48 * 1024 * 1024,
    });
    expect(chrome.tabs.map((t) => t.url).sort()).toEqual(['https://mail.com', 'https://music.com', 'https://private.com']);
    const saved = await db.tabs.where('sessionId').equals(outcome.sessionId!).toArray();
    expect(saved.map((t) => t.url).sort()).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    expect((await db.sessions.get(outcome.sessionId!))!.source).toBe('save-all');
  });

  it('folds pinned tabs too when "Keep pinned tabs open" is off, and every window whatever the old window setting', async () => {
    await updateSettings({ keepPinnedOpen: false, includeAllWindows: false });
    chrome.openWindow([{ url: 'https://mail.com', pinned: true }, 'https://a.com'], { focused: true });
    chrome.openWindow(['https://b.com']);
    const outcome = await handleFold();
    expect(outcome.savedTabs).toBe(3);
    expect(chrome.webTabs()).toHaveLength(0);
    // Chrome never quits: a New Tab stays.
    expect(chrome.tabs.map((t) => t.url)).toEqual(['chrome://newtab/']);
  });

  it('reports progress: saving, closing in batches of 10, done with the outcome', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://site${i}.com`);
    chrome.openWindow([{ url: 'https://pinned.com', pinned: true }, ...urls], { focused: true });
    const seen: Array<ActiveFold | undefined> = [];
    const stop = activeFold.watch((value) => seen.push(value && { ...value }));
    const outcome = await handleFold();
    stop();

    const events = progress();
    expect(events.map((e) => [e.phase, e.closed])).toEqual([
      ['saving', 0],
      ['closing', 0],
      ['closing', 10],
      ['closing', 20],
      ['closing', 25],
      ['done', 25],
    ]);
    expect(events.every((e) => e.foldId === outcome.foldId && e.total === 25)).toBe(true);
    expect(events.at(-1)!.outcome).toEqual(outcome);
    expect(seen.at(-1)).toMatchObject({ phase: 'done', closed: 25, waiting: [] });
    expect(await activeFold.get()).toMatchObject({ phase: 'done', outcome: { foldId: outcome.foldId } });
  });

  it('waits for "Leave site?" answers, then lists the tabs that stayed open (saved either way)', async () => {
    const { windowId, tabIds } = chrome.openWindow(
      ['https://a.com', { url: 'https://docs.google.com/d/1', title: 'Budget' }, { url: 'https://form.com', title: 'Form' }],
      { focused: true },
    );
    const [, docs, form] = tabIds as [number, number, number];
    chrome.refuseClose.add(docs);
    chrome.refuseClose.add(form);
    // The person answers "Leave" in Docs a few checks into the wait, and never answers in Form.
    let checks = 0;
    chrome.beforeTabsQuery = () => {
      if (progress().some((p) => p.phase === 'waiting') && ++checks === 3) chrome.closeNow(docs);
    };

    const outcome = await handleFold();
    const waiting = progress().filter((p) => p.phase === 'waiting');
    expect(waiting.map((p) => [p.closed, p.waiting.map((w) => w.title)])).toEqual([
      [1, ['Budget', 'Form']],
      [2, ['Form']],
    ]);
    expect(outcome.savedTabs).toBe(3);
    expect(outcome.closedTabs).toBe(2);
    expect(outcome.failedToClose).toEqual([{ tabId: form, windowId, title: 'Form', url: 'https://form.com' }]);
    expect(progress().at(-1)).toMatchObject({ phase: 'done', closed: 2, waiting: [] });

    // Undo reopens what closed, and not a second copy of the tab that never did.
    await handleUndo(outcome.actionId!);
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://a.com', 'https://docs.google.com/d/1', 'https://form.com']);
    expect(await db.tabs.count()).toBe(0);
  });

  it('reads the free memory before and about 2 s after closing, or reports nulls without the API', async () => {
    let free = 4 * GB;
    chrome.memoryInfo = () => ({ capacity: 16 * GB, availableCapacity: free });
    chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    chrome.beforeTabsQuery = () => {
      free = 6 * GB;
    };
    const outcome = await handleFold();
    expect(outcome.memory).toEqual({ freeBefore: 4 * GB, freeAfter: 6 * GB, capacity: 16 * GB });

    chrome.memoryInfo = undefined;
    chrome.openWindow(['https://c.com'], { focused: true });
    const second = await handleFold();
    expect(second.memory).toEqual({ freeBefore: null, freeAfter: null, capacity: null });
  });

  it('closes nothing and says why when storage is full', async () => {
    chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    const remove = vi.spyOn(fakeBrowser.tabs, 'remove');
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    const response = await route({ type: 'fold' });
    expect(response).toMatchObject({ ok: false, code: 'quota' });
    expect(remove).not.toHaveBeenCalled();
    expect(chrome.webTabs()).toHaveLength(2);
    expect(await activeFold.get()).toMatchObject({
      phase: 'failed',
      closed: 0,
      error: 'Chrome is out of storage space. Free up some disk space, then try again.',
    });
  });

  it('runs one fold at a time: a second request gets the running one\'s outcome', async () => {
    chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    const [first, second] = await Promise.all([handleFold(), handleFold()]);
    expect(second).toBe(first);
    expect(await db.sessions.count()).toBe(1);
    expect(progress().filter((p) => p.phase === 'saving')).toHaveLength(1);
  });

  it('undo reopens the folded tabs and the duplicates it closed, and removes the fold', async () => {
    await seed('Earlier', ['https://dup.com']);
    const { windowId } = chrome.openWindow(['https://here.com', 'https://a.com', 'https://dup.com', { url: 'https://p.com', pinned: true }], {
      focused: true,
    });
    const outcome = await handleFold();
    expect((await lastAction.get())?.id).toBe(outcome.actionId);
    expect(await handleUndo(outcome.actionId!)).toEqual({ undone: true });
    expect(chrome.webTabs().filter((t) => t.windowId === windowId).map((t) => t.url).sort()).toEqual([
      'https://a.com',
      'https://dup.com',
      'https://here.com',
      'https://p.com',
    ]);
    expect(await db.sessions.count()).toBe(1);
  });

  it('with nothing to fold, closes nothing and finishes at once', async () => {
    chrome.openWindow([{ url: 'https://mail.com', pinned: true }, 'chrome://newtab/'], { focused: true });
    const outcome = await handleFold();
    expect(outcome).toMatchObject({ savedTabs: 0, closedTabs: 0, actionId: null, stayedOpen: { pinned: 1, audible: 0 } });
    expect(chrome.tabs).toHaveLength(2);
    expect(progress().map((p) => p.phase)).toEqual(['done']);
  });

  it('is never capped by the old plan limits', async () => {
    for (let i = 0; i < 50; i += 1) await seed(`Fold ${i}`, [`https://old${i}.com`]);
    chrome.openWindow(['https://new.com'], { focused: true });
    const outcome = await handleFold();
    expect(outcome.intoUnsorted).toBe(false);
    expect((await db.sessions.get(outcome.sessionId!))!.kind).toBe('session');
  });

  it('a fresh worker forgets a fold that was still running', async () => {
    await activeFold.set({ foldId: 'x', phase: 'closing', total: 5, closed: 2, waiting: [], startedAt: 1 });
    await forgetUnfinishedFold();
    expect(await activeFold.get()).toBeUndefined();
    const done = { foldId: 'y', phase: 'done' as const, total: 1, closed: 1, waiting: [], startedAt: 1, outcome: {} as FoldOutcome };
    await activeFold.set(done);
    await forgetUnfinishedFold();
    expect(await activeFold.get()).toMatchObject({ foldId: 'y' });
  });
});

describe('open all', () => {
  it('opens the tabs in the background of the current window as one Chrome tab group, lazily, and keeps them in the list', async () => {
    const here = chrome.openWindow([{ url: 'https://here.com', active: true }], { focused: true });
    const { sessionId } = await seed('Dev', ['https://github.com/a', 'https://github.com/b', 'https://gitlab.com/c']);
    const ids = (await db.tabs.where('sessionId').equals(sessionId).sortBy('order')).map((t) => t.id);

    const result = await handleOpenTabs({ type: 'open-tabs', tabRecordIds: ids, asGroup: { name: 'Dev', color: 'blue' } });
    expect(result).toEqual({ opened: 3 });
    const opened = chrome.tabs.filter((t) => t.windowId === here.windowId && t.url !== 'https://here.com');
    expect(opened.map((t) => t.url)).toEqual(['https://github.com/a', 'https://github.com/b', 'https://gitlab.com/c']);
    expect(opened.every((t) => !t.active && t.discarded)).toBe(true);
    // Loaded once, muted, before sleeping.
    for (const tab of opened) expect(chrome.mutedLog.filter((m) => m.id === tab.id).map((m) => m.muted)).toEqual([true, false]);
    expect(chrome.groups).toEqual([{ id: opened[0]!.groupId, title: 'Dev', color: 'blue', collapsed: false, windowId: here.windowId }]);
    expect(new Set(opened.map((t) => t.groupId)).size).toBe(1);
    expect(chrome.tab(here.tabIds[0]!)!.active).toBe(true);
    expect(await db.tabs.count()).toBe(3);
  });

  it('opens in the given window, without a group when none is asked for, and ignores group failures', async () => {
    chrome.openWindow(['https://here.com'], { focused: true });
    const other = chrome.openWindow(['https://other.com']);
    const { sessionId } = await seed('Reading', ['https://a.com', 'https://b.com']);
    const ids = (await db.tabs.where('sessionId').equals(sessionId).toArray()).map((t) => t.id);

    expect(await route({ type: 'open-tabs', tabRecordIds: ids, windowId: other.windowId })).toEqual({ ok: true, data: { opened: 2 } });
    expect(chrome.tabs.filter((t) => t.windowId === other.windowId)).toHaveLength(3);
    expect(chrome.groups).toHaveLength(0);

    chrome.groupFails = true;
    expect(await handleOpenTabs({ type: 'open-tabs', tabRecordIds: [...ids, 'gone'], asGroup: { name: 'Reading', color: 'green' } })).toEqual({
      opened: 2,
    });
    expect(chrome.groups).toHaveLength(0);
  });
});

describe('menus and shortcuts', () => {
  it('the right-click menu has only "Fold this tab" and "Fold this tab with keywords…"', async () => {
    vi.spyOn(fakeBrowser.contextMenus, 'removeAll').mockResolvedValue(undefined as never);
    const create = vi.spyOn(fakeBrowser.contextMenus, 'create').mockReturnValue(1 as never);
    await createMenus();
    expect(create.mock.calls.map(([item]) => [item.id, item.title, item.contexts])).toEqual([
      [MENU.foldTab, 'Fold this tab', ['page', 'frame']],
      [MENU.foldTabKeywords, 'Fold this tab with keywords…', ['page', 'frame']],
    ]);
  });

  it('"Fold this tab" folds it; "…with keywords" opens the keyword view; neither touches Incognito', async () => {
    const { tabIds } = chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    const tab = async (id: number) => fakeBrowser.tabs.get(id);
    await onMenuClicked({ menuItemId: MENU.foldTab } as never, await tab(tabIds[0]!));
    expect(chrome.tab(tabIds[0]!)).toBeUndefined();
    expect(await db.tabs.where('url').equals('https://a.com').count()).toBe(1);

    const openPopup = vi.spyOn(fakeBrowser.action, 'openPopup').mockResolvedValue(undefined as never);
    await onMenuClicked({ menuItemId: MENU.foldTabKeywords } as never, await tab(tabIds[1]!));
    expect(openPopup).toHaveBeenCalled();
    expect((await pendingKeywordSave.get())?.tabIds).toEqual([tabIds[1]]);
    expect(chrome.tab(tabIds[1]!)).toBeDefined();

    const secret = chrome.openWindow(['https://private.com'], { incognito: true });
    await onMenuClicked({ menuItemId: MENU.foldTab } as never, await tab(secret.tabIds[0]!));
    expect(chrome.tab(secret.tabIds[0]!)).toBeDefined();
  });

  it('the "Fold all tabs" shortcut folds; "Fold this tab" never asks for keywords; the window shortcut is gone', async () => {
    await updateSettings({ askKeywordsOnSingleSave: true });
    const openPopup = vi.spyOn(fakeBrowser.action, 'openPopup').mockResolvedValue(undefined as never);
    const { tabIds } = chrome.openWindow([{ url: 'https://a.com', active: true }, 'https://b.com'], { focused: true });
    await onCommand('save-tab');
    expect(chrome.tab(tabIds[0]!)).toBeUndefined();
    expect(openPopup).not.toHaveBeenCalled();

    // The old window and save-all shortcuts are gone.
    await onCommand('save-window');
    await onCommand('save-all');
    expect(chrome.tab(tabIds[1]!)).toBeDefined();

    await onCommand('fold');
    expect(chrome.webTabs()).toHaveLength(0);
    expect(progress().at(-1)).toMatchObject({ phase: 'done' });
  });
});

describe('messages', () => {
  it('answers commands from Tabfold pages and ignores messages from anyone else', async () => {
    const message = { __tabfold: true, command: { type: 'dismiss-recovery' } };
    expect(handleMessage(message, { id: 'some-other-extension' })).toBeUndefined();
    expect(handleMessage(message, {})).toBeUndefined();
    expect(handleMessage({ hello: true }, { id: fakeBrowser.runtime.id })).toBeUndefined();
    expect(await handleMessage(message, { id: fakeBrowser.runtime.id })).toEqual({ ok: true, data: { ok: true } });
  });
});
