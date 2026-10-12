import { browser, type Browser } from 'wxt/browser';
import { folderForGroup } from '@/lib/foldBack';
import { CommandError, send, type FoldOutcome } from '@/lib/messages';
import { findOpenCopies, type OpenCopies } from '@/lib/openCopies';
import type { SearchDoc } from '@/lib/search/engine';
import type { FolderRecord } from '@/lib/types';
import { displayHost } from '@/lib/urls';
import { toast } from './components/Toast';
import type { WindowInfo } from './windows';

/**
 * 1.0 (Fi-* boards): what the popup, the side panel and the full list share about open tabs and
 * windows: pages open twice ("3 pages are open twice · Close the copies"), a window's ⋯ actions
 * (Tidy into groups, Rename window, Close the copies, Fold into…), the fold-back hint, the fold's
 * wording, and open tabs as search results with their window's name.
 */

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * Pages open more than once across these windows; with `windowId`, only the ones with an extra copy
 * in that window (what its "Close the copies" closes).
 */
export function copiesIn(windows: readonly Pick<WindowInfo, 'id' | 'tabs'>[], windowId?: number): OpenCopies {
  const all = findOpenCopies(windows.flatMap((w) => w.tabs));
  if (windowId === undefined) return all;
  const here = new Set(windows.find((w) => w.id === windowId)?.tabs.map((t) => t.id) ?? []);
  const groups = all.groups
    .map((g) => ({ ...g, closeTabIds: g.closeTabIds.filter((id) => here.has(id)) }))
    .filter((g) => g.closeTabIds.length > 0);
  return { pages: groups.length, extra: groups.reduce((n, g) => n + g.closeTabIds.length, 0), groups };
}

/** "3 pages are open twice", "1 page is open twice", "2 pages are open more than once". */
export function copiesText(copies: OpenCopies): string {
  const twice = copies.groups.every((g) => g.closeTabIds.length === 1);
  const how = twice ? 'open twice' : 'open more than once';
  return copies.pages === 1 ? `1 page is ${how}` : `${copies.pages.toLocaleString()} pages are ${how}`;
}

export const COPIES_TIP = 'Closes the extra copies and keeps the one you looked at last';

/** "Closed 3 copies". */
export function closedText(closed: number): string {
  return `Closed ${plural(closed, 'copy', 'copies')}`;
}

/** "Grouped 18 tabs into 4 groups". */
export function groupedText(grouped: number, groups: number): string {
  return `Grouped ${plural(grouped, 'tab')} into ${plural(groups, 'group')}`;
}

/** Why a window command failed, in a sentence. */
export function commandProblem(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof CommandError && error.code === 'not-built') return 'This isn’t ready in this build yet.';
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A toast with Undo for 10 seconds (the popup and the side panel; the full list has its own, with ⌘Z). */
export function undoableToast(message: string, actionId: string | null | undefined): void {
  if (!actionId) {
    toast(message, { tone: 'success' });
    return;
  }
  toast(message, {
    tone: 'success',
    duration: 10_000,
    countdown: true,
    announce: `${message}. Undo available for 10 seconds.`,
    action: {
      label: 'Undo',
      onClick: () => {
        void send({ type: 'undo', actionId })
          .then((result) => {
            if (!result.undone && result.reason) toast(result.reason, { tone: 'error' });
          })
          .catch(() => undefined);
      },
    },
  });
}

/** "Close the copies" (everywhere, or one window), then a toast with Undo. */
export async function closeCopies(windowId?: number): Promise<void> {
  try {
    const { closed, actionId } = await send({ type: 'copies-close', ...(windowId !== undefined ? { windowId } : {}) });
    if (closed > 0) undoableToast(closedText(closed), actionId);
    else toast('No copies to close: every page is open once.');
  } catch (error) {
    toast(commandProblem(error), { tone: 'error' });
  }
}

/** "Tidy into groups": the window's loose tabs into Chrome tab groups by kind of site. */
export async function tidyWindow(windowId: number): Promise<void> {
  try {
    const { grouped, groups, actionId } = await send({ type: 'window-tidy', windowId });
    if (grouped > 0) undoableToast(groupedText(grouped, groups), actionId);
    else toast('Nothing to tidy: no two loose tabs are the same kind of site.');
  } catch (error) {
    toast(commandProblem(error), { tone: 'error' });
  }
}

/** Name a window ('' takes the name away). Remembered across restarts. */
export async function renameWindow(windowId: number, name: string): Promise<boolean> {
  try {
    await send({ type: 'window-rename', windowId, name: name.replace(/\s+/g, ' ').trim() });
    return true;
  } catch (error) {
    toast(commandProblem(error, 'Couldn’t rename the window.'), { tone: 'error' });
    return false;
  }
}

