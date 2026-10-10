import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { resetGroupsFlagCache } from '@/lib/background/browserState';
import { onCommand } from '@/lib/background/menus';
import { cancelRestore, handleRestore, handleRestoreSnapshot, sleepWhenLoaded } from '@/lib/background/restore';
import { describeOpenCopy } from '@/lib/background/restorePlan';
import { route } from '@/lib/background/router';
import { handleSave, handleUndo, preflightSave } from '@/lib/background/save';
import { MIRROR_MAX_TABS, mirrorOf, takeSnapshot } from '@/lib/background/snapshots';
import { suspendInactive, suspendTab } from '@/lib/background/suspend';
import { forgetPendingTitle, onTabUpdated, resetTitleCache } from '@/lib/background/titles';
import { onUpdateAvailable, onUpdated } from '@/lib/background/update';
import { getGroups } from '@/lib/background/browserState';
import { checkWiped } from '@/lib/dataGuard';
import { db } from '@/lib/db';
import { formatDateTime } from '@/lib/format';
import { clearAllData, deleteSessionsForever, getSessionGraph, importSessions, purgeTrash, saveCapture, trashSessions } from '@/lib/repo';
import { updateSettings } from '@/lib/settings';
import { activeRestore, dataGuard, groupsUnavailable, lastAction, pendingTitles, snapshotMirror, updateReady } from '@/lib/state';
import { MAX_URL_LENGTH } from '@/lib/urls';
import type { Command } from '@/lib/messages';
import { FakeChrome } from './chrome';
import { capturedTab, capturedWindow } from './fixtures';

// Closing waits 0.6 s for "Leave site?" tabs in Chrome; tests don't need to.
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

const OWN = fakeBrowser.runtime.getURL('/');

/** Save tabs straight into the database, as an earlier session. */
async function seed(name: string, urls: string[], now = Date.now()) {
  return saveCapture([capturedWindow(urls)], { name, source: 'save-all', deviceId: 'd', now }, { dedupe: false });
}

function save(command: Partial<Extract<Command, { type: 'save' }>>) {
  return handleSave({ type: 'save', scope: 'all', close: true, audible: 'close', ...command });
}

describe('preflight-save', () => {
  it('lists audible tabs, long addresses, duplicates and what closing would free', async () => {
    const older = await seed('Reading list', ['https://dup.com/a'], 1_000);
    const newer = await seed('Checkout app', ['https://dup.com/a', 'https://dup.com/b/'], 2_000);
    const longUrl = `https://long.com/?q=${'x'.repeat(MAX_URL_LENGTH + 100)}`;
    const { windowId, tabIds } = chrome.openWindow(
      [
        { url: 'https://music.com', audible: true },
        { url: '', pendingUrl: longUrl },
        'https://dup.com/a',
        'https://dup.com/b',
        { url: 'https://asleep.com', discarded: true },
        'chrome://newtab/',
        { url: 'https://mail.com', pinned: true },
      ],
      { focused: true },
    );

    const pre = await preflightSave({ type: 'preflight-save', scope: 'window', windowId });
    expect(pre.tabs).toBe(5);
    expect(pre.windows).toBe(1);
    expect(pre.pinnedKept).toBe(1);
    expect(pre.audible).toBe(1);
    expect(pre.audibleTabs).toEqual([{ tabId: tabIds[0], windowId, title: 'Title of https://music.com', url: 'https://music.com' }]);
    expect(pre.longUrls).toHaveLength(1);
    expect(pre.longUrls[0]).toMatchObject({ tabId: tabIds[1], windowId, length: longUrl.length });
    expect(pre.longUrls[0]!.url.length).toBe(MAX_URL_LENGTH);
    // Both are in "Checkout app", the most recently updated session that has them.
    expect(pre.duplicates.map((d) => [d.tabId, d.sessionId, d.sessionName])).toEqual([
      [tabIds[2], newer.sessionId, 'Checkout app'],
      [tabIds[3], newer.sessionId, 'Checkout app'],
    ]);
    // Saved tabs plus the skipped new tab page close; the discarded one frees nothing.
    expect(pre.closeTabs).toBe(6);
    expect(pre.freedBytes).toBe(5 * 48 * 1024 * 1024);
    expect(pre.nothingToSave).toBe(false);

    const intoOlder = await preflightSave({ type: 'preflight-save', scope: 'window', windowId, targetSessionId: older.sessionId });
    expect(intoOlder.duplicates.map((d) => d.sessionName)).toEqual(['Reading list', 'Checkout app']);
  });

  it('says there is nothing to save when only pinned, blank and Tabfold pages are open', async () => {
    const { windowId } = chrome.openWindow(
      [{ url: 'https://mail.com', pinned: true }, 'chrome://newtab/', `${OWN}library.html`],
      { focused: true },
    );
    const pre = await preflightSave({ type: 'preflight-save', scope: 'all', windowId });
    expect(pre).toMatchObject({ tabs: 0, windows: 0, nothingToSave: true, pinnedKept: 1, duplicates: [], longUrls: [] });
  });

  it('counts an Incognito window only when the user chose to save it', async () => {
    chrome.openWindow(['https://normal.com'], { focused: true });
    const { windowId } = chrome.openWindow(['https://private.com', 'https://private.com/2'], { incognito: true });
    expect((await preflightSave({ type: 'preflight-save', scope: 'window', windowId })).nothingToSave).toBe(true);
    const pre = await preflightSave({ type: 'preflight-save', scope: 'window', windowId, includeIncognito: true });
    expect(pre).toMatchObject({ tabs: 2, nothingToSave: false });
    // "Save all" never includes Incognito, even when asked.
    expect((await preflightSave({ type: 'preflight-save', scope: 'all', includeIncognito: true })).tabs).toBe(1);
  });
});

