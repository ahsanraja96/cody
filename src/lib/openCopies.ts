import { classifyUrl, dedupeKey } from './urls';

/** An open tab, as much as finding copies needs (a `chrome.tabs.Tab` fits). */
export interface OpenTabLike {
  id?: number;
  windowId?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  audible?: boolean;
  incognito?: boolean;
  lastAccessed?: number;
}

/** One page open more than once: the copy that stays, and the ones "Close the copies" closes. */
export interface OpenCopyGroup {
  url: string;
  title: string;
  keepTabId: number;
  closeTabIds: number[];
}

export interface OpenCopies {
  /** Pages open more than once that have a copy to close ("3 pages are open twice"). */
  pages: number;
  /** Tabs "Close the copies" would close. */
  extra: number;
  groups: OpenCopyGroup[];
}

/**
 * Web pages open in more than one tab (the same address, ignoring a trailing slash; Incognito and
 * normal tabs never count as copies of each other). The copy that stays is the one looked at last
 * (the active tab first); pinned tabs and tabs playing sound are never closed. Pure: the screens
 * count with it and the worker closes with it.
 */
export function findOpenCopies(tabs: readonly OpenTabLike[]): OpenCopies {
  const byPage = new Map<string, OpenTabLike[]>();
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl || '';
    if (tab.id === undefined || classifyUrl(url) !== 'web') continue;
    const key = `${tab.incognito ? 'i' : 'n'}|${dedupeKey(url)}`;
    const list = byPage.get(key);
    if (list) list.push(tab);
    else byPage.set(key, [tab]);
  }
  const groups: OpenCopyGroup[] = [];
  for (const list of byPage.values()) {
    if (list.length < 2) continue;
    const ranked = [...list].sort(
      (a, b) =>
        Number(!!b.active) - Number(!!a.active) ||
        (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) ||
        (a.id ?? 0) - (b.id ?? 0),
    );
    const keep = ranked[0]!;
    const close = ranked.slice(1).filter((t) => !t.pinned && !t.audible);
    if (close.length === 0) continue;
    groups.push({
      url: keep.url || keep.pendingUrl || '',
      title: keep.title || keep.url || '',
      keepTabId: keep.id!,
      closeTabIds: close.map((t) => t.id!),
    });
  }
  return { pages: groups.length, extra: groups.reduce((n, g) => n + g.closeTabIds.length, 0), groups };
}
