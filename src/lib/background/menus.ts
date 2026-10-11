import { browser, type Browser } from 'wxt/browser';
import { extUrl } from '../extUrl';
import type { WorkerEvent } from '../messages';
import { getSettings } from '../settings';
import { SHORTCUT_CHOICE, snoozeChoices, snoozeTime, type SnoozeChoiceId } from '../snooze';
import { pendingFoldAsk, pendingKeywordSave } from '../state';
import { flashSnoozed, snooze } from './automation';
import { broadcast, getNormalWindows, incognitoAllowed } from './browserState';
import { handleFold } from './fold';
import { limitCode } from './room';
import { handleSave } from './save';

/** The page's right-click menu: fold this tab, with or without keywords, and snooze it. */
export const MENU = {
  foldTab: 'tabfold-fold-tab',
  foldTabKeywords: 'tabfold-fold-tab-keywords',
  snoozeTab: 'tabfold-snooze-tab',
} as const;

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

export async function createMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({ id: MENU.foldTab, title: 'Fold this tab', contexts: ['page', 'frame'] });
  browser.contextMenus.create({ id: MENU.foldTabKeywords, title: 'Fold this tab with keywords…', contexts: ['page', 'frame'] });
  browser.contextMenus.create({ id: MENU.snoozeTab, title: 'Snooze this tab', contexts: ['page', 'frame'] });
  for (const id of SNOOZE_IDS) {
    browser.contextMenus.create({ id: `${SNOOZE_ITEM}${id}`, parentId: MENU.snoozeTab, title: SNOOZE_LABELS[id], contexts: ['page', 'frame'] });
  }
  lastSnoozeTitles = '';
  await refreshSnoozeMenu();
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

/** Open Tabfold's popup, or a small window when Chrome won't (no window focused, an older Chrome). */
async function openPopupOrWindow(): Promise<void> {
  try {
    await browser.action.openPopup();
  } catch {
    await browser.windows.create({ url: extUrl('/popup.html?mode=window'), type: 'popup', width: 420, height: 640, focused: true });
  }
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
 * already asking "Just this window" or "All windows" (a small window when Chrome won't open the
 * popup).
 */
export async function foldShortcut(): Promise<void> {
  const [windows, settings] = await Promise.all([getNormalWindows(), getSettings()]);
  const incognito = settings.foldIncognito && (await incognitoAllowed());
  const foldable = windows.filter((w) => w.type === 'normal' && (incognito || !w.incognito));
  if (foldable.length <= 1) {
    await limitHitHere(() => handleFold());
    return;
  }
  await pendingFoldAsk.set({ at: Date.now() });
  await openPopupOrWindow();
}

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

/** Snooze one open tab until `until`: it folds now and comes back then. The toolbar icon says "Zz" for a moment. */
async function snoozeSingleTab(tab: Browser.tabs.Tab | undefined, until: number): Promise<void> {
  if (tab?.id === undefined || tab.incognito) return;
  const tabId = tab.id;
  const done = await limitHitHere(() => snooze({ until, tabIds: [tabId] }));
  if (done?.snoozed) await flashSnoozed();
}

export async function onMenuClicked(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab): Promise<void> {
  const id = String(info.menuItemId);
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
    case SHORTCUT.foldAll:
      return foldShortcut();
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