describe('save: duplicates', () => {
  it('skips tabs saved in any session, still closes them, and merges their keywords there', async () => {
    await updateSettings({ duplicates: 'skip' });
    const reading = await seed('Reading list', ['https://dup.com/']);
    chrome.openWindow(['https://keep-open.com'], { focused: true });
    const { windowId, tabIds } = chrome.openWindow(['https://new.com', 'https://dup.com']);
    const outcome = await save({ scope: 'window', windowId, keywordsByTabId: { [tabIds[1]!]: ['Later'] } });

    expect(outcome).toMatchObject({ savedTabs: 1, skippedDuplicates: 1, closedTabs: 2 });
    expect(chrome.tab(tabIds[1]!)).toBeUndefined();
    const graph = await getSessionGraph(outcome.sessionId!);
    expect(graph!.windows[0]!.tabs.map((t) => t.url)).toEqual(['https://new.com']);
    const existing = (await db.tabs.where('sessionId').equals(reading.sessionId).toArray())[0]!;
    expect(existing.keywords).toEqual(['later']);

    const action = await lastAction.get();
    expect(action?.reopenOnly).toEqual([{ url: 'https://dup.com', title: 'Title of https://dup.com', pinned: false, sourceWindowId: windowId }]);
  });

  it('undo reopens skipped duplicates too, in their window when it is still open', async () => {
    await updateSettings({ duplicates: 'skip' });
    await seed('Reading list', ['https://dup.com']);
    const { windowId, tabIds } = chrome.openWindow(['https://new.com', 'https://dup.com', { url: 'https://pinned.com', pinned: true }], {
      focused: true,
    });
    const outcome = await save({ scope: 'window', windowId });
    expect(chrome.webTabs().map((t) => t.url)).toEqual(['https://pinned.com']);

    expect(await handleUndo(outcome.actionId!)).toEqual({ undone: true });
    const reopened = chrome.webTabs().filter((t) => t.windowId === windowId).map((t) => t.url);
    expect(reopened.sort()).toEqual(['https://dup.com', 'https://new.com', 'https://pinned.com']);
    expect(chrome.tab(tabIds[0]!)).toBeUndefined();
    expect(await db.sessions.count()).toBe(1);
  });

  it('when every tab is already saved, writes nothing new but still closes them and can undo', async () => {
    await updateSettings({ duplicates: 'skip' });
    const reading = await seed('Reading list', ['https://a.com', 'https://b.com']);
    chrome.openWindow(['https://other.com'], { focused: true });
    const { windowId } = chrome.openWindow(['https://a.com', 'https://b.com']);
    const outcome = await save({ scope: 'window', windowId });
    expect(outcome).toMatchObject({ savedTabs: 0, skippedDuplicates: 2, closedTabs: 2, sessionId: reading.sessionId });
    expect(await db.sessions.count()).toBe(1);
    expect(outcome.actionId).not.toBeNull();

    await handleUndo(outcome.actionId!);
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://a.com', 'https://b.com', 'https://other.com']);
    expect((await db.sessions.get(reading.sessionId))!.tabCount).toBe(2);
  });

  it('the answer from the Ask sheet wins over the setting, and "ask" without an answer saves them again', async () => {
    await seed('Reading list', ['https://dup.com']);
    await updateSettings({ duplicates: 'skip' });
    let window = chrome.openWindow(['https://dup.com', 'https://x.com'], { focused: true });
    expect((await save({ scope: 'window', windowId: window.windowId, close: false, duplicates: 'keep' })).savedTabs).toBe(2);

    await updateSettings({ duplicates: 'ask' });
    window = chrome.openWindow(['https://dup.com', 'https://y.com']);
    expect((await save({ scope: 'window', windowId: window.windowId, close: false })).savedTabs).toBe(2);
  });

  it('keyboard shortcuts fold, and never save a tab that is already folded, whatever the old setting says', async () => {
    await seed('Reading list', ['https://dup.com']);
    await updateSettings({ duplicates: 'keep' });
    chrome.openWindow(['https://dup.com', 'https://z.com'], { focused: true });
    await onCommand('fold');
    expect(await db.tabs.where('url').equals('https://dup.com').count()).toBe(1);
    expect(await db.tabs.where('url').equals('https://z.com').count()).toBe(1);
    expect(chrome.webTabs()).toHaveLength(0);

    const { tabIds } = chrome.openWindow([{ url: 'https://dup.com', active: true }, 'https://w.com'], { focused: true });
    await onCommand('save-tab');
    expect(await db.tabs.where('url').equals('https://dup.com').count()).toBe(1);
    expect(chrome.tab(tabIds[0]!)).toBeUndefined();
    expect(chrome.tab(tabIds[1]!)).toBeDefined();
  });
});

