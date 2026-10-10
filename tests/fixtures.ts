import type { TabLike, WindowLike } from '@/lib/capture';
import type { CapturedTab, CapturedWindow } from '@/lib/types';

let nextTabId = 1;

export function tab(url: string, extra: Partial<TabLike> = {}): TabLike {
  return {
    id: nextTabId++,
    index: 0,
    url,
    title: `Title of ${url}`,
    pinned: false,
    active: false,
    incognito: false,
    groupId: -1,
    ...extra,
  };
}

export function win(id: number, tabs: TabLike[], extra: Partial<WindowLike> = {}): WindowLike {
  return {
    id,
    focused: false,
    incognito: false,
    type: 'normal',
    state: 'normal',
    left: 0,
    top: 0,
    width: 1200,
    height: 800,
    tabs: tabs.map((t, index) => ({ ...t, index, windowId: id })),
    ...extra,
  };
}

export function capturedTab(url: string, extra: Partial<CapturedTab> = {}): CapturedTab {
  return {
    url,
    title: `Title of ${url}`,
    favIconUrl: '',
    pinned: false,
    groupName: null,
    groupColor: null,
    groupCollapsed: false,
    keywords: [],
    urlTruncated: false,
    ...extra,
  };
}

export function capturedWindow(urls: string[], extra: Partial<CapturedWindow> = {}): CapturedWindow {
  return { name: '', focused: false, bounds: null, state: null, tabs: urls.map((u) => capturedTab(u)), ...extra };
}

export const OWN = 'chrome-extension://tabfoldtestid/';
