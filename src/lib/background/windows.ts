import { browser, type Browser } from 'wxt/browser';
import { rawTabUrl } from '../capture';
import { categorize, category, KIND_GROUP_COLORS, type CategoryId } from '../categories';
import { CommandError, type Command, type CommandResults } from '../messages';
import { findOpenCopies } from '../openCopies';
import { siteKinds, weeklySummarySeen, type ReopenTab } from '../state';
import { classifyUrl } from '../urls';
import { weekKey } from '../weekly';
import { scheduleWindowCap } from './automation';
import { getNormalWindows, sleep } from './browserState';
import { forgetGroupFolder, rememberTidyGroups } from './foldBack';
import { forgetTabLookedAt, noteTabLookedAt, replaceTabLookedAt, tabsLookedAt } from './lookedAt';
import { forgetOpenedByTabfold, replaceOpenedByTabfold } from './openedByTabfold';
import { noteClosingByTabfold, recordChangeUndo, stillOpen } from './save';
import { scheduleNamedWindowsRefresh, setWindowName } from './windowNames';

/**
 * 1.0: open tabs and windows: close the copies of pages open twice, tidy a window into tab groups,
 * name windows (remembered across restarts, `namedWindows`), the weekly summary.
 */
export type WindowsCommand = Extract<Command, { type: 'copies-close' | 'window-tidy' | 'window-rename' | 'weekly-summary-dismiss' }>;

export async function handleWindowsCommand(command: WindowsCommand): Promise<CommandResults[WindowsCommand['type']]> {
  switch (command.type) {
    case 'copies-close':
      return closeCopies(command.windowId);
    case 'window-tidy':
      return tidyWindow(command.windowId);
    case 'window-rename':
      return renameWindow(command.windowId, command.name);
    case 'weekly-summary-dismiss':
      await weeklySummarySeen.set(weekKey(Date.now()));
      return { ok: true };
  }
}

async function openWindow(windowId: number): Promise<Browser.windows.Window> {
  const window = await browser.windows.get(windowId, { populate: true }).catch(() => undefined);
  if (!window || (window.type !== undefined && window.type !== 'normal')) throw new CommandError('This window is no longer open.', 'not-found');
  return window;
}

// ---------------------------------------------------------------------------------------------
// Close the copies

/**
 * "3 pages are open twice · Close the copies": in one window, or every normal window. The copy
 * looked at last stays; pinned and playing tabs never close; only web pages are looked at (never
 * Tabfold's own). Undo reopens each closed copy where it was, in the background.
 */
export async function closeCopies(windowId?: number): Promise<{ closed: number; actionId: string | null }> {
  const windows = windowId !== undefined ? [await openWindow(windowId)] : await getNormalWindows();
  const tabs = windows.flatMap((w) => w.tabs ?? []);
  const copies = findOpenCopies(tabs, await tabsLookedAt());
  const ids = copies.groups.flatMap((g) => g.closeTabIds);
  if (ids.length === 0) return { closed: 0, actionId: null };
  const byId = new Map(tabs.map((t) => [t.id!, t]));
  const reopen: ReopenTab[] = ids.map((id) => {
    const tab = byId.get(id)!;
    return {
      url: rawTabUrl(tab),
      windowId: tab.windowId!,
      index: tab.index,
      pinned: tab.pinned,
      ...(tab.groupId !== undefined && tab.groupId >= 0 ? { groupId: tab.groupId } : {}),
      ...(tab.incognito ? { incognito: true as const } : {}),
    };
  });
  // Closed by Tabfold: a live folder keeps a copy it had.
  noteClosingByTabfold(ids);
  try {
    await Promise.race([browser.tabs.remove(ids), sleep(1500)]);
  } catch {
    for (const id of ids) await browser.tabs.remove(id).catch(() => undefined);
  }
  const left = new Set((await stillOpen(ids)).map((t) => t.id));
  const closed = reopen.filter((_, i) => !left.has(ids[i]));
  const actionId = closed.length ? await recordChangeUndo({ reopenTabs: closed }) : null;
  return { closed: closed.length, actionId };
}

// ---------------------------------------------------------------------------------------------
// Tidy into groups

/** Fewer tabs of a kind than this stay as they are. */
const TIDY_MIN_GROUP = 2;

