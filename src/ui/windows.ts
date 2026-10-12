import type { Browser } from 'wxt/browser';
import { classifyUrl, unwrapViewerUrl } from '@/lib/urls';
import type { OpenWindow } from './hooks';

/** An open window as the popup and the full list show it ("Open windows"). */
export interface WindowInfo {
  id: number;
  /** "This window", "Window 2", "Incognito window", or the name the window was given. */
  name: string;
  /** The name the person gave it (1.0, Rename window), or ''. */
  given: string;
  /** The window Tabfold was opened from. */
  current: boolean;
  incognito: boolean;
  tabs: Browser.tabs.Tab[];
  /** Tabs a fold of this window would save and close. */
  foldable: Browser.tabs.Tab[];
  /** Fold covers it (an Incognito window only with "Fold Incognito windows too"). */
  folds: boolean;
}

export function tabUrl(tab: Browser.tabs.Tab): string {
  return unwrapViewerUrl(tab.url || tab.pendingUrl || '');
}

/** Would a fold save and close this tab? The same rules as the worker: not pinned (per the setting), playing, blank or a Tabfold page. */
export function foldsTab(tab: Browser.tabs.Tab, keepPinnedOpen: boolean, ownOrigin: string): boolean {
  const kind = classifyUrl(tabUrl(tab), ownOrigin);
  return kind !== 'own' && kind !== 'blank' && !(tab.pinned && keepPinnedOpen) && !tab.audible;
}

/**
 * The open windows, the one Tabfold was opened from first ("This window"), then the others in
 * Chrome's order ("Window 2", "Window 3"…).
 */
export function describeWindows(
  windows: OpenWindow[],
  options: { currentWindowId?: number; keepPinnedOpen: boolean; foldsIncognito: boolean; ownOrigin: string },
): WindowInfo[] {
  const current = windows.find((w) => w.id === options.currentWindowId);
  const ordered = current ? [current, ...windows.filter((w) => w !== current)] : windows;
  const incognitoCount = windows.filter((w) => w.incognito && w !== current).length;
  let number = current ? 1 : 0;
  let incognitoNumber = 0;
  return ordered.map((window) => {
    const isCurrent = window === current;
    // Windows are numbered by their place, named or not ("Client work" is window 2, so the next is "Window 3").
    if (!isCurrent && window.incognito) incognitoNumber += 1;
    else if (!isCurrent) number += 1;
    let name: string;
    if (window.name) name = window.name;
    else if (isCurrent) name = 'This window';
    else if (window.incognito) name = incognitoCount > 1 ? `Incognito window ${incognitoNumber}` : 'Incognito window';
    else name = `Window ${number}`;
    const folds = !window.incognito || options.foldsIncognito;
    return {
      id: window.id,
      name,
      given: window.name,
      current: isCurrent,
      incognito: window.incognito,
      tabs: window.tabs,
      foldable: folds ? window.tabs.filter((t) => foldsTab(t, options.keepPinnedOpen, options.ownOrigin)) : [],
      folds,
    };
  });
}

/** What Fold offers: ask "Just this window" or "All N windows" only when both mean something. */
export function foldChoice(windows: WindowInfo[]): { ask: boolean; thisWindow?: WindowInfo; withTabs: WindowInfo[]; allTabs: number } {
  const withTabs = windows.filter((w) => w.foldable.length > 0);
  const thisWindow = windows.find((w) => w.current);
  const allTabs = withTabs.reduce((n, w) => n + w.foldable.length, 0);
  return { ask: withTabs.length > 1 && !!thisWindow && thisWindow.foldable.length > 0, thisWindow, withTabs, allTabs };
}
