import { browser, type Browser } from 'wxt/browser';
import { rawTabUrl } from '../capture';
import { urlKey } from '../sync/records';
import { namedWindows, windowNames, type NamedWindow } from '../state';
import { classifyUrl } from '../urls';
import { getNormalWindows } from './browserState';

/**
 * Named windows (1.0): "Client work". The live names are `windowNames` (session storage, by window
 * id); `namedWindows` (local storage) remembers each name with the pages its window holds, so after
 * Chrome restarts (new window ids) a name goes back to the window whose pages match it best. Names
 * of Incognito windows are never remembered past the session. Names not seen for 30 days are
 * forgotten.
 */

/** Window names are at most this many characters. */
export const WINDOW_NAME_MAX = 60;
/** Pages remembered per named window. */
export const NAMED_WINDOW_URLS = 30;
/** A remembered name not seen for this long is forgotten. */
export const NAMED_WINDOW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** One line, whitespace squeezed, at most 60 characters; '' when nothing is left. */
export function cleanWindowName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, WINDOW_NAME_MAX).join('').trim();
}

/** The urlKeys of a window's web pages, in tab order, at most 30. */
export function windowUrlKeys(tabs: ReadonlyArray<Pick<Browser.tabs.Tab, 'url' | 'pendingUrl' | 'index'>>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    const url = rawTabUrl(tab);
    if (classifyUrl(url) !== 'web') continue;
    const key = urlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= NAMED_WINDOW_URLS) break;
  }
  return keys;
}

function prune(entries: NamedWindow[], now: number): NamedWindow[] {
  return entries.filter((e) => e.name && e.at >= now - NAMED_WINDOW_TTL_MS);
}

/** One change at a time: renames, refreshes and the restart matching never overwrite each other. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

async function windowOf(windowId: number): Promise<Browser.windows.Window | null> {
  try {
    const window = await browser.windows.get(windowId, { populate: true });
    return window.type === undefined || window.type === 'normal' ? window : null;
  } catch {
    return null;
  }
}

/**
 * Name a window, or take its name away (''). The name is remembered across restarts with the
 * window's pages (not for Incognito windows). Only this window's own remembered entry (the one for
 * the name it has now) is replaced: another remembered window that happens to carry the same
 * window id (ids repeat after a restart) keeps its name and is no longer tied to that id.
 */
export function setWindowName(windowId: number, name: string, now = Date.now()): Promise<void> {
  return serial(async () => {
    const clean = cleanWindowName(name);
    const previous = (await windowNames.get())[windowId];
    await windowNames.set(windowId, clean);
    const entries = prune(await namedWindows.get(), now).filter((e) => !(e.windowId === windowId && previous !== undefined && e.name === previous));
    for (const entry of entries) if (entry.windowId === windowId) delete entry.windowId;
    if (clean) {
      const window = await windowOf(windowId);
      if (window && !window.incognito) entries.push({ name: clean, urls: windowUrlKeys(window.tabs ?? []), windowId, at: now });
    }
    await namedWindows.set(entries);
  });
}

/** A window the person named is open: what its pages are now (the 5-minute alarm, and after its tabs change). */
export function refreshNamedWindows(now = Date.now()): Promise<boolean> {
  return serial(async () => {
    const names = await windowNames.get();
    const stored = await namedWindows.get();
    if (Object.keys(names).length === 0 && stored.length === 0) return false;
    const open = new Map((await getNormalWindows()).filter((w) => w.id !== undefined).map((w) => [w.id!, w]));
    let changed = false;
    const entries = prune(stored, now);
    if (entries.length !== stored.length) changed = true;
    for (const entry of entries) {
      if (entry.windowId === undefined) continue;
      const window = open.get(entry.windowId);
      // Only the window that has this very name now: an id from an earlier session, or a window
      // named some other way (after a live folder), never takes over a remembered name.
      if (names[entry.windowId] !== entry.name || !window || window.incognito) continue;
      const urls = windowUrlKeys(window.tabs ?? []);
      // A window with no pages for now (only a New Tab) keeps the pages it had.
      const nextUrls = urls.length ? urls : entry.urls;
      if (JSON.stringify(nextUrls) !== JSON.stringify(entry.urls) || now - entry.at > 60 * 60_000) {
        entry.urls = nextUrls;
        entry.at = now;
        changed = true;
      }
    }
    if (changed) await namedWindows.set(entries);
    return changed;
  });
}

/**
 * How well a remembered window matches an open one: the pages they share, when that's at least
 * half of the remembered window's pages and at least 2 (or a 1-page window that is exactly a
 * 1-page remembered one); else 0.
 */