/**
 * "Tidy into groups": the window's tabs that are neither pinned nor in a group become Chrome tab
 * groups by kind of site (the sites the person moved count), titled like the list ("Mail & chat")
 * in the kind's colour, open. Kinds with a single tab stay loose. Works in Incognito windows too
 * (nothing is saved). Undo takes the tabs out of those groups again.
 */
export async function tidyWindow(windowId: number): Promise<{ grouped: number; groups: number; actionId: string | null }> {
  const window = await openWindow(windowId);
  const kinds = await siteKinds.get();
  const byKind = new Map<CategoryId, number[]>();
  for (const tab of [...(window.tabs ?? [])].sort((a, b) => a.index - b.index)) {
    if (tab.id === undefined || tab.pinned || (tab.groupId !== undefined && tab.groupId >= 0)) continue;
    const url = rawTabUrl(tab);
    if (classifyUrl(url) !== 'web') continue;
    const kind = categorize(url, kinds);
    byKind.set(kind, [...(byKind.get(kind) ?? []), tab.id]);
  }
  const grouped: number[] = [];
  const made: number[] = [];
  let groups = 0;
  for (const [kind, ids] of byKind) {
    if (ids.length < TIDY_MIN_GROUP) continue;
    let groupId: number;
    try {
      groupId = await browser.tabs.group({ tabIds: ids as [number, ...number[]], createProperties: { windowId } });
    } catch {
      if (groups === 0 && grouped.length === 0) {
        throw new CommandError('Chrome didn’t let Tabfold make tab groups here.', 'groups-unavailable');
      }
      continue;
    }
    await browser.tabGroups.update(groupId, { title: category(kind).name, color: KIND_GROUP_COLORS[kind], collapsed: false }).catch(() => undefined);
    grouped.push(...ids);
    made.push(groupId);
    groups += 1;
  }
  // Not a folder's group, whatever its name: folding the window never puts these tabs in a folder.
  await rememberTidyGroups(made);
  const actionId = grouped.length ? await recordChangeUndo({ ungroupTabIds: grouped }) : null;
  return { grouped: grouped.length, groups, actionId };
}

// ---------------------------------------------------------------------------------------------
// Name a window

/** "Client work" ('' takes the name away). Remembered across restarts (not for Incognito windows). */
export async function renameWindow(windowId: number, name: string): Promise<{ ok: true }> {
  await openWindow(windowId);
  await setWindowName(windowId, typeof name === 'string' ? name : '');
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Worker start

/**
 * Called once at the worker's top level: a folder's tab group that closes forgets its folder; tabs
 * opening check "a window has more than N tabs" (debounced); a named window's pages are kept up to
 * date (debounced, cheap with no names). Tabs closing because their window closes (or Chrome quits)
 * change nothing, so a quitting Chrome never empties what a name remembers.
 */
export function setupWindows(): void {
  const safely = (task: Promise<unknown>) => task.catch((error) => console.warn('[tabfold] windows', (error as Error)?.name ?? error));
  try {
    browser.tabGroups.onRemoved.addListener((group) => void safely(forgetGroupFolder(group.id)));
  } catch {
    // No tab groups (an organisation policy): no group is ever a folder's.
  }
  browser.tabs.onCreated.addListener(() => {
    scheduleWindowCap();
    scheduleNamedWindowsRefresh();
  });
  browser.tabs.onRemoved.addListener((id, info) => {
    if (!info.isWindowClosing) scheduleNamedWindowsRefresh();
    void forgetOpenedByTabfold(id);
    void forgetTabLookedAt(id);
  });
  // A tab Tabfold opened counts toward a window's cap once the person looks at it; "Close the
  // copies" keeps the copy looked at last.
  browser.tabs.onActivated.addListener(({ tabId }) => {
    void forgetOpenedByTabfold(tabId);
    void noteTabLookedAt(tabId);
  });
  browser.tabs.onReplaced.addListener((added, removed) => {
    void replaceOpenedByTabfold(added, removed);
    void replaceTabLookedAt(added, removed);
  });
  browser.tabs.onUpdated.addListener((_id, change) => {
    if (change.url) scheduleNamedWindowsRefresh();
  });
  browser.tabs.onAttached.addListener(() => scheduleNamedWindowsRefresh());
  browser.tabs.onDetached.addListener(() => scheduleNamedWindowsRefresh());
}