/** A window's name: at most this many characters. */
export const WINDOW_NAME_MAX = 60;

/**
 * The fold's toast or line: "Folded 12 tabs into Client sites", "Folded 12 tabs · 5 went back into
 * Client sites", else "Folded 12 tabs" with `extra` (the full list adds " · freed ~2.1 GB").
 */
export function foldOutcomeText(outcome: FoldOutcome, extra = ''): string {
  const folded = outcome.savedTabs + outcome.skippedDuplicates;
  const tabs = plural(folded, 'tab');
  if (outcome.intoFolder) return `Folded ${tabs} into ${outcome.intoFolder.name}`;
  const back = (outcome.backIntoFolders ?? []).filter((b) => b.tabs > 0);
  if (back.length) {
    const first = back[0]!;
    const others = back.length > 1 ? ` and ${plural(back.length - 1, 'other folder')}` : '';
    return `Folded ${tabs} · ${first.tabs.toLocaleString()} went back into ${first.name}${others}`;
  }
  return `Folded ${tabs}${extra}`;
}

// ---- Fold back --------------------------------------------------------------------------------

export type TabGroups = ReadonlyMap<number, Browser.tabGroups.TabGroup>;

/** Folders whose Chrome tab group is open in this window: folding it puts their tabs back in. */
export function foldBackFolders(
  tabs: readonly Browser.tabs.Tab[],
  groups: TabGroups,
  groupFolders: Readonly<Record<string, string>>,
  folders: readonly FolderRecord[] | undefined,
): FolderRecord[] {
  if (!folders?.length) return [];
  const out: FolderRecord[] = [];
  const seen = new Set<number>();
  for (const tab of tabs) {
    const id = tab.groupId;
    if (id === undefined || id < 0 || seen.has(id)) continue;
    seen.add(id);
    const group = groups.get(id);
    const folder = folderForGroup(group ?? { id }, groupFolders, folders);
    if (folder && !out.includes(folder)) out.push(folder);
  }
  return out;
}

/** "Its “Client sites” group folds back into the folder". */
export function foldBackText(folders: readonly FolderRecord[]): string {
  if (folders.length === 1) return `Its “${folders[0]!.name}” group folds back into the folder`;
  return `Its “${folders[0]!.name}” and ${folders.length === 2 ? `“${folders[1]!.name}”` : `${folders.length - 1} other`} groups fold back into their folders`;
}

// ---- Search -----------------------------------------------------------------------------------

/**
 * Open tabs as search documents (1.0, Fi-Search): this window's first, then the others, each with
 * its window's name ("This window", "Client work", "Window 3"). A page open twice shows once, the
 * copy looked at last. Tabfold's own pages are left out.
 */
export function openSearchDocs(windows: readonly WindowInfo[], ownOrigin: string): SearchDoc[] {
  // Incognito windows only while "Fold Incognito windows too" covers them, as before.
  const covered = windows.filter((w) => w.folds);
  const extra = new Set(findOpenCopies(covered.flatMap((w) => w.tabs)).groups.flatMap((g) => g.closeTabIds));
  const ordered = [...covered].sort((a, b) => Number(b.current) - Number(a.current));
  return ordered.flatMap((window) =>
    window.tabs
      .filter((t) => t.id !== undefined && (t.url || t.pendingUrl) && !extra.has(t.id) && !(t.url || t.pendingUrl || '').startsWith(ownOrigin))
      .map((t) => ({
        id: `open:${t.id}`,
        kind: 'open' as const,
        title: t.title || displayHost(t.url || t.pendingUrl || ''),
        url: t.url || t.pendingUrl || '',
        keywords: [],
        favIconUrl: '',
        tabId: t.id,
        windowId: window.id,
        windowLabel: window.name,
        discarded: t.discarded,
        incognito: t.incognito || undefined,
      })),
  );
}

/** Search hits for open tabs, this window's first (the engine's order inside each). */
export function openHitsFirstHere<T extends { doc: SearchDoc }>(hits: readonly T[], currentWindowId: number | undefined): T[] {
  if (currentWindowId === undefined) return [...hits];
  return [...hits.filter((h) => h.doc.windowId === currentWindowId), ...hits.filter((h) => h.doc.windowId !== currentWindowId)];
}

/** Folders whose name has every typed word (for "Folded" in search: folders first). */
export function matchingFolders<T extends Pick<FolderRecord, 'name'>>(folders: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w && !w.startsWith('#'));
  if (!words.length) return [];
  return folders.filter((f) => {
    const name = f.name.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

/** Switch to an open tab and bring its window forward. False when it was closed meanwhile. */
export async function switchTo(tabId: number, windowId?: number): Promise<boolean> {
  try {
    await browser.tabs.update(tabId, { active: true });
    if (windowId !== undefined) await browser.windows.update(windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}
