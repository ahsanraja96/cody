import { browser, type Browser } from 'wxt/browser';
import { extUrl } from '../extUrl';
import { openLibrary } from '../openLibrary';
import { getSettings } from '../settings';
import { pendingKeywordSave } from '../state';
import { currentNormalWindowId } from './browserState';
import { handleSave } from './save';

export const MENU = {
  saveTab: 'tabfold-save-tab',
  saveTabKeywords: 'tabfold-save-tab-keywords',
  saveWindow: 'tabfold-save-window',
  openLibrary: 'tabfold-open-library',
} as const;

export async function createMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({ id: MENU.saveTab, title: 'Save this tab', contexts: ['page', 'frame'] });
  browser.contextMenus.create({
    id: MENU.saveTabKeywords,
    title: 'Save this tab with keywords…',
    contexts: ['page', 'frame'],
  });
  browser.contextMenus.create({ id: MENU.saveWindow, title: 'Save this window', contexts: ['page', 'frame'] });
  browser.contextMenus.create({ id: MENU.openLibrary, title: 'Open Tabfold library', contexts: ['action'] });
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

async function saveSingleTab(tab: Browser.tabs.Tab | undefined, withKeywords: boolean): Promise<void> {
  if (tab?.id === undefined || tab.incognito) return;
  if (withKeywords) {
    await askForKeywords([tab.id]);
    return;
  }
  await handleSave({ type: 'save', scope: 'tabs', tabIds: [tab.id], close: true, windowId: tab.windowId });
}

export async function onMenuClicked(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab): Promise<void> {
  switch (info.menuItemId) {
    case MENU.saveTab:
      return saveSingleTab(tab, false);
    case MENU.saveTabKeywords:
      return saveSingleTab(tab, true);
    case MENU.saveWindow:
      if (tab?.windowId !== undefined && !tab.incognito) {
        await handleSave({ type: 'save', scope: 'window', windowId: tab.windowId, close: true });
      }
      return;
    case MENU.openLibrary:
      return openLibrary();
  }
}

export async function onCommand(command: string, tab?: Browser.tabs.Tab): Promise<void> {
  const activeTab =
    tab ?? (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? undefined;
  switch (command) {
    case 'save-all':
      await handleSave({ type: 'save', scope: 'all', close: true, windowId: activeTab?.windowId ?? (await currentNormalWindowId()) });
      return;
    case 'save-window':
      if (activeTab?.windowId !== undefined && !activeTab.incognito) {
        await handleSave({ type: 'save', scope: 'window', windowId: activeTab.windowId, close: true });
      }
      return;
    case 'save-tab': {
      const settings = await getSettings();
      return saveSingleTab(activeTab, settings.askKeywordsOnSingleSave);
    }
  }
}
