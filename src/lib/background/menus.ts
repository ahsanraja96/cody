import { browser, type Browser } from 'wxt/browser';
import { extUrl } from '../extUrl';
import { getSettings } from '../settings';
import { pendingFoldAsk, pendingKeywordSave } from '../state';
import { getNormalWindows, incognitoAllowed } from './browserState';
import { handleFold } from './fold';
import { handleSave } from './save';

/** The page's right-click menu: fold this tab, with or without keywords. */
export const MENU = {
  foldTab: 'tabfold-fold-tab',
  foldTabKeywords: 'tabfold-fold-tab-keywords',
} as const;

/**
 * Keyboard shortcuts (wxt.config.ts). "Fold this tab" keeps the id earlier versions used, so a
 * shortcut a person changed in chrome://extensions/shortcuts keeps working.
 */
export const SHORTCUT = {
  foldAll: 'fold',
  foldTab: 'save-tab',
} as const;

export async function createMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({ id: MENU.foldTab, title: 'Fold this tab', contexts: ['page', 'frame'] });
  browser.contextMenus.create({ id: MENU.foldTabKeywords, title: 'Fold this tab with keywords…', contexts: ['page', 'frame'] });
}

/** Show the keyword picker for these tabs: the toolbar popup when Chrome allows it, else a small window. */
export async function askForKeywords(tabIds: number[]): Promise<void> {
  await pendingKeywordSave.set({ tabIds, at: Date.now() });
  try {
    await browser.action.openPopup();
  } catch {
    await browser.windows.create({
      url: extUrl('/popup.html?mode=window'),
      type: 'popup',
      width: 420,
      height: 640,
      focused: true,
    });
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
    await handleFold();
    return;
  }
  await pendingFoldAsk.set({ at: Date.now() });
  try {
    await browser.action.openPopup();
  } catch {
    await browser.windows.create({ url: extUrl('/popup.html?mode=window'), type: 'popup', width: 420, height: 640, focused: true });
  }
}

/** Fold one tab: save it and close it. A tab already in the list closes without being saved twice. */
async function foldSingleTab(tab: Browser.tabs.Tab | undefined, withKeywords: boolean): Promise<void> {
  if (tab?.id === undefined || tab.incognito) return;
  if (withKeywords) {
    await askForKeywords([tab.id]);
    return;
  }
  await handleSave({ type: 'save', scope: 'tabs', tabIds: [tab.id], close: true, windowId: tab.windowId, duplicates: 'skip' });
}

export async function onMenuClicked(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab): Promise<void> {
  switch (info.menuItemId) {
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
  }
}
