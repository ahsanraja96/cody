import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { resetAutomationRuntime, windowCapTick } from '@/lib/background/automation';
import { resetGroupsFlagCache } from '@/lib/background/browserState';
import { handleFold } from '@/lib/background/fold';
import { forgetGroupFolder } from '@/lib/background/foldBack';
import { foldIntoMenuItems, MENU, onCommand, onMenuClicked, refreshFoldIntoMenu, resetMenusRuntime } from '@/lib/background/menus';
import { route } from '@/lib/background/router';
import { handleUndo } from '@/lib/background/save';
import { resetTitleCache } from '@/lib/background/titles';
import { applyToolbarSetting, refreshWindowHint, resetToolbarRuntime } from '@/lib/background/toolbar';
import { matchScore, resetWindowNamesRuntime, restoreWindowNames, windowUrlKeys } from '@/lib/background/windowNames';
import { db } from '@/lib/db';
import { CATEGORIES, KIND_GROUP_COLORS } from '@/lib/categories';
import { cleanFolderNote } from '@/lib/folders';
import type { Command, CommandResults } from '@/lib/messages';
import { planState } from '@/lib/pro/state';
import { FREE_PLAN } from '@/lib/pro/types';
import { saveCapture } from '@/lib/repo';
import { updateSettings, type AutoFoldRule } from '@/lib/settings';
import {
  autoFoldNotice,
  groupFolders,
  lastAction,
  liveFolders,
  namedWindows,
  pendingFoldAsk,
  pendingFoldInto,
  recentFolders,
  siteKinds,
  starredTeamFolders,
  weeklyStats,
  weeklySummarySeen,
  windowNames,
} from '@/lib/state';
import { urlKey } from '@/lib/sync/records';
import { isTeamSession } from '@/lib/teams';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { weekKey } from '@/lib/weekly';
import { FakeChrome } from './chrome';
import { capturedWindow } from './fixtures';

// The 1.0 worker in a fake Chrome: fold back, Fold into, "Fold this tab into ›", close the copies,
// tidy into groups, the window-cap rule, named windows, stars and notes, weekly numbers and the
// toolbar button.

vi.mock('@/lib/background/browserState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/background/browserState')>()),
  sleep: async () => undefined,
}));

let chrome: FakeChrome;

beforeEach(() => {
  chrome = new FakeChrome().install();
  resetTitleCache();
  resetGroupsFlagCache();
  resetAutomationRuntime();
  resetMenusRuntime();
  resetToolbarRuntime();
  resetWindowNamesRuntime();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY = 24 * 60 * 60 * 1000;

async function send<C extends Command>(command: C): Promise<CommandResults[C['type']]> {
  const response = await route(command);
  if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code });
  return response.data as CommandResults[C['type']];
}

const folder = (id: string, name: string, extra: Partial<FolderRecord> = {}): FolderRecord => ({
  id,
  name,
  color: 'green',
  order: 0,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: 0,
  ...extra,
});

const CLIENT = folder('clientsites1', 'Client sites');
const RECIPES = folder('recipes00001', 'Recipes', { color: 'orange', order: 1 });

/** Fold these pages into the list (in a folder, or by kind of site), a while ago. */
async function folded(urls: string[], into?: FolderRecord): Promise<TabRecord[]> {
  if (into) await db.folders.put(into);
  const result = await saveCapture([capturedWindow(urls)], { name: 'Earlier', source: 'save-all', deviceId: 'd', now: Date.now() - DAY }, { dedupe: false });
  if (into) await db.tabs.where('id').anyOf(result.savedTabIds).modify({ folderId: into.id });
  return db.tabs.where('sessionId').equals(result.sessionId).sortBy('order');
}

const placement = async () => Object.fromEntries((await db.tabs.toArray()).map((t) => [t.url, t.folderId ?? null]));

// ---------------------------------------------------------------------------------------------

