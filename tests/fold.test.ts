import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { resetGroupsFlagCache } from '@/lib/background/browserState';
import { forgetUnfinishedFold, handleFold } from '@/lib/background/fold';
import { handleMessage } from '@/lib/background';
import { createMenus, foldShortcut, MENU, onCommand, onMenuClicked } from '@/lib/background/menus';
import { handleOpenSavedTab, handleOpenTabs, handleRestore, INCOGNITO_OFF } from '@/lib/background/restore';
import { route } from '@/lib/background/router';
import { handleUndo } from '@/lib/background/save';
import { resetTitleCache } from '@/lib/background/titles';
import { db } from '@/lib/db';
import type { FoldOutcome } from '@/lib/messages';
import { getSessionGraph, saveCapture } from '@/lib/repo';
import { updateSettings } from '@/lib/settings';
import { activeFold, lastAction, pendingFoldAsk, pendingKeywordSave, type ActiveFold } from '@/lib/state';
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

describe('fold: what stays open', () => {
  it('closes Tabfold pages without saving them, except the page that started the fold', async () => {
    const own = (path: string) => `chrome-extension://${fakeBrowser.runtime.id}/${path}`;
    const { tabIds } = chrome.openWindow([own('library.html'), own('onboarding.html'), 'https://a.com'], { focused: true });
    const response = await handleMessage({ __tabfold: true, command: { type: 'fold' } }, { id: fakeBrowser.runtime.id, tab: { id: tabIds[0] } });
    expect(response).toMatchObject({ ok: true, data: { savedTabs: 1 } });
    expect(chrome.tabs.map((t) => t.url)).toEqual([own('library.html')]);
    expect(await db.tabs.count()).toBe(1);
  });

  it('counts tabs in app and pop-up windows, and Incognito tabs while folding them is off', async () => {
    chrome.openWindow(['https://a.com'], { focused: true });
    chrome.openWindow(['https://meet.example.com'], { type: 'popup' });
    chrome.openWindow(['https://private.com', 'https://private.com/2'], { incognito: true });
    const outcome = await handleFold();
    expect(outcome.stayedOpen).toEqual({ pinned: 0, audible: 0, apps: 1, incognito: 2 });
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://meet.example.com', 'https://private.com', 'https://private.com/2']);
  });
});

describe('fold: one window', () => {
  it('"Just this window" folds only that window and leaves it open with a new tab', async () => {
    const here = chrome.openWindow([{ url: 'https://mail.com', pinned: false }, 'https://a.com'], { focused: true });
    const other = chrome.openWindow(['https://b.com', 'https://c.com']);
    chrome.openWindow(['https://private.com'], { incognito: true });
    const outcome = await handleFold({ windowId: here.windowId, keepWindowOpen: true });
    expect(outcome).toMatchObject({ windowId: here.windowId, savedTabs: 2, closedTabs: 2, stayedOpen: { pinned: 0, audible: 0, apps: 0, incognito: 0 } });
    // This window is still there, with a new tab; the other windows are untouched.
    expect(chrome.windows.some((w) => w.id === here.windowId)).toBe(true);
    expect(chrome.tabs.filter((t) => t.windowId === here.windowId).map((t) => t.url)).toEqual(['chrome://newtab/']);
    expect(chrome.tabs.filter((t) => t.windowId === other.windowId).map((t) => t.url)).toEqual(['https://b.com', 'https://c.com']);
    expect((await db.tabs.toArray()).map((t) => t.url).sort()).toEqual(['https://a.com', 'https://mail.com']);
    expect(progress().at(-1)).toMatchObject({ phase: 'done', windowId: here.windowId });
  });

  it("another window's own Fold folds it away, and keeps pinned tabs as usual", async () => {
    const here = chrome.openWindow(['https://a.com'], { focused: true });
    const other = chrome.openWindow(['https://b.com', 'https://c.com']);
    const pinned = chrome.openWindow([{ url: 'https://p.com', pinned: true }, 'https://d.com']);
    await handleFold({ windowId: other.windowId });
    expect(chrome.windows.some((w) => w.id === other.windowId)).toBe(false);
    expect(chrome.tabs.filter((t) => t.windowId === here.windowId).map((t) => t.url)).toEqual(['https://a.com']);
    const outcome = await handleFold({ windowId: pinned.windowId });
    expect(outcome).toMatchObject({ savedTabs: 1, stayedOpen: { pinned: 1 } });
    expect(chrome.tabs.filter((t) => t.windowId === pinned.windowId).map((t) => t.url)).toEqual(['https://p.com']);
  });

  it('undo of a one-window fold puts the tabs back in that window', async () => {
    const here = chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    chrome.openWindow(['https://c.com']);
    const outcome = await handleFold({ windowId: here.windowId, keepWindowOpen: true });
    expect(await handleUndo(outcome.actionId!)).toEqual({ undone: true });
    expect(chrome.tabs.filter((t) => t.windowId === here.windowId && t.url.startsWith('https')).map((t) => t.url)).toEqual(['https://a.com', 'https://b.com']);
    expect(await db.tabs.count()).toBe(0);
  });

  it('the command passes the window through', async () => {
    const here = chrome.openWindow(['https://a.com'], { focused: true });
    chrome.openWindow(['https://b.com']);
    const response = await route({ type: 'fold', windowId: here.windowId, keepWindowOpen: true });
    expect(response).toMatchObject({ ok: true, data: { windowId: here.windowId, savedTabs: 1 } });
    expect(chrome.webTabs().map((t) => t.url)).toEqual(['https://b.com']);
  });
});