describe('save: Incognito, long addresses and what changes while saving', () => {
  it('saves an Incognito window only when asked, and never puts it in a snapshot', async () => {
    chrome.openWindow(['https://normal.com'], { focused: true });
    const { windowId } = chrome.openWindow(['https://private.com'], { incognito: true });
    expect((await save({ scope: 'window', windowId, close: false })).savedTabs).toBe(0);
    const outcome = await save({ scope: 'window', windowId, includeIncognito: true });
    expect(outcome).toMatchObject({ savedTabs: 1, closedTabs: 1 });

    chrome.openWindow(['https://private2.com'], { incognito: true });
    expect((await save({ scope: 'all', includeIncognito: true, close: false })).savedTabs).toBe(1);
    expect(await db.tabs.where('url').equals('https://private2.com').count()).toBe(0);

    await takeSnapshot('manual');
    const urls = (await db.snapshots.toArray()).flatMap((s) => s.windows.flatMap((w) => w.tabs.map((t) => t.url)));
    expect(urls).not.toContain('https://private2.com');
  });

  it('undoes an Incognito save back into Incognito, never into a normal window', async () => {
    chrome.openWindow(['https://normal.com'], { focused: true });
    const { windowId } = chrome.openWindow(['https://private.com', 'https://private2.com'], { incognito: true });
    const outcome = await save({ scope: 'window', windowId, includeIncognito: true });
    expect(outcome.closedTabs).toBe(2);
    expect(await handleUndo(outcome.actionId!)).toEqual({ undone: true });
    const reopened = chrome.tabs.filter((t) => t.url.startsWith('https://private'));
    const viaNewWindow = chrome.createdWindows.find((d) => d?.incognito);
    if (reopened.length) {
      for (const tab of reopened) expect(chrome.windows.find((w) => w.id === tab.windowId)?.incognito).toBe(true);
    } else {
      expect(viaNewWindow?.url).toEqual(['https://private.com', 'https://private2.com']);
    }
    expect(chrome.createdWindows.filter((d) => !d?.incognito)).toHaveLength(0);
  });

  it('keeps Chrome open when saving its only (Incognito) window', async () => {
    const { windowId } = chrome.openWindow(['https://private.com'], { incognito: true, focused: true });
    await save({ scope: 'window', windowId, includeIncognito: true });
    expect(chrome.windows).toHaveLength(1);
    expect(chrome.tabs.map((t) => t.url)).toEqual(['chrome://newtab/']);
  });

  it('reports cut addresses, tabs that refused to close, and new tabs left open', async () => {
    const longUrl = `https://long.com/?q=${'x'.repeat(MAX_URL_LENGTH)}`;
    chrome.openWindow(['https://elsewhere.com'], { focused: true });
    const { windowId, tabIds } = chrome.openWindow([longUrl, 'https://form.com', 'https://c.com']);
    chrome.refuseClose.add(tabIds[1]!);
    // A tab opens in the saved window while the save is being written.
    let opened = false;
    chrome.beforeWindowsRead = async () => {
      if (opened || (await db.tabs.count()) === 0) return;
      opened = true;
      chrome.addTab(windowId, { url: 'https://opened-meanwhile.com' });
    };
    const outcome = await save({ scope: 'window', windowId });
    expect(outcome.savedTabs).toBe(3);
    expect(outcome.truncatedTabs).toBe(1);
    expect(outcome.closedTabs).toBe(2);
    expect(outcome.failedToClose).toEqual([{ tabId: tabIds[1], windowId, title: 'Title of https://form.com', url: 'https://form.com' }]);
    expect(outcome.newTabsLeftOpen).toBe(1);
    expect(outcome.freedBytes).toBe(2 * 48 * 1024 * 1024);
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://elsewhere.com', 'https://form.com', 'https://opened-meanwhile.com']);

    // Undo doesn't open a second copy of the tab that never closed.
    await handleUndo(outcome.actionId!);
    expect(chrome.webTabs().filter((t) => t.url === 'https://form.com')).toHaveLength(1);
    expect(chrome.webTabs().filter((t) => t.url === 'https://c.com')).toHaveLength(1);
  });
});

