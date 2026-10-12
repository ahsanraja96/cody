import Dexie from 'dexie';
import { browser, type Browser } from 'wxt/browser';
import { DB_NAME } from '../db';
import { extUrl } from '../extUrl';
import { folderStarred, foldIntoOrder } from '../folderOrder';
import { listLiveFolders } from '../folders';
import type { WorkerEvent } from '../messages';
import { getSettings } from '../settings';
import { SHORTCUT_CHOICE, snoozeChoices, snoozeTime, type SnoozeChoiceId } from '../snooze';
import { pendingFoldAsk, pendingFoldInto, pendingKeywordSave, recentFolders, starredTeamFolders } from '../state';
import { flashSnoozed, snooze } from './automation';
import { broadcast, getNormalWindows, incognitoAllowed } from './browserState';
import { handleFold } from './fold';
import { limitCode } from './room';
import { handleSave } from './save';
import { foldAsksInSidePanel, sidePanelApi } from './toolbar';

/** The page's right-click menu: fold this tab (into a folder), with or without keywords, and snooze it. */
export const MENU = {
  foldTab: 'tabfold-fold-tab',
  /** "Fold this tab into ›" (1.0): up to 8 folders, a separator, "Choose a folder…". */
  foldInto: 'tabfold-fold-into',
  foldIntoSeparator: 'tabfold-fold-into-separator',
  foldIntoChoose: 'tabfold-fold-into-choose',
  foldTabKeywords: 'tabfold-fold-tab-keywords',
  snoozeTab: 'tabfold-snooze-tab',
} as const;

/** "Fold this tab into ›" lists this many folders at most. */
export const FOLD_INTO_SLOTS = 8;
/** The folder items: `tabfold-fold-into:<slot>`, slots 0 to 7 (the folder each shows is kept in `FOLD_INTO_MENU`). */
const FOLD_INTO_ITEM = `${MENU.foldInto}:`;
/** In session storage: the folder id each slot shows, so a click finds it after the worker restarts. */
const FOLD_INTO_MENU = 'foldIntoMenu';
/** In session storage: what the items show, so a fresh worker doesn't write them all again. */
const FOLD_INTO_MENU_SHOWN = 'foldIntoMenuShown';

/** "Snooze this tab" › one item per choice: `tabfold-snooze-tab:<choice id>`. */
const SNOOZE_ITEM = `${MENU.snoozeTab}:`;
const SNOOZE_IDS: SnoozeChoiceId[] = ['later-today', 'tomorrow', 'weekend', 'next-week', 'month'];
const SNOOZE_LABELS: Record<SnoozeChoiceId, string> = {
  'later-today': 'Later today',
  tomorrow: 'Tomorrow morning',
  weekend: 'This weekend',
  'next-week': 'Next week',
  month: 'In a month',
};

/**
 * Keyboard shortcuts (wxt.config.ts). "Fold this tab" keeps the id earlier versions used, so a
 * shortcut a person changed in chrome://extensions/shortcuts keeps working.
 */
export const SHORTCUT = {
  foldAll: 'fold',
  foldTab: 'save-tab',
  snoozeTab: 'snooze-tab',
} as const;

const CONTEXTS: ['page', 'frame'] = ['page', 'frame'];

export async function createMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({ id: MENU.foldTab, title: 'Fold this tab', contexts: CONTEXTS });
  browser.contextMenus.create({ id: MENU.foldInto, title: 'Fold this tab into', contexts: CONTEXTS });
  for (let slot = 0; slot < FOLD_INTO_SLOTS; slot += 1) {
    browser.contextMenus.create({ id: `${FOLD_INTO_ITEM}${slot}`, parentId: MENU.foldInto, title: 'Folder', visible: false, contexts: CONTEXTS });
  }
  browser.contextMenus.create({ id: MENU.foldIntoSeparator, parentId: MENU.foldInto, type: 'separator', visible: false, contexts: CONTEXTS });
  browser.contextMenus.create({ id: MENU.foldIntoChoose, parentId: MENU.foldInto, title: 'Choose a folder…', contexts: CONTEXTS });
  browser.contextMenus.create({ id: MENU.foldTabKeywords, title: 'Fold this tab with keywords…', contexts: CONTEXTS });
  browser.contextMenus.create({ id: MENU.snoozeTab, title: 'Snooze this tab', contexts: CONTEXTS });
  for (const id of SNOOZE_IDS) {
    browser.contextMenus.create({ id: `${SNOOZE_ITEM}${id}`, parentId: MENU.snoozeTab, title: SNOOZE_LABELS[id], contexts: CONTEXTS });
  }
  lastSnoozeTitles = '';
  // The items were just made (hidden): they're filled in afresh.
  lastFoldIntoItems = '';
  await browser.storage.session.remove(FOLD_INTO_MENU_SHOWN).catch(() => undefined);
  await refreshSnoozeMenu();
  await refreshFoldIntoMenu();
}