describe('the fold shortcut', () => {
  it('with one window open, folds straight away', async () => {
    const openPopup = vi.spyOn(fakeBrowser.action, 'openPopup').mockResolvedValue(undefined as never);
    chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    chrome.openWindow(['https://private.com'], { incognito: true });
    await foldShortcut();
    expect(openPopup).not.toHaveBeenCalled();
    expect(chrome.webTabs().map((t) => t.url)).toEqual(['https://private.com']);
  });

  it('with several windows, opens Tabfold asking which windows (a small window if the popup can\'t open)', async () => {
    const openPopup = vi.spyOn(fakeBrowser.action, 'openPopup').mockResolvedValue(undefined as never);
    chrome.openWindow(['https://a.com'], { focused: true });
    chrome.openWindow(['https://b.com']);
    await onCommand('fold');
    expect(openPopup).toHaveBeenCalledTimes(1);
    expect((await pendingFoldAsk.get())?.at).toBeGreaterThan(Date.now() - 5000);
    expect(chrome.webTabs()).toHaveLength(2);

    openPopup.mockRejectedValue(new Error('No active browser window'));
    await foldShortcut();
    expect(chrome.createdWindows.at(-1)).toMatchObject({ type: 'popup' });
    expect(String(chrome.createdWindows.at(-1)?.url)).toContain('popup.html?mode=window');
  });
});