describe('title fill-in for tabs saved while loading', () => {
  it('fills the real title in when it arrives, and forgets the tab afterwards', async () => {
    const { windowId, tabIds } = chrome.openWindow(
      [{ url: 'https://docs.example.com/guide', title: '', status: 'loading' }, 'https://ready.com'],
      { focused: true },
    );
    const outcome = await save({ scope: 'window', windowId, close: false });
    const pending = await pendingTitles.get();
    expect(Object.keys(pending)).toEqual([String(tabIds[0])]);
    const savedId = pending[tabIds[0]!]!;
    expect((await db.tabs.get(savedId))!.title).toBe('docs.example.com');

    const tab = { ...chrome.tab(tabIds[0]!)!, title: 'Row level security | Docs' };
    // Chrome shows the address as a title while loading: not a real one.
    await onTabUpdated(tabIds[0]!, { title: 'docs.example.com/guide' }, { ...tab, title: 'docs.example.com/guide' } as never);
    expect((await db.tabs.get(savedId))!.title).toBe('docs.example.com');
    await onTabUpdated(tabIds[0]!, { title: tab.title }, tab as never);
    expect((await db.tabs.get(savedId))!.title).toBe('Row level security | Docs');
    const session = await db.sessions.get(outcome.sessionId!);
    expect(session!.preview.find((p) => p.url === 'https://docs.example.com/guide')!.title).toBe('Row level security | Docs');
    expect(await pendingTitles.get()).toEqual({});
  });

  it('keeps waiting when a page finishes loading and sets its title from a script later', async () => {
    const url = 'http://127.0.0.1:8080/app';
    const { windowId, tabIds } = chrome.openWindow([{ url, title: '127.0.0.1:8080/app', status: 'loading' }], { focused: true });
    await save({ scope: 'window', windowId, close: false });
    const savedId = (await pendingTitles.get())[tabIds[0]!]!;
    expect((await db.tabs.get(savedId))!.title).toBe('127.0.0.1');
    const loaded = { ...chrome.tab(tabIds[0]!)!, status: 'complete', title: '127.0.0.1:8080/app' };
    await onTabUpdated(tabIds[0]!, { status: 'complete' }, loaded as never);
    expect(Object.keys(await pendingTitles.get())).toHaveLength(1);
    await onTabUpdated(tabIds[0]!, { title: 'Dashboard' }, { ...loaded, title: 'Dashboard' } as never);
    expect((await db.tabs.get(savedId))!.title).toBe('Dashboard');
    expect(await pendingTitles.get()).toEqual({});
  });

  it('forgets a tab that closes or goes to another site', async () => {
    const { windowId, tabIds } = chrome.openWindow(
      [
        { url: 'https://a.com/x', title: '', status: 'loading' },
        { url: 'https://b.com/y', title: '', status: 'loading' },
      ],
      { focused: true },
    );
    await save({ scope: 'window', windowId, close: false });
    expect(Object.keys(await pendingTitles.get())).toHaveLength(2);
    await forgetPendingTitle(tabIds[0]!);
    const moved = { ...chrome.tab(tabIds[1]!)!, url: 'https://other.org/', title: 'Other' };
    await onTabUpdated(tabIds[1]!, { title: 'Other' }, moved as never);
    expect(await pendingTitles.get()).toEqual({});
    expect((await db.tabs.toArray()).some((t) => t.title === 'Other')).toBe(false);
  });

  it('remembers nothing when the tabs close', async () => {
    const { windowId } = chrome.openWindow([{ url: 'https://a.com/x', title: '' }]);
    chrome.openWindow(['https://b.com'], { focused: true });
    await save({ scope: 'window', windowId });
    expect(await pendingTitles.get()).toEqual({});
  });
});