/** The snooze items' titles as last set, so the 5-minute refresh only writes when the times change. */
let lastSnoozeTitles = '';

/**
 * Put the times next to the snooze choices ("Tomorrow morning · Tue 9:00") and hide the ones not
 * offered now ("Later today" after 17:00, "This weekend" on a Sunday). Run when the menus are made
 * and on the 5-minute alarm.
 */
export async function refreshSnoozeMenu(now = Date.now()): Promise<void> {
  const offered = new Map(snoozeChoices(now).map((c) => [c.id, c]));
  const items = SNOOZE_IDS.map((id) => {
    const choice = offered.get(id);
    return { id, visible: !!choice, title: choice ? `${choice.label} · ${choice.hint}` : SNOOZE_LABELS[id] };
  });
  const key = JSON.stringify(items);
  if (key === lastSnoozeTitles) return;
  lastSnoozeTitles = key;
  for (const item of items) {
    try {
      await browser.contextMenus.update(`${SNOOZE_ITEM}${item.id}`, { title: item.title, visible: item.visible });
    } catch {
      // The menu isn't there (yet): createMenus sets it up.
      lastSnoozeTitles = '';
    }
  }
}

// ---------------------------------------------------------------------------------------------
// "Fold this tab into ›" (1.0)

/** The fold-into items as last set, so a rebuild only writes when something changed. */
let lastFoldIntoItems = '';

/** The folders "Fold this tab into ›" lists, in `foldIntoOrder`, at most 8 (starred ones as "★ Name"). */
export async function foldIntoMenuItems(): Promise<Array<{ folderId: string; title: string }>> {
  const [folders, teamStars, recent] = await Promise.all([listLiveFolders(), starredTeamFolders.get(), recentFolders.get()]);
  return foldIntoOrder(folders, teamStars, recent)
    .slice(0, FOLD_INTO_SLOTS)
    .map((folder) => ({ folderId: folder.id, title: folderStarred(folder, teamStars) ? `★ ${folder.name}` : folder.name }));
}

/** A title as the menu shows it: Chrome reads "&" as a shortcut mark, "&&" as an "&". */
function menuTitle(title: string): string {
  return title.replace(/&/g, '&&');
}

/**
 * Put the folders in "Fold this tab into ›": up to 8 in their slots (the rest hidden), and the
 * separator only when there's at least one. Run when the menus are made and, debounced, when
 * folders, stars or the folders used lately change. Writes only what changed.
 */
export async function refreshFoldIntoMenu(): Promise<void> {
  const items = await foldIntoMenuItems();
  const key = JSON.stringify(items);
  // A fresh worker: what the menu shows was kept in session storage (Chrome keeps the menu itself).
  if (!lastFoldIntoItems) lastFoldIntoItems = ((await browser.storage.session.get(FOLD_INTO_MENU_SHOWN))[FOLD_INTO_MENU_SHOWN] as string | undefined) ?? '';
  if (key === lastFoldIntoItems) return;
  lastFoldIntoItems = key;
  await browser.storage.session.set({ [FOLD_INTO_MENU]: items.map((i) => i.folderId), [FOLD_INTO_MENU_SHOWN]: key });
  try {
    for (let slot = 0; slot < FOLD_INTO_SLOTS; slot += 1) {
      const item = items[slot];
      await browser.contextMenus.update(`${FOLD_INTO_ITEM}${slot}`, item ? { title: menuTitle(item.title), visible: true } : { visible: false });
    }
    await browser.contextMenus.update(MENU.foldIntoSeparator, { visible: items.length > 0 });
  } catch {
    // The menu isn't there (yet): createMenus sets it up.
    lastFoldIntoItems = '';
    await browser.storage.session.remove(FOLD_INTO_MENU_SHOWN).catch(() => undefined);
  }
}