describe('fold back into its folder', () => {
  it('"Open all" from a folder remembers its group; folding it puts the tabs, and ones added since, back', async () => {
    const rows = await folded(['https://a.com', 'https://b.com'], CLIENT);
    const { windowId } = chrome.openWindow(['https://other.com'], { focused: true });
    const opened = await send({ type: 'open-tabs', tabRecordIds: rows.map((r) => r.id), asGroup: { name: 'Client sites', color: 'green' }, folderId: CLIENT.id, windowId });
    expect(opened.opened).toBe(2);
    const group = chrome.groups[0]!;
    expect(await groupFolders.get()).toEqual({ [group.id]: CLIENT.id });
    // Renamed in Chrome since: the link still holds.
    group.title = 'Client stuff';
    chrome.addTab(windowId, { url: 'https://new.com', groupId: group.id });

    const outcome = await handleFold({ windowId });
    expect(outcome.backIntoFolders).toEqual([{ folderId: CLIENT.id, name: 'Client sites', tabs: 1 }]);
    expect(outcome.intoFolder).toBeUndefined();
    // No duplicates: the folder's own tabs were already there.
    expect(await placement()).toEqual({
      'https://a.com': CLIENT.id,
      'https://b.com': CLIENT.id,
      'https://new.com': CLIENT.id,
      'https://other.com': null,
    });
    expect(await recentFolders.get()).toHaveProperty(CLIENT.id);

    // The group closing forgets it.
    await forgetGroupFolder(group.id);
    expect(await groupFolders.get()).toEqual({});
  });

  it('after a restart (no link), a group with the folder’s name folds back into it', async () => {
    await db.folders.bulkPut([CLIENT, RECIPES]);
    const { windowId, tabIds } = chrome.openWindow(['https://a.com', 'https://b.com', 'https://c.com'], { focused: true });
    chrome.makeGroup([tabIds[0]!, tabIds[1]!], { title: ' client SITES ', color: 'green' });
    const outcome = await handleFold({ windowId });
    expect(outcome.backIntoFolders).toEqual([{ folderId: CLIENT.id, name: 'Client sites', tabs: 2 }]);
    expect(await placement()).toEqual({ 'https://a.com': CLIENT.id, 'https://b.com': CLIENT.id, 'https://c.com': null });
  });

  it('a page folded already moves into the folder when it’s in none (it counts), and stays put in another folder', async () => {
    await db.folders.bulkPut([CLIENT, RECIPES]);
    await folded(['https://loose.com']);
    await folded(['https://recipe.com'], RECIPES);
    const { windowId, tabIds } = chrome.openWindow(['https://loose.com', 'https://recipe.com', 'https://fresh.com'], { focused: true });
    chrome.makeGroup(tabIds, { title: 'Client sites' });
    const outcome = await handleFold({ windowId });
    expect(outcome).toMatchObject({ savedTabs: 1, skippedDuplicates: 2, backIntoFolders: [{ folderId: CLIENT.id, tabs: 2 }] });
    expect(await placement()).toEqual({ 'https://loose.com': CLIENT.id, 'https://recipe.com': RECIPES.id, 'https://fresh.com': CLIENT.id });

    // Undo: the tabs open again, the new one leaves, the old copy is in no folder again.
    expect(await handleUndo(outcome.actionId!)).toEqual({ undone: true });
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://fresh.com', 'https://loose.com', 'https://recipe.com']);
    expect(await placement()).toEqual({ 'https://loose.com': null, 'https://recipe.com': RECIPES.id });
  });

  it('a team folder’s group folds back into the team folder (shared, as added by this person); Undo takes it back', async () => {
    await planState.set({ ...FREE_PLAN, tier: 'pro-ai', email: 'ada@example.com', team: { id: 'team1', name: 'Truewidgets', role: 'member', seats: 3 } });
    const team = folder('teamfolder01', 'Launch', { teamId: 'team1' });
    await db.folders.put(team);
    const { windowId, tabIds } = chrome.openWindow(['https://launch.com', 'https://mine.com'], { focused: true });
    chrome.makeGroup([tabIds[0]!], { title: 'Launch' });
    const outcome = await handleFold({ windowId });
    expect(outcome.backIntoFolders).toEqual([{ folderId: team.id, name: 'Launch', tabs: 1 }]);
    const shared = (await db.tabs.where('folderId').equals(team.id).toArray())[0]!;
    expect(shared).toMatchObject({ url: 'https://launch.com', addedBy: 'ada@example.com' });
    expect(isTeamSession(await db.sessions.get(shared.sessionId))).toBe(true);
    expect(await placement()).toEqual({ 'https://launch.com': team.id, 'https://mine.com': null });

    expect(await handleUndo(outcome.actionId!)).toEqual({ undone: true });
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://launch.com', 'https://mine.com']);
    expect(await db.tabs.where('folderId').equals(team.id).count()).toBe(0);
  });

  it('a rule never shares tabs with a team: a team folder’s group folds by kind of site then', async () => {
    await planState.set({ ...FREE_PLAN, tier: 'pro-ai', email: 'ada@example.com', team: { id: 'team1', name: 'Truewidgets', role: 'member', seats: 3 } });
    await db.folders.bulkPut([folder('teamfolder01', 'Launch', { teamId: 'team1' }), CLIENT]);
    const { tabIds } = chrome.openWindow(['https://launch.com', 'https://client.com', 'https://here.com'], { focused: true });
    chrome.makeGroup([tabIds[0]!], { title: 'Launch' });
    chrome.makeGroup([tabIds[1]!], { title: 'Client sites' });
    const outcome = await handleFold({ tabIds: [tabIds[0]!, tabIds[1]!], source: 'rule' });
    expect(outcome.backIntoFolders).toEqual([{ folderId: CLIENT.id, name: 'Client sites', tabs: 1 }]);
    expect(await placement()).toEqual({ 'https://launch.com': null, 'https://client.com': CLIENT.id });
  });

  it('a live folder’s group is left to the live folder', async () => {
    await db.folders.bulkPut([CLIENT, RECIPES]);
    const { windowId, tabIds } = chrome.openWindow(['https://a.com'], { focused: true });
    const group = chrome.makeGroup(tabIds, { title: 'Recipes' });
    await liveFolders.set({ [CLIENT.id]: { folderId: CLIENT.id, groupId: group, windowId, openedAt: 1 } });
    const outcome = await handleFold({ windowId });
    expect(outcome.backIntoFolders).toBeUndefined();
    expect(await placement()).toEqual({ 'https://a.com': null });
  });
});