describe('suspend inactive: tabs kept awake', () => {
  it('lists the active, pinned, audible, protected and refused tabs, not ones already asleep or not web pages', async () => {
    const { windowId, tabIds } = chrome.openWindow(
      [
        { url: 'https://active.com', active: true },
        { url: 'https://pinned.com', pinned: true },
        { url: 'https://music.com', audible: true },
        'https://meet.google.com/abc',
        { url: 'https://asleep.com', discarded: true },
        'chrome://settings',
        'https://idle.com',
      ],
      { focused: true },
    );
    const other = chrome.openWindow([{ url: 'https://other-active.com', active: true }, 'https://idle2.com']);
    chrome.openWindow([{ url: `${OWN}library.html`, active: true }]);
    const refused = other.tabIds[1]!;
    const discard = fakeBrowser.tabs.discard as unknown as Mock<(id: number) => Promise<unknown>>;
    const real = discard.getMockImplementation()!;
    discard.mockImplementation(async (id: number) => {
      if (id === refused) throw new Error('no');
      return real(id);
    });

    const outcome = await suspendInactive();
    expect(outcome.suspended).toBe(1);
    expect(outcome.keptAwake.map((t) => [t.url, t.reason])).toEqual([
      ['https://active.com', 'active'],
      ['https://pinned.com', 'pinned'],
      ['https://music.com', 'audible'],
      ['https://meet.google.com/abc', 'protectedSite'],
      ['https://other-active.com', 'active'],
      ['https://idle2.com', 'failed'],
    ]);
    expect(outcome.keptAwake[0]).toMatchObject({ tabId: tabIds[0], windowId, title: 'Title of https://active.com' });
    expect(outcome.skipped).toMatchObject({ active: 3, pinned: 1, audible: 1, protectedSite: 1, already: 1, failed: 1 });

    const single = await suspendTab(tabIds[0]!);
    expect(single.keptAwake.map((t) => t.reason)).toEqual(['active']);
  });
});