let foldIntoTimer: ReturnType<typeof setTimeout> | undefined;
/** Folders changed: "Fold this tab into ›" is rebuilt this long after the last change. */
export const FOLD_INTO_MENU_DELAY_MS = 1_000;

export function scheduleFoldIntoMenu(delayMs = FOLD_INTO_MENU_DELAY_MS): void {
  clearTimeout(foldIntoTimer);
  foldIntoTimer = setTimeout(() => {
    foldIntoTimer = undefined;
    refreshFoldIntoMenu().catch((error) => console.warn('[tabfold] fold-into menu not updated', (error as Error)?.name ?? error));
  }, delayMs);
}

/**
 * Called once at the worker's top level: "Fold this tab into ›" follows the folders (made,
 * renamed, starred, deleted, here or synced), team stars and the folders used lately, debounced.
 */
export function setupMenus(): void {
  Dexie.on('storagemutated', (parts) => {
    if (Object.keys(parts as Record<string, unknown>).some((key) => key.startsWith(`idb://${DB_NAME}/folders/`))) scheduleFoldIntoMenu();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('starredTeamFolders' in changes || 'recentFolders' in changes)) scheduleFoldIntoMenu();
  });
  // Chrome keeps the menu between worker starts; a fresh browser session fills it in again.
  scheduleFoldIntoMenu();
}

/** For tests: forget what the menus showed. */
export function resetMenusRuntime(): void {
  lastFoldIntoItems = '';
  lastSnoozeTitles = '';
  clearTimeout(foldIntoTimer);
  foldIntoTimer = undefined;
}

// ---------------------------------------------------------------------------------------------
// Opening Tabfold

/** Open Tabfold's popup, or a small window when Chrome won't (no window focused, an older Chrome). */
async function openPopupOrWindow(): Promise<void> {
  try {
    await browser.action.openPopup();
  } catch {
    await browser.windows.create({ url: extUrl('/popup.html?mode=window'), type: 'popup', width: 420, height: 640, focused: true });
  }
}

/**
 * Tabfold's side panel in this window (1.0). Called straight from a click or a shortcut: Chrome
 * opens the side panel only in answer to one, so nothing may be awaited before this. Resolves to
 * whether it opened; never throws.
 */
export function openSidePanel(windowId: number | undefined): Promise<boolean> {
  const panel = sidePanelApi();
  if (windowId === undefined || windowId < 0 || typeof panel?.open !== 'function') return Promise.resolve(false);
  try {
    return Promise.resolve(panel.open({ windowId })).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** The side panel in this window, else the popup (or a small window). The same rule: call it first thing. */
export function openSidePanelOrPopup(windowId: number | undefined): Promise<void> {
  return openSidePanel(windowId).then((opened) => (opened ? undefined : openPopupOrWindow()));
}

/** Show the keyword picker for these tabs: the toolbar popup when Chrome allows it, else a small window. */
export async function askForKeywords(tabIds: number[]): Promise<void> {
  await pendingKeywordSave.set({ tabIds, at: Date.now() });
  await openPopupOrWindow();
}

/**
 * A shortcut or menu hit a Free limit (the list is full, 3 tabs are snoozed): nothing changed, and
 * no page asked. Open pages show the banner (`limit-hit`) and the popup opens on the card.
 */
async function limitHitHere<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    const code = limitCode(error);
    if (!code) throw error;
    const event: WorkerEvent = { type: 'limit-hit', code };
    broadcast(event);
    await openPopupOrWindow();
    return undefined;
  }
}

/**
 * The fold shortcut: with one window open it folds straight away; with several, Tabfold opens
 * already asking "Just this window" or "All windows": in the side panel when the toolbar button
 * opens it (1.0), else the popup (a small window when Chrome won't open the popup). `tab` is the
 * tab the shortcut came from; `panel` is the side panel the shortcut's handler already asked for.
 */
export async function foldShortcut(tab?: Browser.tabs.Tab, panel?: Promise<boolean>): Promise<void> {
  const [windows, settings] = await Promise.all([getNormalWindows(), getSettings()]);
  const incognito = settings.foldIncognito && (await incognitoAllowed());
  const foldable = windows.filter((w) => w.type === 'normal' && (incognito || !w.incognito));
  if (foldable.length <= 1) {
    await limitHitHere(() => handleFold());
    return;
  }
  await pendingFoldAsk.set({ at: Date.now() });
  if (settings.toolbarOpens === 'side-panel') {
    const opened = await (panel ?? openSidePanel(tab?.windowId ?? windows.find((w) => w.focused)?.id));
    if (opened) return;
  }
  await openPopupOrWindow();
}

