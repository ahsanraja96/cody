import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { resetGroupsFlagCache } from '@/lib/background/browserState';
import { handleFold } from '@/lib/background/fold';
import {
  onLiveGroupRemoved,
  onLiveTabCreated,
  onLiveTabRemoved,
  onLiveTabReplaced,
  onLiveTabUpdated,
  onLiveWindowRemoved,
  resetLiveRuntime,
  settleLive,
} from '@/lib/background/live';
import { route } from '@/lib/background/router';
import { handleUndo } from '@/lib/background/save';
import { resetTitleCache } from '@/lib/background/titles';
import { db } from '@/lib/db';
import { planState } from '@/lib/pro/state';
import { FREE_PLAN } from '@/lib/pro/types';
import { saveCapture } from '@/lib/repo';
import { lastAction, liveFolders } from '@/lib/state';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { FakeChrome, type FakeTab } from './chrome';
import { capturedWindow } from './fixtures';

vi.mock('@/lib/background/browserState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/background/browserState')>()),
  sleep: async () => undefined,
}));

let chrome: FakeChrome;

beforeEach(async () => {
  chrome = new FakeChrome().install();
  resetTitleCache();
  resetGroupsFlagCache();
  resetLiveRuntime();
  // Chrome's tab groups: a group exists while the fake has it.
  vi.spyOn(fakeBrowser.tabGroups, 'get').mockImplementation((async (id: number) => {
    const group = chrome.groups.find((g) => g.id === id);
    if (!group) throw new Error(`No group with id: ${id}.`);
    return group;
  }) as never);
  await planState.set({ ...FREE_PLAN, tier: 'pro' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const FOLDER: FolderRecord = { id: 'clientsites1', name: 'Client sites', color: 'green', order: 0, createdAt: 1, updatedAt: 1, deletedAt: 0 };

/** A folder with these tabs folded into it. */
async function folderWith(urls: string[], folder = FOLDER): Promise<TabRecord[]> {
  await db.folders.put(folder);
  const result = await saveCapture([capturedWindow(urls)], { name: 'Fold', source: 'save-all', deviceId: 'd', now: Date.now() - 1000 }, { dedupe: false });
  await db.tabs.where('id').anyOf(result.savedTabIds).modify({ folderId: folder.id });
  return db.tabs.where('sessionId').equals(result.sessionId).sortBy('order');
}

const view = (tab: FakeTab) => ({ ...tab }) as unknown as Browser.tabs.Tab;
const folderUrls = async (folderId = FOLDER.id) => (await db.tabs.where('folderId').equals(folderId).toArray()).map((t) => t.url).sort();

async function openLive(urls = ['https://a.com', 'https://b.com', 'https://c.com']) {
  const records = await folderWith(urls);
  const result = await route({ type: 'live-open', folderId: FOLDER.id });
  expect(result).toMatchObject({ ok: true });
  const binding = (await liveFolders.get())[FOLDER.id]!;
  const tabs = () => chrome.tabs.filter((t) => t.groupId === binding.groupId);
  return { records, binding, tabs, result: (result as { data: { opened: number; groupId: number } }).data };
}

describe('live-open', () => {
  it('opens the folder as a Chrome tab group with its name and colour, in a new window when this one is busy', async () => {
    const here = chrome.openWindow([{ url: 'https://work.com', active: true }], { focused: true });
    const { binding, tabs, result } = await openLive();
    expect(result.opened).toBe(3);
    expect(binding).toMatchObject({ folderId: FOLDER.id, groupId: result.groupId, openedAt: expect.any(Number) });
    expect(binding.windowId).not.toBe(here.windowId);
    expect(chrome.groups.find((g) => g.id === result.groupId)).toMatchObject({ title: 'Client sites', color: 'green', collapsed: false });
    expect(tabs().map((t) => t.url)).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    // The first is shown; the others loaded once in the background, then sleep.
    expect(tabs().map((t) => [t.active, t.discarded])).toEqual([
      [true, false],
      [false, true],
      [false, true],
    ]);
    // The new window's own New Tab went; the tabs stay in the list.
    expect(chrome.tabs.filter((t) => t.windowId === binding.windowId)).toHaveLength(3);
    expect(await folderUrls()).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('opens in this window when it has nothing else open, or when asked', async () => {
    const here = chrome.openWindow([{ url: 'chrome://newtab/', active: true }], { focused: true });
    const { binding } = await openLive(['https://a.com']);
    expect(binding.windowId).toBe(here.windowId);
  });

  it('is part of Pro', async () => {
    await planState.set(FREE_PLAN);
    await folderWith(['https://a.com']);
    expect(await route({ type: 'live-open', folderId: FOLDER.id })).toMatchObject({ ok: false, code: 'needs-pro' });
    expect(chrome.tabs).toHaveLength(0);
  });

  it('an empty folder opens as a group with a New Tab, which joins once it has a page', async () => {
    await db.folders.put(FOLDER);
    expect(await route({ type: 'live-open', folderId: FOLDER.id })).toMatchObject({ ok: true, data: { opened: 0 } });
    const binding = (await liveFolders.get())[FOLDER.id]!;
    const [blank] = chrome.tabs.filter((t) => t.groupId === binding.groupId);
    expect(blank!.url).toBe('chrome://newtab/');
    blank!.url = 'https://first.com';
    blank!.title = 'First page';
    await onLiveTabUpdated(blank!.id, { url: 'https://first.com' }, view(blank!));
    expect(await folderUrls()).toEqual(['https://first.com']);
  });

  it('"Switch": folding the other live folder first', async () => {
    chrome.openWindow([{ url: 'https://work.com', active: true }], { focused: true });
    const first = await openLive(['https://a.com']);
    const other: FolderRecord = { ...FOLDER, id: 'truewidgets1', name: 'Truewidgets', color: 'purple' };
    await folderWith(['https://t.com'], other);
    expect(await route({ type: 'live-open', folderId: other.id, foldOthers: true })).toMatchObject({ ok: true, data: { opened: 1 } });
    expect(first.tabs()).toHaveLength(0);
    expect(Object.keys(await liveFolders.get())).toEqual([other.id]);
    expect(await folderUrls()).toEqual(['https://a.com']);
  });

  it('a folder already live comes to the front instead', async () => {
    chrome.openWindow([{ url: 'https://work.com', active: true }], { focused: true });
    const { result } = await openLive(['https://a.com']);
    expect(await route({ type: 'live-open', folderId: FOLDER.id })).toMatchObject({ ok: true, data: { opened: 0, groupId: result.groupId } });
    expect(await route({ type: 'live-focus', folderId: FOLDER.id })).toEqual({ ok: true, data: { focused: true } });
    expect(chrome.focusCalls.at(-1)).toBe((await liveFolders.get())[FOLDER.id]!.windowId);
  });
});

describe('a live folder saves itself', () => {
  it('a tab that joins the group is saved to the folder; pages it goes to update its saved copy', async () => {
    const { binding } = await openLive(['https://a.com']);
    const joined = chrome.addTab(binding.windowId, { url: 'https://new.com', title: 'New page', groupId: binding.groupId });
    await onLiveTabCreated(view(joined));
    expect(await folderUrls()).toEqual(['https://a.com', 'https://new.com']);
    // Saved in the live folder's own fold; a second one joins the same fold.
    const second = chrome.addTab(binding.windowId, { url: 'https://two.com', groupId: -1 });
    second.groupId = binding.groupId;
    await onLiveTabUpdated(second.id, { groupId: binding.groupId }, view(second));
    const rows = await db.tabs.where('url').anyOf(['https://new.com', 'https://two.com']).toArray();
    expect(new Set(rows.map((r) => r.sessionId)).size).toBe(1);
    expect((await liveFolders.get())[FOLDER.id]!.liveSessionId).toBe(rows[0]!.sessionId);

    joined.url = 'https://new.com/pricing';
    joined.title = 'Pricing';
    await onLiveTabUpdated(joined.id, { url: joined.url }, view(joined));
    expect(await db.tabs.where('url').equals('https://new.com/pricing').first()).toMatchObject({ title: 'Pricing', folderId: FOLDER.id });

    // Tabs outside the group, and New Tab pages, aren't saved.
    const outside = chrome.addTab(binding.windowId, { url: 'https://outside.com' });
    await onLiveTabUpdated(outside.id, { url: outside.url }, view(outside));
    const blank = chrome.addTab(binding.windowId, { url: 'chrome://newtab/', groupId: binding.groupId });
    await onLiveTabCreated(view(blank));
    expect(await folderUrls()).toEqual(['https://a.com', 'https://new.com/pricing', 'https://two.com']);
  });

  it('a tab the person closes leaves the folder (Undo puts it back); one closed with its window stays', async () => {
    const { tabs } = await openLive(['https://a.com', 'https://b.com', 'https://c.com']);
    const [a, b] = tabs();
    await fakeBrowser.tabs.remove(a!.id);
    await onLiveTabRemoved(a!.id, { isWindowClosing: false });
    await settleLive();
    expect(await folderUrls()).toEqual(['https://b.com', 'https://c.com']);
    const action = (await lastAction.get())!;
    expect(action.putBack?.tabs.map((t) => t.url)).toEqual(['https://a.com']);
    await handleUndo(action.id);
    expect(await folderUrls()).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);

    await onLiveTabRemoved(b!.id, { isWindowClosing: true });
    await settleLive();
    expect(await folderUrls()).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('closing the whole group, or the window, keeps the folder and ends the live group', async () => {
    const { tabs, binding } = await openLive(['https://a.com', 'https://b.com']);
    for (const tab of tabs()) await onLiveTabRemoved(tab.id, { isWindowClosing: false });
    chrome.groups = chrome.groups.filter((g) => g.id !== binding.groupId);
    await onLiveGroupRemoved({ id: binding.groupId });
    await settleLive();
    expect(await folderUrls()).toEqual(['https://a.com', 'https://b.com']);
    expect(await liveFolders.get()).toEqual({});

    const again = await route({ type: 'live-open', folderId: FOLDER.id });
    expect(again).toMatchObject({ ok: true, data: { opened: 2 } });
    const windowId = (await liveFolders.get())[FOLDER.id]!.windowId;
    await onLiveWindowRemoved(windowId);
    expect(await liveFolders.get()).toEqual({});
  });

  it('a tab dragged out of the group leaves the folder; ungrouping them all keeps it', async () => {
    const { tabs, binding } = await openLive(['https://a.com', 'https://b.com', 'https://c.com']);
    const [a, b, c] = tabs();
    a!.groupId = -1;
    await onLiveTabUpdated(a!.id, { groupId: -1 }, view(a!));
    await settleLive();
    expect(await folderUrls()).toEqual(['https://b.com', 'https://c.com']);

    // Ungroup: every tab leaves and the group goes.
    for (const tab of [b!, c!]) {
      tab.groupId = -1;
      await onLiveTabUpdated(tab.id, { groupId: -1 }, view(tab));
    }
    chrome.groups = chrome.groups.filter((g) => g.id !== binding.groupId);
    await onLiveGroupRemoved({ id: binding.groupId });
    await settleLive();
    expect(await folderUrls()).toEqual(['https://b.com', 'https://c.com']);
  });

  it('tabs Tabfold folds stay in the folder (Fold folds the live group too)', async () => {
    chrome.openWindow([{ url: 'https://work.com', active: true }], { focused: true });
    const { tabs } = await openLive(['https://a.com', 'https://b.com']);
    const ids = tabs().map((t) => t.id);
    const outcome = await handleFold();
    expect(outcome.skippedDuplicates).toBe(2);
    for (const id of ids) await onLiveTabRemoved(id, { isWindowClosing: false });
    await settleLive();
    expect(await folderUrls()).toEqual(['https://a.com', 'https://b.com']);
  });

  it('a tab Chrome swaps for another is still the same saved tab', async () => {
    const { tabs, binding } = await openLive(['https://a.com']);
    const [a] = tabs();
    const replacement = chrome.addTab(binding.windowId, { url: 'https://a.com/next', title: 'Next', groupId: binding.groupId });
    await onLiveTabReplaced(replacement.id, a!.id);
    await onLiveTabUpdated(replacement.id, { url: replacement.url }, view(replacement));
    expect(await folderUrls()).toEqual(['https://a.com/next']);
  });
});

describe('live-fold', () => {
  it('"Fold the group": brings the saved copies up to date, closes the tabs and ends the live group', async () => {
    chrome.openWindow([{ url: 'https://work.com', active: true }], { focused: true });
    const { tabs, binding } = await openLive(['https://a.com', 'https://b.com']);
    const [a] = tabs();
    // A page change the worker hadn't heard about yet, and a tab not saved yet.
    a!.url = 'https://a.com/moved';
    a!.title = 'Moved';
    chrome.addTab(binding.windowId, { url: 'https://late.com', groupId: binding.groupId });
    expect(await route({ type: 'live-fold', folderId: FOLDER.id })).toEqual({ ok: true, data: { folded: 3 } });
    expect(tabs()).toHaveLength(0);
    expect(await folderUrls()).toEqual(['https://a.com/moved', 'https://b.com', 'https://late.com']);
    expect(await liveFolders.get()).toEqual({});
    expect(await route({ type: 'live-fold', folderId: FOLDER.id })).toEqual({ ok: true, data: { folded: 0 } });
  });
});