describe('restore', () => {
  it('lets background tabs load once, muted, before putting them to sleep, so they keep their address', async () => {
    const { sessionId } = await seed('Lazy', ['https://one.com', 'https://two.com', 'https://three.com']);
    const outcome = await handleRestore({ type: 'restore', sessionId, mode: 'original' });
    expect(outcome.opened).toBe(3);
    const restored = chrome.tabs.filter((t) => ['https://two.com', 'https://three.com'].includes(t.url));
    expect(restored.map((t) => t.discarded)).toEqual([true, true]);
    // Discarded only once loaded, never while the page was still on its way.
    for (const entry of chrome.discardLog) expect(entry.status).toBe('complete');
    // Muted while loading, unmuted again once asleep.
    for (const tab of restored) {
      const log = chrome.mutedLog.filter((m) => m.id === tab.id).map((m) => m.muted);
      expect(log).toEqual([true, false]);
    }
    // The first tab of the window is the one you see: loaded, never muted or discarded.
    const first = chrome.tabs.find((t) => t.url === 'https://one.com')!;
    expect(first.discarded).toBeFalsy();
    expect(chrome.mutedLog.some((m) => m.id === first.id)).toBe(false);
  });

  it('never puts a tab to sleep before its page exists, and puts slow pages to sleep after the timeout', async () => {
    const { windowId } = chrome.openWindow(['https://here.com'], { focused: true });
    const blank = chrome.addTab(windowId, { url: 'about:blank', status: 'loading' });
    const slow = chrome.addTab(windowId, { url: 'https://slow.com', status: 'loading' });
    chrome.stuckLoading.add(blank.id);
    chrome.stuckLoading.add(slow.id);
    await sleepWhenLoaded(blank.id, 300);
    await sleepWhenLoaded(slow.id, 300);
    expect(chrome.tab(blank.id)!.discarded).toBeFalsy();
    expect(chrome.tab(slow.id)!.discarded).toBe(true);
  });

  it('gives each failure a reason and counts local files that need file access', async () => {
    const { sessionId } = await seed('Mixed', [
      'https://ok.com',
      'file:///Users/me/invoice.pdf',
      `${OWN}library.html`,
      'javascript:alert(1)',
      'chrome://crash',
    ]);
    const outcome = await handleRestore({ type: 'restore', sessionId, mode: 'original' });
    expect(outcome.opened).toBe(1);
    expect(outcome.failed.map((f) => [f.url, f.reason])).toEqual([
      ['file:///Users/me/invoice.pdf', 'file-access'],
      [`${OWN}library.html`, 'blocked'],
      ['javascript:alert(1)', 'blocked'],
      ['chrome://crash', 'error'],
    ]);
    expect(outcome.needsFileAccess).toBe(1);

    chrome.fileAccess = true;
    const allowed = await handleRestore({ type: 'restore', sessionId, mode: 'new-window', force: true });
    expect(allowed.needsFileAccess).toBe(0);
    expect(allowed.opened).toBe(2);
  });

  it('describes an open copy: every window holding it, how many tabs are open, ignoring Incognito', async () => {
    const graph = await saveCapture(
      [capturedWindow(['https://a.com', 'https://b.com', 'https://c.com']), capturedWindow(['https://d.com', 'https://e.com'])],
      { name: 'Two windows', source: 'save-all', deviceId: 'd', now: 1 },
      { dedupe: false },
    );
    const first = chrome.openWindow(['https://a.com', 'https://b.com', 'https://c.com'], { focused: true });
    const second = chrome.openWindow(['https://d.com', 'https://zzz.com']);
    chrome.openWindow(['https://e.com'], { incognito: true });
    const outcome = await handleRestore({ type: 'restore', sessionId: graph.sessionId, mode: 'original' });
    expect(outcome.opened).toBe(0);
    expect(outcome.alreadyOpenWindowId).toBe(first.windowId);
    expect(outcome.alreadyOpen).toEqual({ windowIds: [first.windowId, second.windowId], openTabs: 4, totalTabs: 5 });
    expect(chrome.events('restore-done')).toHaveLength(0);

    expect(describeOpenCopy(['https://a.com', 'https://b.com'], [{ id: 1, tabs: [{ url: 'https://a.com' }] }])).toBeUndefined();
  });

  it('in the background, opens unfocused windows and focuses the first one at the end', async () => {
    chrome.openWindow(['https://here.com'], { focused: true });
    const graph = await saveCapture(
      [capturedWindow(['https://a.com', 'https://b.com']), capturedWindow(['https://c.com'])],
      { name: 'Two windows', source: 'save-all', deviceId: 'd', now: 1 },
      { dedupe: false },
    );
    await handleRestore({ type: 'restore', sessionId: graph.sessionId, mode: 'original', background: true });
    expect(chrome.createdWindows.map((c) => c?.focused)).toEqual([false, false]);
    expect(chrome.createdWindows.every((c) => c?.incognito === false)).toBe(true);
    const created = chrome.windows.slice(-2).map((w) => w.id);
    expect(chrome.focusCalls).toEqual([created[0]]);
  });

  it('keeps activeRestore and progress events up to date, then clears it and reports the outcome', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://site${i}.com`);
    const graph = await saveCapture(
      [capturedWindow(urls.slice(0, 15)), capturedWindow(urls.slice(15))],
      { name: 'Big one', source: 'save-all', deviceId: 'd', now: 1 },
      { dedupe: false },
    );
    const seen: unknown[] = [];
    const stop = activeRestore.watch((value) => seen.push(value && { ...value }));
    const outcome = await handleRestore({ type: 'restore', sessionId: graph.sessionId, mode: 'original' });
    stop();

    const progress = chrome.events('restore-progress');
    expect(progress.map((p) => [p.done, p.windowIndex, p.windowCount])).toEqual([
      [0, 0, 2],
      [10, 0, 2],
      [15, 0, 2],
      [25, 1, 2],
    ]);
    expect(progress.every((p) => p.sessionId === graph.sessionId && p.total === 25)).toBe(true);
    expect(seen[0]).toMatchObject({ restoreId: outcome.restoreId, sessionId: graph.sessionId, name: 'Big one', done: 0, total: 25 });
    expect(seen.at(-1)).toBeFalsy();
    expect(await activeRestore.get()).toBeUndefined();
    expect(chrome.events('restore-done')).toEqual([{ type: 'restore-done', restoreId: outcome.restoreId, outcome }]);
  });

  it('stops after the current batch when cancelled, and clears the progress', async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://site${i}.com`);
    const graph = await saveCapture([capturedWindow(urls)], { name: 'Many', source: 'save-all', deviceId: 'd', now: 1 }, { dedupe: false });
    const stop = activeRestore.watch((value) => {
      if (value && value.done === 10) cancelRestore(value.restoreId);
    });
    const outcome = await handleRestore({ type: 'restore', sessionId: graph.sessionId, mode: 'original' });
    stop();
    expect(outcome.cancelled).toBe(true);
    expect(outcome.opened).toBeLessThan(30);
    expect(await activeRestore.get()).toBeUndefined();
    expect(chrome.events('restore-done')[0]).toMatchObject({ outcome: { cancelled: true } });
  });

  it('never restores into an Incognito window', async () => {
    const { windowId } = chrome.openWindow(['https://private.com'], { incognito: true, focused: true });
    const { sessionId } = await seed('One', ['https://a.com']);
    await handleRestore({ type: 'restore', sessionId, mode: 'current', currentWindowId: windowId });
    const opened = chrome.tabs.find((t) => t.url === 'https://a.com')!;
    expect(opened.windowId).not.toBe(windowId);
    expect(chrome.windows.find((w) => w.id === opened.windowId)!.incognito).toBe(false);
  });

  it('names a snapshot restore after the snapshot time', async () => {
    chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    const snapshotId = (await takeSnapshot('manual'))!;
    const snapshot = (await db.snapshots.get(snapshotId))!;
    const seen: string[] = [];
    const stop = activeRestore.watch((value) => value && seen.push(value.name));
    const outcome = await handleRestoreSnapshot({ type: 'restore-snapshot', snapshotId, mode: 'new-window' });
    stop();
    expect(outcome.opened).toBe(2);
    expect(seen[0]).toBe(`Snapshot · ${formatDateTime(snapshot.createdAt)}`);
    expect(chrome.events('restore-progress')[0]).toMatchObject({ sessionId: null, windowCount: 1 });
  });
});