// ---------------------------------------------------------------------------------------------
// One tab

/** Fold one tab: save it and close it. A tab already in the list closes without being saved twice. */
async function foldSingleTab(tab: Browser.tabs.Tab | undefined, withKeywords: boolean): Promise<void> {
  if (tab?.id === undefined || tab.incognito) return;
  if (withKeywords) {
    await askForKeywords([tab.id]);
    return;
  }
  const tabId = tab.id;
  await limitHitHere(() => handleSave({ type: 'save', scope: 'tabs', tabIds: [tabId], close: true, windowId: tab.windowId, duplicates: 'skip' }));
}

/** "Fold this tab into › <folder>": the tab folds into that folder (into a team folder, it's shared with the team). */
async function foldTabInto(tab: Browser.tabs.Tab | undefined, slot: number): Promise<void> {
  if (tab?.id === undefined || tab.incognito) return;
  const stored = (await browser.storage.session.get(FOLD_INTO_MENU))[FOLD_INTO_MENU] as string[] | undefined;
  const folderId = (stored ?? (await foldIntoMenuItems()).map((i) => i.folderId))[slot];
  if (!folderId) return;
  const tabId = tab.id;
  await limitHitHere(() => handleFold({ tabIds: [tabId], intoFolderId: folderId }));
}

/**
 * "Fold this tab into › Choose a folder…": the side panel opens in this window (inside the click,
 * as Chrome asks), else the popup, and shows the folder picker for this tab (`pendingFoldInto`).
 */
function chooseFolderFor(tab: Browser.tabs.Tab | undefined): Promise<void> {
  if (tab?.id === undefined || tab.incognito) return Promise.resolve();
  const opening = openSidePanelOrPopup(tab.windowId);
  const pending = pendingFoldInto.set({ tabId: tab.id, at: Date.now() });
  return Promise.all([opening, pending]).then(() => undefined);
}

/** Snooze one open tab until `until`: it folds now and comes back then. The toolbar icon says "Zz" for a moment. */
async function snoozeSingleTab(tab: Browser.tabs.Tab | undefined, until: number): Promise<void> {
  if (tab?.id === undefined || tab.incognito) return;
  const tabId = tab.id;
  const done = await limitHitHere(() => snooze({ until, tabIds: [tabId] }));
  if (done?.snoozed) await flashSnoozed();
}

export async function onMenuClicked(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab): Promise<void> {
  const id = String(info.menuItemId);
  // Before anything is awaited: Chrome opens the side panel only inside the click.
  if (id === MENU.foldIntoChoose) return chooseFolderFor(tab);
  if (id.startsWith(FOLD_INTO_ITEM)) {
    const slot = Number(id.slice(FOLD_INTO_ITEM.length));
    if (Number.isInteger(slot) && slot >= 0 && slot < FOLD_INTO_SLOTS) await foldTabInto(tab, slot);
    return;
  }
  if (id.startsWith(SNOOZE_ITEM)) {
    const choice = id.slice(SNOOZE_ITEM.length) as SnoozeChoiceId;
    if (SNOOZE_IDS.includes(choice)) await snoozeSingleTab(tab, snoozeTime(choice));
    return;
  }
  switch (id) {
    case MENU.foldTab:
      return foldSingleTab(tab, false);
    case MENU.foldTabKeywords:
      return foldSingleTab(tab, true);
  }
}

export async function onCommand(command: string, tab?: Browser.tabs.Tab): Promise<void> {
  switch (command) {
    case SHORTCUT.foldAll: {
      // Before anything is awaited: the side panel opens only inside the shortcut itself.
      const panel = foldAsksInSidePanel() ? openSidePanel(tab?.windowId) : undefined;
      return foldShortcut(tab, panel);
    }
    case SHORTCUT.foldTab: {
      const activeTab = tab ?? (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? undefined;
      return foldSingleTab(activeTab, false);
    }
    case SHORTCUT.snoozeTab: {
      const activeTab = tab ?? (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? undefined;
      return snoozeSingleTab(activeTab, snoozeTime(SHORTCUT_CHOICE));
    }
  }
}