describe('fold: Incognito windows', () => {
  async function foldBoth() {
    await updateSettings({ foldIncognito: true });
    chrome.openWindow(['https://a.com', 'https://both.com'], { focused: true });
    const secret = chrome.openWindow(['https://private.com', 'https://both.com'], { incognito: true });
    const outcome = await handleFold();
    return { outcome, secret };
  }

  it('stay open while the setting is off, and without "Allow in Incognito" even when it is on', async () => {
    chrome.openWindow(['https://a.com'], { focused: true });
    chrome.openWindow(['https://private.com'], { incognito: true });
    await handleFold();
    expect(chrome.webTabs().map((t) => t.url)).toEqual(['https://private.com']);

    await updateSettings({ foldIncognito: true });
    chrome.incognitoAccess = false;
    chrome.openWindow(['https://b.com'], { focused: true });
    await handleFold();
    expect(chrome.webTabs().map((t) => t.url)).toEqual(['https://private.com']);
    expect(await db.tabs.where('url').equals('https://private.com').count()).toBe(0);
  });

  it('with the setting on, folds them marked as Incognito; the same address in both modes is two tabs', async () => {
    const { outcome } = await foldBoth();
    expect(outcome).toMatchObject({ savedTabs: 4, skippedDuplicates: 0, closedTabs: 4 });
    expect(outcome.stayedOpen.incognito).toBe(0);
    expect(chrome.webTabs()).toHaveLength(0);
    const tabs = await db.tabs.toArray();
    expect(tabs.map((t) => [t.url, !!t.incognito]).sort()).toEqual([
      ['https://a.com', false],
      ['https://both.com', false],
      ['https://both.com', true],
      ['https://private.com', true],
    ]);
    const windows = await db.windows.toArray();
    expect(windows.map((w) => !!w.incognito).sort()).toEqual([false, true]);

    // Folding the same Incognito address again is a duplicate in Incognito only.
    chrome.openWindow(['https://private.com', 'https://a.com/x'], { incognito: true });
    const again = await handleFold();
    expect(again).toMatchObject({ savedTabs: 1, skippedDuplicates: 1 });
  });

  it('a tab folded from Incognito opens only in Incognito: an open Incognito window, a new one, or not at all', async () => {
    await foldBoth();
    const row = (await db.tabs.toArray()).find((t) => t.url === 'https://private.com')!;
    const normal = chrome.openWindow(['https://other.com'], { focused: true });

    // No Incognito window open: a new Incognito window with the tab.
    expect(await handleOpenSavedTab(row.id, true, normal.windowId)).toEqual({ opened: true });
    const created = chrome.windows.at(-1)!;
    expect(created.incognito).toBe(true);
    expect(chrome.tabs.filter((t) => t.windowId === created.id).map((t) => t.url)).toEqual(['https://private.com']);

    // An Incognito window is open: it goes there.
    expect(await handleOpenSavedTab(row.id, false, normal.windowId)).toEqual({ opened: true });
    expect(chrome.tabs.filter((t) => t.url === 'https://private.com').every((t) => t.incognito)).toBe(true);
    expect(chrome.createdWindows.filter((d) => !d?.incognito)).toHaveLength(0);

    // Without "Allow in Incognito" it doesn't open at all, and says why.
    chrome.incognitoAccess = false;
    expect(await handleOpenSavedTab(row.id, true, normal.windowId)).toEqual({ opened: false, reason: INCOGNITO_OFF });
    expect(chrome.tabs.filter((t) => t.url === 'https://private.com' && !t.incognito)).toHaveLength(0);
  });

  it('"Open all" splits a group: normal tabs here, Incognito tabs in an Incognito window', async () => {
    await foldBoth();
    const here = chrome.openWindow(['https://other.com'], { focused: true });
    const rows = await db.tabs.toArray();
    const result = await handleOpenTabs({ type: 'open-tabs', tabRecordIds: rows.map((r) => r.id), asGroup: { name: 'Other', color: 'grey' }, windowId: here.windowId });
    expect(result.opened).toBe(4);
    const opened = chrome.tabs.filter((t) => t.url !== 'https://other.com' && t.url !== 'chrome://newtab/');
    for (const tab of opened) {
      const incognito = rows.find((r) => r.url === tab.url && !!r.incognito === tab.incognito);
      expect(incognito, tab.url).toBeDefined();
      expect(chrome.windows.find((w) => w.id === tab.windowId)!.incognito).toBe(tab.incognito);
    }
    expect(opened.filter((t) => t.incognito).map((t) => t.url).sort()).toEqual(['https://both.com', 'https://private.com']);
    expect(opened.filter((t) => !t.incognito).every((t) => t.windowId === here.windowId)).toBe(true);
  });

  it('"Reopen" brings an Incognito window back as an Incognito window; without access it says so', async () => {
    const { outcome } = await foldBoth();
    const result = await handleRestore({ type: 'restore', sessionId: outcome.sessionId!, mode: 'original' });
    expect(result.failed).toEqual([]);
    const created = chrome.createdWindows;
    expect(created.map((d) => !!d?.incognito).sort()).toEqual([false, true]);
    expect(chrome.tabs.filter((t) => t.url === 'https://private.com').every((t) => t.incognito)).toBe(true);

    chrome.incognitoAccess = false;
    const blocked = await handleRestore({ type: 'restore', sessionId: outcome.sessionId!, mode: 'original', force: true });
    expect(blocked.failed.map((f) => [f.url, f.reason]).sort()).toEqual([
      ['https://both.com', 'incognito'],
      ['https://private.com', 'incognito'],
    ]);
  });

  it('undo puts Incognito tabs back in Incognito and normal tabs in a normal window', async () => {
    const { outcome } = await foldBoth();
    expect(await handleUndo(outcome.actionId!)).toEqual({ undone: true });
    const back = chrome.webTabs();
    expect(back.map((t) => [t.url, t.incognito]).sort()).toEqual([
      ['https://a.com', false],
      ['https://both.com', false],
      ['https://both.com', true],
      ['https://private.com', true],
    ]);
    for (const tab of back) expect(chrome.windows.find((w) => w.id === tab.windowId)!.incognito).toBe(tab.incognito);
    expect(await db.tabs.count()).toBe(0);
    expect((await getSessionGraph(outcome.sessionId!))?.session.deletedAt ?? 1).toBeGreaterThan(0);
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
  it('the right-click menu has "Fold this tab", "Fold this tab with keywords…" and "Snooze this tab" with its times', async () => {
    vi.spyOn(fakeBrowser.contextMenus, 'removeAll').mockResolvedValue(undefined as never);
    const create = vi.spyOn(fakeBrowser.contextMenus, 'create').mockReturnValue(1 as never);
    vi.spyOn(fakeBrowser.contextMenus, 'update').mockResolvedValue(undefined as never);
    await createMenus();
    expect(create.mock.calls.map(([item]) => [item.id, item.title, item.contexts])).toEqual([
      [MENU.foldTab, 'Fold this tab', ['page', 'frame']],
      [MENU.foldTabKeywords, 'Fold this tab with keywords…', ['page', 'frame']],
      [MENU.snoozeTab, 'Snooze this tab', ['page', 'frame']],
      [`${MENU.snoozeTab}:later-today`, 'Later today', ['page', 'frame']],
      [`${MENU.snoozeTab}:tomorrow`, 'Tomorrow morning', ['page', 'frame']],
      [`${MENU.snoozeTab}:weekend`, 'This weekend', ['page', 'frame']],
      [`${MENU.snoozeTab}:next-week`, 'Next week', ['page', 'frame']],
      [`${MENU.snoozeTab}:month`, 'In a month', ['page', 'frame']],
    ]);
    expect(create.mock.calls.slice(3).every(([item]) => item.parentId === MENU.snoozeTab)).toBe(true);
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