describe('snapshot mirror and wipe recovery', () => {
  it('copies the automatic snapshot to chrome.storage, capped and without inline favicons', async () => {
    chrome.openWindow([{ url: 'https://a.com', favIconUrl: 'data:image/png;base64,xyz' }, 'https://b.com'], { focused: true });
    await takeSnapshot('manual');
    expect(await snapshotMirror.get()).toBeUndefined();
    await takeSnapshot('timer');
    const mirror = (await snapshotMirror.get())!;
    expect(mirror).toMatchObject({ tabCount: 2, windowCount: 1 });
    expect(mirror.windows[0]!.tabs.map((t) => [t.url, t.favIconUrl])).toEqual([
      ['https://a.com', ''],
      ['https://b.com', ''],
    ]);

    const big = [capturedWindow(Array.from({ length: 1500 }, (_, i) => `https://x${i}.com`)), capturedWindow(Array.from({ length: 900 }, (_, i) => `https://y${i}.com`))];
    const capped = mirrorOf(big, 5);
    expect(capped.tabCount).toBe(MIRROR_MAX_TABS);
    expect(capped.windows.map((w) => w.tabs.length)).toEqual([1500, 500]);
  });

  it('turns the mirror into a "Recovered" session, or returns null without one', async () => {
    expect(await route({ type: 'recover-from-mirror' })).toEqual({ ok: true, data: { sessionId: null } });
    const createdAt = Date.now() - 60_000;
    await snapshotMirror.set({ createdAt, tabCount: 3, windowCount: 1, windows: [capturedWindow(['https://a.com', 'https://a.com', 'https://b.com'])] });
    const response = (await route({ type: 'recover-from-mirror' })) as { ok: true; data: { sessionId: string } };
    const graph = await getSessionGraph(response.data.sessionId);
    expect(graph!.session.name).toBe(`Recovered · ${formatDateTime(createdAt)}`);
    expect(graph!.session.tabCount).toBe(3);
    expect((await dataGuard.get())?.sessions).toBe(1);
  });

  it('keeps the data guard current after saves and imports, and resets it only when Tabfold empties the library', async () => {
    chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    const first = await save({ scope: 'all', close: false });
    expect(await dataGuard.get()).toMatchObject({ sessions: 1, tabs: 2 });
    await importSessions([{ name: 'Imported', createdAt: null, windows: [capturedWindow(['https://c.com'])] }], 'd');
    expect(await dataGuard.get()).toMatchObject({ sessions: 2, tabs: 3 });

    // A wipe from outside (e.g. "Clear browsing data") is noticed...
    await db.sessions.clear();
    await db.tabs.clear();
    expect((await checkWiped()).wiped).toBe(true);
    // ...and deleting rows that are already gone doesn't hide it.
    await deleteSessionsForever([first.sessionId!]);
    await purgeTrash();
    expect((await checkWiped()).wiped).toBe(true);

    // Tabfold's own deletes that empty the library reset it.
    const again = await seed('Again', ['https://d.com']);
    await trashSessions([again.sessionId]);
    await purgeTrash(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(await dataGuard.get()).toMatchObject({ sessions: 0 });
    expect((await checkWiped()).wiped).toBe(false);

    const third = await seed('Third', ['https://e.com']);
    await importSessions([{ name: 'Imported', createdAt: null, windows: [capturedWindow(['https://f.com'])] }], 'd');
    await deleteSessionsForever([third.sessionId]);
    expect((await dataGuard.get())?.sessions).toBe(2);
  });

  it('Clear all data resets the guard and drops the mirror', async () => {
    await seed('One', ['https://a.com']);
    await importSessions([], 'd');
    await snapshotMirror.set({ createdAt: 1, tabCount: 1, windowCount: 1, windows: [capturedWindow(['https://a.com'])] });
    await dataGuard.set({ sessions: 5, tabs: 9, at: 1 });
    await clearAllData();
    expect(await dataGuard.get()).toMatchObject({ sessions: 0, tabs: 0 });
    expect(await snapshotMirror.get()).toBeUndefined();
  });
});

describe('update ready', () => {
  it('reloads at once when no Tabfold page is open, and waits when one is', async () => {
    const reload = vi.spyOn(fakeBrowser.runtime, 'reload').mockImplementation(() => undefined);
    let open: unknown[] = [];
    const contexts = vi.spyOn(fakeBrowser.runtime, 'getContexts').mockImplementation((async () => open) as never);
    await onUpdateAvailable('1.1.0');
    expect(contexts).toHaveBeenCalledWith({ contextTypes: ['TAB', 'POPUP'] });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await updateReady.get()).toMatchObject({ version: '1.1.0' });

    open = [{ contextType: 'TAB' }];
    await onUpdateAvailable('1.2.0');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await updateReady.get()).toMatchObject({ version: '1.2.0' });

    await onUpdated();
    expect(await updateReady.get()).toBeUndefined();
  });

  it('without runtime.getContexts, looks for Tabfold tabs', async () => {
    const reload = vi.spyOn(fakeBrowser.runtime, 'reload').mockImplementation(() => undefined);
    const original = fakeBrowser.runtime.getContexts;
    (fakeBrowser.runtime as { getContexts?: unknown }).getContexts = undefined;
    try {
      chrome.openWindow([`${OWN}library.html`]);
      await onUpdateAvailable('1.1.0');
      expect(reload).not.toHaveBeenCalled();
      chrome.tabs = [];
      await onUpdateAvailable('1.1.0');
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      fakeBrowser.runtime.getContexts = original;
    }
  });
});