// ---------------------------------------------------------------------------------------------

describe('Fold into a folder', () => {
  it('a whole window, or every window, goes into the folder (over any fold back)', async () => {
    await db.folders.bulkPut([CLIENT, RECIPES]);
    await folded(['https://had.com'], RECIPES);
    const one = chrome.openWindow(['https://a.com', 'https://had.com'], { focused: true });
    chrome.makeGroup([one.tabIds[0]!], { title: 'Recipes' });
    const two = chrome.openWindow(['https://b.com']);
    const outcome = await send({ type: 'fold', windowId: one.windowId, intoFolderId: CLIENT.id });
    expect(outcome).toMatchObject({ intoFolder: { folderId: CLIENT.id, name: 'Client sites' }, savedTabs: 1 });
    expect(outcome.backIntoFolders).toBeUndefined();
    // "Fold into" moves a copy already folded too.
    expect(await placement()).toMatchObject({ 'https://a.com': CLIENT.id, 'https://had.com': CLIENT.id });

    chrome.openWindow(['https://c.com'], { focused: true });
    const all = await send({ type: 'fold', intoFolderId: RECIPES.id });
    expect(all.intoFolder?.name).toBe('Recipes');
    expect(await placement()).toMatchObject({ 'https://b.com': RECIPES.id, 'https://c.com': RECIPES.id });
    expect(chrome.windows.some((w) => w.id === two.windowId)).toBe(false);
    expect(Object.keys(await recentFolders.get()).sort()).toEqual([CLIENT.id, RECIPES.id].sort());
  });

  it('"New folder…" makes the folder first, folds into it, and Undo takes both back', async () => {
    await planState.set({ ...FREE_PLAN, tier: 'pro' });
    const { windowId } = chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    const outcome = await send({ type: 'fold', windowId, newFolderName: '  Trip   to Lisbon ' });
    expect(outcome.intoFolder?.name).toBe('Trip to Lisbon');
    const made = (await db.folders.get(outcome.intoFolder!.folderId))!;
    expect(made.deletedAt).toBe(0);
    expect(await placement()).toEqual({ 'https://a.com': made.id, 'https://b.com': made.id });
    expect(await handleUndo(outcome.actionId!)).toEqual({ undone: true });
    expect((await db.folders.get(made.id))!.deletedAt).toBeGreaterThan(0);
    expect(chrome.webTabs()).toHaveLength(2);
  });

  it('Free: a 4th folder is refused before anything closes', async () => {
    await db.folders.bulkPut([CLIENT, RECIPES, folder('third0000001', 'Third', { order: 2 })]);
    const { windowId } = chrome.openWindow(['https://a.com'], { focused: true });
    const response = await route({ type: 'fold', windowId, newFolderName: 'Fourth' });
    expect(response).toMatchObject({ ok: false, code: 'folder-limit' });
    expect(chrome.webTabs()).toHaveLength(1);
    expect(await db.folders.count()).toBe(3);
    expect(await db.tabs.count()).toBe(0);
  });

  it('a fold that doesn’t fit the free list takes the new folder away again', async () => {
    await db.sessions.put({
      id: 'full',
      name: 'Full',
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
      tabCount: 500,
      windowCount: 1,
      preview: [],
    });
    const { windowId } = chrome.openWindow(['https://a.com'], { focused: true });
    expect(await route({ type: 'fold', windowId, newFolderName: 'New one' })).toMatchObject({ ok: false, code: 'list-full' });
    expect(await db.folders.count()).toBe(0);
    expect(chrome.webTabs()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('right-click › Fold this tab into', () => {
  async function menuSpies() {
    const update = vi.spyOn(fakeBrowser.contextMenus, 'update').mockResolvedValue(undefined as never);
    return update;
  }

  it('lists starred folders first (★), then the ones used lately, then the rest, at most 8', async () => {
    await db.folders.bulkPut([
      folder('aaaaaaaaaaaa', 'Alpha', { order: 0 }),
      folder('bbbbbbbbbbbb', 'Beta', { order: 1, starredAt: 5 }),
      folder('cccccccccccc', 'Gamma', { order: 2 }),
      folder('tttttttttttt', 'Team one', { order: 5, teamId: 'team1' }),
      folder('dddddddddddd', 'Gone', { order: 3, deletedAt: 9 }),
      ...Array.from({ length: 6 }, (_, i) => folder(`zzzzzzzzzzz${i}`, `Other ${i}`, { order: 10 + i })),
    ]);
    await starredTeamFolders.set({ tttttttttttt: 7 });
    await recentFolders.set({ cccccccccccc: 100 });
    const items = await foldIntoMenuItems();
    expect(items.map((i) => i.title)).toEqual(['★ Beta', '★ Team one', 'Gamma', 'Alpha', 'Other 0', 'Other 1', 'Other 2', 'Other 3']);

    const update = await menuSpies();
    await refreshFoldIntoMenu();
    expect(update).toHaveBeenCalledWith(`${MENU.foldInto}:0`, { title: '★ Beta', visible: true });
    expect(update).toHaveBeenCalledWith(MENU.foldIntoSeparator, { visible: true });
    // Nothing changed: nothing is written again.
    update.mockClear();
    await refreshFoldIntoMenu();
    expect(update).not.toHaveBeenCalled();
    // A folder is starred: the menu follows.
    await db.folders.update('aaaaaaaaaaaa', { starredAt: 9 });
    await refreshFoldIntoMenu();
    expect(update).toHaveBeenCalledWith(`${MENU.foldInto}:0`, { title: '★ Alpha', visible: true });
  });

  it('with no folders, only "Choose a folder…" shows', async () => {
    const update = await menuSpies();
    await refreshFoldIntoMenu();
    expect(update).toHaveBeenCalledWith(`${MENU.foldInto}:0`, { visible: false });
    expect(update).toHaveBeenCalledWith(MENU.foldIntoSeparator, { visible: false });
  });

  it('a folder folds the tab into it; "Choose a folder…" opens the side panel (or the popup) with the picker', async () => {
    await db.folders.bulkPut([CLIENT, RECIPES]);
    await menuSpies();
    await refreshFoldIntoMenu();
    const { windowId, tabIds } = chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    const tab = async (id: number) => (await fakeBrowser.tabs.get(id)) as Browser.tabs.Tab;
    // Slot 1 is Recipes (order 1).
    await onMenuClicked({ menuItemId: `${MENU.foldInto}:1` } as never, await tab(tabIds[0]!));
    expect(chrome.tab(tabIds[0]!)).toBeUndefined();
    expect(await placement()).toEqual({ 'https://a.com': RECIPES.id });

    await onMenuClicked({ menuItemId: MENU.foldIntoChoose } as never, await tab(tabIds[1]!));
    expect(chrome.panelOpens).toEqual([windowId]);
    expect(await pendingFoldInto.get()).toMatchObject({ tabId: tabIds[1] });

    chrome.panelFails = true;
    const openPopup = vi.spyOn(fakeBrowser.action, 'openPopup').mockResolvedValue(undefined as never);
    await onMenuClicked({ menuItemId: MENU.foldIntoChoose } as never, await tab(tabIds[1]!));
    expect(openPopup).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------

describe('close the copies', () => {
  it('keeps the copy looked at last, closes the rest, and Undo reopens them where they were', async () => {
    const one = chrome.openWindow(
      [
        { url: 'https://a.com', lastAccessed: 5 },
        { url: 'https://b.com', lastAccessed: 1 },
        { url: 'https://a.com/', lastAccessed: 1 },
        { url: 'chrome://newtab/' },
        { url: 'chrome://newtab/' },
      ],
      { focused: true },
    );
    const two = chrome.openWindow([{ url: 'https://b.com', lastAccessed: 9 }, { url: 'https://a.com', lastAccessed: 2, pinned: true }]);
    const group = chrome.makeGroup([one.tabIds[2]!], { title: 'Group' });
    chrome.addTab(one.windowId, { url: 'https://keep.com', groupId: group });

    const result = await send({ type: 'copies-close' });
    expect(result.closed).toBe(2);
    expect(chrome.tab(one.tabIds[1]!)).toBeUndefined();
    expect(chrome.tab(one.tabIds[2]!)).toBeUndefined();
    // New Tab pages and the pinned copy stay.
    expect(chrome.tabs.filter((t) => t.windowId === one.windowId).map((t) => t.url)).toEqual(['https://a.com', 'chrome://newtab/', 'chrome://newtab/', 'https://keep.com']);
    expect(chrome.tab(two.tabIds[1]!)).toBeDefined();

    expect(await handleUndo(result.actionId!)).toEqual({ undone: true });
    const back = chrome.tabs.filter((t) => t.windowId === one.windowId).sort((a, b) => a.index - b.index);
    expect(back.map((t) => t.url)).toEqual(['https://a.com', 'https://b.com', 'https://a.com/', 'chrome://newtab/', 'chrome://newtab/', 'https://keep.com']);
    expect(back.every((t) => !t.active || t.url === 'https://a.com' || t.url.startsWith('chrome'))).toBe(true);
    expect(back[2]!.groupId).toBe(group);
  });

  it('in one window only', async () => {
    chrome.openWindow(['https://a.com', 'https://a.com'], { focused: true });
    const two = chrome.openWindow(['https://b.com', 'https://b.com']);
    expect(await send({ type: 'copies-close', windowId: two.windowId })).toMatchObject({ closed: 1 });
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://a.com', 'https://a.com', 'https://b.com']);
    expect(await send({ type: 'copies-close', windowId: two.windowId })).toEqual({ closed: 0, actionId: null });
  });
});

describe('tidy into groups', () => {
  it('groups a window’s loose tabs by kind of site (2 or more), with the kind’s name and colour; Undo ungroups them', async () => {
    await siteKinds.set({ 'news.example.com': { kind: 'reading', at: 1 } });
    const { windowId, tabIds } = chrome.openWindow(
      [
        'https://mail.google.com/x',
        'https://github.com/a',
        { url: 'https://docs.google.com/d', pinned: true },
        'https://app.slack.com/c',
        'https://gitlab.com/b',
        'https://youtube.com/v',
        'https://news.example.com/1',
        'https://medium.com/2',
        'chrome://newtab/',
        'https://kept.com',
      ],
      { focused: true },
    );
    const kept = chrome.makeGroup([tabIds[9]!], { title: 'Mine' });
    const result = await send({ type: 'window-tidy', windowId });
    expect(result).toMatchObject({ grouped: 6, groups: 3 });
    const titled = Object.fromEntries(chrome.groups.filter((g) => g.id !== kept).map((g) => [g.title, g.color]));
    expect(titled).toEqual({ 'Mail & chat': 'yellow', Dev: 'blue', Reading: 'green' });
    expect(chrome.tab(tabIds[2]!)!.groupId).toBe(-1);
    expect(chrome.tab(tabIds[5]!)!.groupId).toBe(-1);
    expect(chrome.tab(tabIds[9]!)!.groupId).toBe(kept);

    expect(await handleUndo(result.actionId!)).toEqual({ undone: true });
    expect(chrome.groups.map((g) => g.id)).toEqual([kept]);
  });

  it('every kind has its own colour', () => {
    expect(new Set(Object.values(KIND_GROUP_COLORS)).size).toBe(CATEGORIES.length);
  });

  it('works in an Incognito window (nothing is saved)', async () => {
    const { windowId } = chrome.openWindow(['https://github.com/a', 'https://gitlab.com/b'], { incognito: true });
    expect(await send({ type: 'window-tidy', windowId })).toMatchObject({ grouped: 2, groups: 1 });
    expect(await db.tabs.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('a window has more than N tabs', () => {
  const cap = (max: number, extra: Partial<AutoFoldRule> = {}): AutoFoldRule => ({
    id: `cap-${max}`,
    enabled: true,
    when: { type: 'window-cap', max },
    into: { type: 'site' },
    createdAt: 0,
    ...extra,
  });

  it('Free: folds the tabs looked at longest ago until the window is back to N, in one fold, named after the window', async () => {
    await updateSettings({ autoFold: [cap(3)] });
    const { windowId } = chrome.openWindow(
      [
        { url: 'https://pinned.com', pinned: true, lastAccessed: 1 },
        { url: 'https://oldest.com', lastAccessed: 2 },
        { url: 'https://music.com', audible: true, lastAccessed: 3 },
        { url: 'https://old.com', lastAccessed: 4 },
        { url: 'https://here.com', active: true, lastAccessed: 5 },
        { url: 'https://newer.com', lastAccessed: 6 },
      ],
      { focused: true },
    );
    await windowNames.set(windowId, 'Client work');
    const other = chrome.openWindow([{ url: 'https://x.com', lastAccessed: 1 }, { url: 'https://y.com', lastAccessed: 1 }]);
    // 5 tabs count (not the pinned one): 2 fold, the oldest the rule may fold.
    expect(await windowCapTick()).toBe(2);
    expect(chrome.webTabs().map((t) => t.url)).toEqual(['https://pinned.com', 'https://music.com', 'https://here.com', 'https://newer.com', 'https://x.com', 'https://y.com']);
    const sessions = await db.sessions.toArray();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.name).toBe('Client work');
    expect(await autoFoldNotice.get()).toMatchObject({ label: 'your 3-tab rule', folded: 2, windowName: 'Client work' });
    expect(chrome.tabs.some((t) => t.windowId === other.windowId)).toBe(true);
    // Back under the cap: nothing more.
    expect(await windowCapTick()).toBe(0);
  });

  it('several windows over the cap fold together; nothing runs without an enabled cap rule', async () => {
    await planState.set({ ...FREE_PLAN, tier: 'pro' });
    chrome.openWindow(['https://a1.com', 'https://a2.com', 'https://a3.com'], { focused: false });
    chrome.openWindow(['https://b1.com', 'https://b2.com', 'https://b3.com']);
    await updateSettings({ autoFold: [cap(2, { enabled: false })] });
    expect(await windowCapTick()).toBe(0);
    await updateSettings({ autoFold: [cap(2)] });
    expect(await windowCapTick()).toBe(2);
    expect(await db.sessions.count()).toBe(1);
    expect(await autoFoldNotice.get()).not.toHaveProperty('windowName');
  });

  it('runs from "Run now" on Free too', async () => {
    await updateSettings({ autoFold: [cap(2)] });
    chrome.openWindow(['https://a.com', 'https://b.com', 'https://c.com'], { focused: true });
    expect(await send({ type: 'autofold-run', ruleId: 'cap-2' })).toEqual({ folded: 1 });
  });
});

// ---------------------------------------------------------------------------------------------

describe('named windows', () => {
  it('a name is kept for the session and remembered with the window’s pages; "" takes it away', async () => {
    const { windowId } = chrome.openWindow(['https://a.com', 'https://b.com/', 'chrome://newtab/'], { focused: true });
    await send({ type: 'window-rename', windowId, name: '  Client   work ' });
    expect(await windowNames.get()).toEqual({ [windowId]: 'Client work' });
    expect(await namedWindows.get()).toEqual([{ name: 'Client work', urls: [urlKey('https://a.com'), urlKey('https://b.com')], windowId, at: expect.any(Number) }]);
    await send({ type: 'window-rename', windowId, name: '' });
    expect(await windowNames.get()).toEqual({});
    expect(await namedWindows.get()).toEqual([]);
  });

  it('an Incognito window’s name lasts only the session', async () => {
    const { windowId } = chrome.openWindow(['https://a.com'], { incognito: true });
    await send({ type: 'window-rename', windowId, name: 'Private' });
    expect(await windowNames.get()).toEqual({ [windowId]: 'Private' });
    expect(await namedWindows.get()).toEqual([]);
  });

  it('after a restart, each name goes back to the window whose pages match it best', async () => {
    const now = Date.now();
    await namedWindows.set([
      { name: 'Client work', urls: ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'].map(urlKey), windowId: 1, at: now - DAY },
      { name: 'Trip', urls: ['https://lisbon.com'].map(urlKey), windowId: 2, at: now - DAY },
      { name: 'Too old', urls: ['https://old.com', 'https://old2.com'].map(urlKey), windowId: 3, at: now - 31 * DAY },
      { name: 'Weak', urls: ['https://w1.com', 'https://w2.com', 'https://w3.com', 'https://w4.com', 'https://w5.com'].map(urlKey), windowId: 4, at: now },
    ]);
    const client = chrome.openWindow(['https://a.com', 'https://b.com', 'https://x.com']);
    const trip = chrome.openWindow(['https://lisbon.com', 'https://porto.com']);
    const old = chrome.openWindow(['https://old.com', 'https://old2.com']);
    const weak = chrome.openWindow(['https://w1.com', 'https://z.com', 'https://zz.com', 'https://zzz.com', 'https://zzzz.com']);
    expect(await restoreWindowNames(now)).toBe(2);
    expect(await windowNames.get()).toEqual({ [client.windowId]: 'Client work', [trip.windowId]: 'Trip' });
    expect(old.windowId).toBeDefined();
    expect(weak.windowId).toBeDefined();
    const stored = await namedWindows.get();
    expect(stored.map((e) => e.name)).toEqual(['Client work', 'Trip', 'Weak']);
    expect(stored.find((e) => e.name === 'Client work')!.windowId).toBe(client.windowId);
    // Run again: nothing changes (one window per name).
    expect(await restoreWindowNames(now)).toBe(0);
  });

  it('matches at least half of the smaller set, and 2 pages (1 when either has a single page)', () => {
    expect(matchScore(['a', 'b', 'c', 'd'], ['a', 'b', 'x'])).toBe(2);
    expect(matchScore(['a', 'b', 'c', 'd'], ['a', 'x', 'y'])).toBe(0);
    expect(matchScore(['a'], ['a', 'x', 'y'])).toBe(1);
    expect(matchScore(['a', 'b', 'c', 'd', 'e'], ['a', 'v', 'w', 'x', 'y'])).toBe(0);
    expect(matchScore([], ['a'])).toBe(0);
    expect(windowUrlKeys([{ url: 'https://a.com', index: 1 }, { url: 'chrome://newtab/', index: 0 }, { url: 'https://a.com/', index: 2 }])).toEqual([urlKey('https://a.com')]);
  });

  it('folding a named window names the fold; reopening the fold names its new window', async () => {
    const { windowId } = chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    chrome.openWindow(['https://other.com']);
    await send({ type: 'window-rename', windowId, name: 'Client work' });
    const outcome = await send({ type: 'fold', windowId });
    expect(outcome.sessionName).toBe('Client work');
    expect((await db.windows.where('sessionId').equals(outcome.sessionId!).first())!.name).toBe('Client work');

    await send({ type: 'restore', sessionId: outcome.sessionId!, mode: 'original', force: true });
    const reopened = chrome.windows.find((w) => chrome.tabs.some((t) => t.windowId === w.id && t.url === 'https://a.com'))!;
    expect((await windowNames.get())[reopened.id]).toBe('Client work');
    expect((await namedWindows.get()).map((e) => [e.name, e.windowId])).toEqual([['Client work', reopened.id]]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('stars and notes', () => {
  it('a personal folder’s star is part of the folder (it syncs); a team folder’s is this person’s own', async () => {
    const team = folder('teamfolder01', 'Launch', { teamId: 'team1', updatedAt: 1 });
    await db.folders.bulkPut([CLIENT, team]);
    const starred = await send({ type: 'folder-update', id: CLIENT.id, starred: true });
    expect(starred.folder.starredAt).toBeGreaterThan(0);
    expect(starred.folder.updatedAt).toBe(starred.folder.starredAt);
    expect((await send({ type: 'folder-update', id: CLIENT.id, starred: false })).folder.starredAt).toBe(0);

    await send({ type: 'folder-update', id: team.id, starred: true });
    expect(Object.keys(await starredTeamFolders.get())).toEqual([team.id]);
    expect(await db.folders.get(team.id)).toEqual(team);
    await send({ type: 'folder-update', id: team.id, starred: false });
    expect(await starredTeamFolders.get()).toEqual({});
  });

  it('a note is one line of at most 140 characters; emptying it removes it but keeps when', async () => {
    await db.folders.put(CLIENT);
    const noted = await send({ type: 'folder-update', id: CLIENT.id, note: '  Waiting on\nthe   client’s feedback ' });
    expect(noted.folder).toMatchObject({ note: 'Waiting on the client’s feedback', updatedAt: 1 });
    expect(noted.folder.noteAt).toBeGreaterThan(0);
    const removed = await send({ type: 'folder-update', id: CLIENT.id, note: '' });
    expect(removed.folder.note).toBe('');
    expect(removed.folder.noteAt).toBeGreaterThanOrEqual(noted.folder.noteAt!);

    const long = `${'x'.repeat(139)}👍🏽 and more`;
    expect(Array.from(cleanFolderNote(long))).toHaveLength(139);
    expect(cleanFolderNote(`${'y'.repeat(138)}é!`)).toBe(`${'y'.repeat(138)}é!`);
    expect(Array.from(cleanFolderNote('z'.repeat(300)))).toHaveLength(140);
  });

  it('a team folder’s note is the team’s (on the folder)', async () => {
    const team = folder('teamfolder01', 'Launch', { teamId: 'team1' });
    await db.folders.put(team);
    await send({ type: 'folder-update', id: team.id, note: 'For the launch' });
    expect(await db.folders.get(team.id)).toMatchObject({ note: 'For the launch', updatedAt: 1 });
  });
});

// ---------------------------------------------------------------------------------------------

describe('weekly numbers', () => {
  it('folds add up (never Incognito), tabs that come back count, and Undo takes a fold off again', async () => {
    await updateSettings({ foldIncognito: true });
    chrome.openWindow(['https://a.com', 'https://b.com', { url: 'https://asleep.com', discarded: true }], { focused: true });
    chrome.openWindow(['https://private.com'], { incognito: true });
    const outcome = await handleFold();
    expect(outcome.savedTabs).toBe(4);
    const week = weekKey(Date.now());
    expect((await weeklyStats.get())[week]).toEqual({ folded: 3, freedBytes: 2 * 48 * 1024 * 1024, cameBack: 0 });

    const saved = (await db.tabs.where('url').equals('https://a.com').first())!;
    chrome.openWindow(['chrome://newtab/'], { focused: true });
    await send({ type: 'open-saved-tab', tabRecordId: saved.id, active: true });
    expect((await weeklyStats.get())[week]!.cameBack).toBe(1);

    chrome.openWindow(['https://c.com'], { focused: true });
    const second = await handleFold();
    expect((await weeklyStats.get())[week]!.folded).toBe(5);
    await handleUndo(second.actionId!);
    expect((await weeklyStats.get())[week]!.folded).toBe(3);
    // The second fold had a.com (open again, already folded) and c.com.
    expect((await lastAction.get())!.weekly).toMatchObject({ folded: 2 });
  });

  it('the summary is put away for this week', async () => {
    await send({ type: 'weekly-summary-dismiss' });
    expect(await weeklySummarySeen.get()).toBe(weekKey(Date.now()));
  });
});

// ---------------------------------------------------------------------------------------------

describe('the toolbar button and the side panel', () => {
  it('opens the side panel or the popup, as the setting says', async () => {
    expect(await applyToolbarSetting('side-panel')).toBe('side-panel');
    expect(chrome.popups.at(-1)).toBe('');
    expect(chrome.panelBehaviors.at(-1)).toBe(true);
    expect(await applyToolbarSetting('popup')).toBe('popup');
    expect(chrome.popups.at(-1)).toBe('popup.html');
    expect(chrome.panelBehaviors.at(-1)).toBe(false);
    await updateSettings({ toolbarOpens: 'side-panel' });
    expect(await applyToolbarSetting()).toBe('side-panel');
  });

  it('without Chrome’s side panel, the popup stays', async () => {
    const panel = (fakeBrowser as unknown as { sidePanel?: unknown }).sidePanel;
    (fakeBrowser as unknown as { sidePanel?: unknown }).sidePanel = undefined;
    try {
      expect(await applyToolbarSetting('side-panel')).toBe('popup');
      expect(chrome.popups.at(-1)).toBe('popup.html');
    } finally {
      (fakeBrowser as unknown as { sidePanel?: unknown }).sidePanel = panel;
    }
  });

  it('with the side panel, the Fold shortcut asks in the side panel when several windows are open', async () => {
    await updateSettings({ toolbarOpens: 'side-panel' });
    const { windowId, tabIds } = chrome.openWindow(['https://a.com'], { focused: true });
    chrome.openWindow(['https://b.com']);
    await applyToolbarSetting();
    await refreshWindowHint();
    await onCommand('fold', (await fakeBrowser.tabs.get(tabIds[0]!)) as Browser.tabs.Tab);
    expect(chrome.panelOpens).toEqual([windowId]);
    expect(await pendingFoldAsk.get()).toBeDefined();
    expect(chrome.webTabs()).toHaveLength(2);

    // A fresh worker (it doesn't know yet): it still asks, falling back to the popup if Chrome says no.
    resetToolbarRuntime();
    chrome.panelFails = true;
    const openPopup = vi.spyOn(fakeBrowser.action, 'openPopup').mockResolvedValue(undefined as never);
    await onCommand('fold', (await fakeBrowser.tabs.get(tabIds[0]!)) as Browser.tabs.Tab);
    expect(openPopup).toHaveBeenCalled();
  });
});