export function matchScore(remembered: readonly string[], open: readonly string[]): number {
  const mine = new Set(remembered);
  const theirs = new Set(open);
  if (mine.size === 0 || theirs.size === 0) return 0;
  const shared = [...mine].filter((k) => theirs.has(k)).length;
  if (mine.size === 1 && theirs.size === 1) return shared;
  return shared >= 2 && shared * 2 >= mine.size ? shared : 0;
}

/**
 * After Chrome restarts: give each remembered name back to the open window whose pages match it
 * best (one window per name, one name per window). Windows already named keep their names.
 * Returns how many windows got a name back.
 */
export function restoreWindowNames(now = Date.now()): Promise<number> {
  return serial(async () => {
    const stored = await namedWindows.get();
    const entries = prune(stored, now);
    if (entries.length === 0) {
      if (stored.length) await namedWindows.set(entries);
      return 0;
    }
    const names = await windowNames.get();
    const taken = new Set(Object.values(names).map((n) => n.toLocaleLowerCase()));
    const windows = (await getNormalWindows()).filter((w) => w.id !== undefined && !w.incognito && !names[w.id]);
    const pairs: Array<{ entry: NamedWindow; windowId: number; score: number }> = [];
    for (const entry of entries) {
      if (taken.has(entry.name.toLocaleLowerCase())) continue;
      for (const window of windows) {
        const score = matchScore(entry.urls, windowUrlKeys(window.tabs ?? []));
        if (score > 0) pairs.push({ entry, windowId: window.id!, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score || b.entry.at - a.entry.at);
    const usedWindows = new Set<number>();
    const usedEntries = new Set<NamedWindow>();
    const usedNames = new Set(taken);
    let named = 0;
    for (const pair of pairs) {
      const key = pair.entry.name.toLocaleLowerCase();
      if (usedWindows.has(pair.windowId) || usedEntries.has(pair.entry) || usedNames.has(key)) continue;
      usedWindows.add(pair.windowId);
      usedEntries.add(pair.entry);
      usedNames.add(key);
      await windowNames.set(pair.windowId, pair.entry.name);
      pair.entry.windowId = pair.windowId;
      pair.entry.at = now;
      named += 1;
    }
    // A remembered window not found isn't tied to a window id any more: ids repeat after a restart,
    // and another window may have that one now.
    let unlinked = false;
    for (const entry of entries) {
      if (usedEntries.has(entry) || entry.windowId === undefined || names[entry.windowId] === entry.name) continue;
      delete entry.windowId;
      unlinked = true;
    }
    if (named || unlinked || entries.length !== stored.length) await namedWindows.set(entries);
    return named;
  });
}

/**
 * A reopened fold's window had a name: the new window gets it (unless it already has one), and it
 * is that remembered window from now on (a remembered one of that name with no open window goes).
 */
export async function nameReopenedWindow(windowId: number, name: string, now = Date.now()): Promise<void> {
  const clean = cleanWindowName(name);
  if (!clean) return;
  if ((await windowNames.get())[windowId]) return;
  await setWindowName(windowId, clean, now);
  await serial(async () => {
    const names = await windowNames.get();
    const open = new Set((await getNormalWindows()).map((w) => w.id));
    const entries = await namedWindows.get();
    const live = (e: NamedWindow) => e.windowId !== undefined && open.has(e.windowId) && names[e.windowId] === e.name;
    const kept = entries.filter((e) => e.windowId === windowId || e.name !== clean || live(e));
    if (kept.length !== entries.length) await namedWindows.set(kept);
  });
}

// ---------------------------------------------------------------------------------------------
// In the worker

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** Tabs changed in a named window: its pages are read again this long after the last change. */
export const NAMED_REFRESH_DELAY_MS = 5_000;

/** Tabs changed somewhere: a named window's pages are read again a moment later (cheap with no names). */
export function scheduleNamedWindowsRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshNamedWindows().catch((error) => console.warn('[tabfold] window names not kept', (error as Error)?.name ?? error));
  }, NAMED_REFRESH_DELAY_MS);
}

/** Chrome just started: names go back to their windows once Chrome has brought them back (tried twice). */
export function restoreWindowNamesSoon(delays = [5_000, 20_000]): void {
  for (const delay of delays) {
    setTimeout(() => {
      restoreWindowNames().catch((error) => console.warn('[tabfold] window names not restored', (error as Error)?.name ?? error));
    }, delay);
  }
}

/** For tests: forget the pending refresh. */
export function resetWindowNamesRuntime(): void {
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
  chain = Promise.resolve();
}