describe('tab groups blocked', () => {
  it('flags groupsUnavailable while the API throws, and writes only when it changes', async () => {
    const set = vi.spyOn(fakeBrowser.storage.local, 'set');
    const writes = () => set.mock.calls.filter(([items]) => 'groupsUnavailable' in (items as object)).length;
    await getGroups();
    expect(await groupsUnavailable.get()).toBe(false);
    expect(writes()).toBe(0);
    chrome.groupsBlocked = true;
    await getGroups();
    await getGroups();
    expect(await groupsUnavailable.get()).toBe(true);
    expect(writes()).toBe(1);
    chrome.groupsBlocked = false;
    await getGroups();
    expect(await groupsUnavailable.get()).toBe(false);
    expect(writes()).toBe(2);
  });
});

describe('keywords for a skipped duplicate', () => {
  it('land on the saved copy in the target session first', async () => {
    const a = await seed('A', ['https://dup.com']);
    const b = await seed('B', ['https://dup.com']);
    const window = capturedWindow([]);
    window.tabs = [capturedTab('https://dup.com', { keywords: ['one'] })];
    const result = await saveCapture([window], { source: 'save-tabs', deviceId: 'd', now: 5 }, { dedupe: true, targetSessionId: a.sessionId });
    expect(result).toMatchObject({ savedTabIds: [], skippedDuplicates: 1, sessionId: a.sessionId });
    const keywords = async (sessionId: string) => (await db.tabs.where('sessionId').equals(sessionId).first())!.keywords;
    expect(await keywords(a.sessionId)).toEqual(['one']);
    expect(await keywords(b.sessionId)).toEqual([]);
  });
});
