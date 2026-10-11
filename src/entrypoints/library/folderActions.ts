import { browser } from 'wxt/browser';
import { categorize, category, siteKey, type CategoryId, type SiteKinds } from '@/lib/categories';
import { FREE_LIMITS } from '@/lib/limits';
import { CommandError, send, type LimitErrorCode } from '@/lib/messages';
import type { PlanState } from '@/lib/pro/types';
import { UNDO_WINDOW_MS, type LiveFolder } from '@/lib/state';
import type { FolderRecord, TabGroupColor, TabRecord } from '@/lib/types';
import { dismissToast, toast, type ToastOptions } from '@/ui/components/Toast';
import { personalFolders } from '@/lib/teams';
import { cleanFolderName, isSnoozed, type TabGroup } from '@/ui/folders';
import { hasFreeLimits } from '@/ui/hooks';
import { errorCode, proErrorText } from '@/ui/pro';
import { formatSnoozeTime } from '@/ui/snooze';
import { count } from './format';
import { goToPlans } from './router';
import { openDialog, useLibraryUi } from './uiStore';
import { dropUndo, registerUndo } from './undo';

/**
 * What the full list's folder, move, snooze and live-folder controls do: each sends one command to
 * the worker, says what happened in a toast (with Undo when the worker gives an action id), and
 * turns the Free limits into their own small dialogs instead of errors.
 */

const LIMIT_CODES = new Set<string>(['list-full', 'folder-limit', 'snooze-limit']);

/** Show the right thing for a failed command. True when it was a limit or plan question, handled. */
export function handleCommandError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'folder-limit') {
    openDialog({ kind: 'folder-limit' });
    return true;
  }
  if (code === 'snooze-limit') {
    openDialog({ kind: 'snooze-limit' });
    return true;
  }
  if (code === 'list-full') {
    useLibraryUi.getState().setLimitHit('list-full');
    return true;
  }
  if (code === 'needs-pro' || code === 'needs-pro-ai') {
    goToPlans();
    return true;
  }
  toast(proErrorText(error), { tone: 'error' });
  return false;
}

export function isLimitCode(code: string | undefined): code is LimitErrorCode {
  return !!code && LIMIT_CODES.has(code);
}

/** Undo a worker action; says why when it couldn't. */
export async function undoAction(actionId: string): Promise<void> {
  try {
    const result = await send({ type: 'undo', actionId });
    if (!result.undone && result.reason) toast(result.reason, { tone: 'error' });
  } catch (error) {
    toast(proErrorText(error), { tone: 'error' });
  }
}

/** A toast with Undo for 10 seconds (⌘Z / Ctrl+Z too) when the worker gave action ids. */
export function undoToast(message: string, actionIds: Array<string | null | undefined>, options: ToastOptions = {}): void {
  const ids = actionIds.filter((id): id is string => !!id);
  if (ids.length === 0) {
    toast(message, { tone: 'success', ...options });
    return;
  }
  const key = `act:${ids.join(',')}`;
  let toastId = 0;
  const undo = () => {
    dropUndo(key);
    dismissToast(toastId);
    // Newest first, so a move out of a folder and a site move undo in the right order.
    void (async () => {
      for (const id of [...ids].reverse()) await undoAction(id);
    })();
  };
  toastId = toast(message, {
    tone: 'success',
    duration: UNDO_WINDOW_MS,
    countdown: true,
    announce: `${message} Undo available for 10 seconds.`,
    action: { label: 'Undo', onClick: undo },
    ...options,
  });
  registerUndo(key, undo);
}

// ---------------------------------------------------------------------------------------------
// Folders

/** Free already has its 3 folders: show "Free has 3 folders" instead of asking the worker. Team folders don't count. */
export function folderLimitReached(plan: PlanState, folders: readonly FolderRecord[] | undefined): boolean {
  return hasFreeLimits(plan) && personalFolders(folders ?? []).length >= FREE_LIMITS.folders;
}

/** A new folder; with `teamId`, a team folder everyone in the team sees ("New team folder"). */
export async function createFolder(name: string, color: TabGroupColor, tabRecordIds: string[] = [], teamId?: string): Promise<FolderRecord | null> {
  const clean = cleanFolderName(name);
  if (!clean) return null;
  try {
    const { folder } = await send({
      type: 'folder-create',
      name: clean,
      color,
      ...(tabRecordIds.length ? { tabRecordIds } : {}),
      ...(teamId ? { teamId } : {}),
    });
    if (tabRecordIds.length) toast(`Moved ${count(tabRecordIds.length, 'tab')} to ${folder.name}`, { tone: 'success' });
    return folder;
  } catch (error) {
    handleCommandError(error);
    return null;
  }
}

export async function renameFolder(folder: FolderRecord, name: string): Promise<void> {
  const clean = cleanFolderName(name);
  if (!clean || clean === folder.name) return;
  try {
    await send({ type: 'folder-update', id: folder.id, name: clean });
  } catch (error) {
    handleCommandError(error);
  }
}

export async function recolorFolder(folder: FolderRecord, color: TabGroupColor): Promise<void> {
  if (color === folder.color) return;
  try {
    await send({ type: 'folder-update', id: folder.id, color });
  } catch (error) {
    handleCommandError(error);
  }
}

export async function deleteFolder(folder: FolderRecord): Promise<void> {
  try {
    const { tabs, actionId } = await send({ type: 'folder-delete', id: folder.id });
    undoToast(
      tabs > 0 ? `Deleted “${folder.name}”. Its ${count(tabs, 'tab')} went back to their kind of site.` : `Deleted “${folder.name}”.`,
      [actionId],
    );
  } catch (error) {
    handleCommandError(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Moving tabs

/** Into a folder, or out of their folder (`folder` null). */
export async function moveToFolder(tabs: TabRecord[], folder: FolderRecord | null, from?: FolderRecord | null): Promise<void> {
  const ids = tabs.map((t) => t.id);
  if (ids.length === 0) return;
  try {
    const { moved, actionId } = await send({ type: 'tabs-move', tabRecordIds: ids, folderId: folder?.id ?? null });
    const n = moved || ids.length;
    const shared = !!folder?.teamId && !(from?.teamId === folder.teamId);
    undoToast(
      folder
        ? shared
          ? `Moved ${count(n, 'tab')} to ${folder.name}. Your team sees ${n === 1 ? 'it' : 'them'} now.`
          : `Moved ${count(n, 'tab')} to ${folder.name}`
        : `Took ${count(n, 'tab')} out of ${from?.name ?? 'the folder'}`,
      [actionId],
    );
  } catch (error) {
    handleCommandError(error);
  }
}

/**
 * "Kind of site ›" and dropping on a site group: the tab's site goes to that kind, remembered for
 * its new tabs. A tab in a folder comes out of it first (in a folder, kind doesn't show).
 */
export async function moveSiteToKind(tab: TabRecord, kind: CategoryId, siteKinds: SiteKinds, from?: FolderRecord | null): Promise<void> {
  const host = siteKey(tab.url);
  const current = categorize(tab.url, siteKinds);
  const name = category(kind).name;
  const ids: Array<string | null> = [];
  try {
    if (tab.folderId) ids.push((await send({ type: 'tabs-move', tabRecordIds: [tab.id], folderId: null })).actionId);
    if (current !== kind && host) {
      ids.push((await send({ type: 'site-kind-set', host, kind })).actionId);
      undoToast(`Moved ${host} to ${name}. Its new tabs go there too.`, ids);
    } else {
      undoToast(`Took 1 tab out of ${from?.name ?? 'the folder'}, back to ${name}`, ids);
    }
  } catch (error) {
    if (ids.length) undoToast(`Took 1 tab out of ${from?.name ?? 'the folder'}`, ids);
    handleCommandError(error);
  }
}

/** Put a site back with its built-in kind ("Put back" in Settings). */
export async function putSiteBack(host: string, quiet = false): Promise<string | null> {
  try {
    const { actionId } = await send({ type: 'site-kind-set', host, kind: null });
    if (!quiet) undoToast(`Put ${host} back`, [actionId]);
    return actionId;
  } catch (error) {
    handleCommandError(error);
    return null;
  }
}

/** A tab dropped on a group (in the list or the left column). */
export async function dropOnGroup(tab: TabRecord, group: TabGroup, siteKinds: SiteKinds, folders: readonly FolderRecord[]): Promise<void> {
  const from = tab.folderId ? (folders.find((f) => f.id === tab.folderId) ?? null) : null;
  if (group.kind === 'folder') {
    if (!group.folder || tab.folderId === group.folder.id) return;
    await moveToFolder([tab], group.folder);
    return;
  }
  if (!group.categoryId) return;
  if (!tab.folderId && categorize(tab.url, siteKinds) === group.categoryId) return;
  await moveSiteToKind(tab, group.categoryId, siteKinds, from);
}

// ---------------------------------------------------------------------------------------------
// Snooze

function untilText(until: number): string {
  return formatSnoozeTime(until).replace(/^(Today|Tomorrow|Yesterday)/, (w) => w.toLowerCase());
}

export async function snoozeTabs(tabs: TabRecord[], until: number): Promise<void> {
  const ids = tabs.filter((t) => !isSnoozed(t)).map((t) => t.id);
  if (ids.length === 0) return;
  try {
    const { snoozed, actionId } = await send({ type: 'snooze', until, tabRecordIds: ids });
    undoToast(`Snoozed ${count(snoozed || ids.length, 'tab')} until ${untilText(until)}`, [actionId]);
  } catch (error) {
    handleCommandError(error);
  }
}

export async function wakeTabs(tabs: TabRecord[]): Promise<void> {
  try {
    const { opened } = await send({ type: 'snooze-wake', tabRecordIds: tabs.map((t) => t.id) });
    toast(opened ? `Opened ${count(opened, 'tab')} in the background` : 'Nothing to wake: it’s back already.');
  } catch (error) {
    handleCommandError(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Live folders (Pro)

export async function openLive(folder: FolderRecord, live: Record<string, LiveFolder>, folders: readonly FolderRecord[], plan: PlanState): Promise<void> {
  if (hasFreeLimits(plan)) {
    goToPlans();
    return;
  }
  if (live[folder.id]) {
    await focusLive(folder);
    return;
  }
  const other = Object.keys(live)
    .map((id) => folders.find((f) => f.id === id))
    .find((f): f is FolderRecord => !!f);
  if (other) {
    openDialog({ kind: 'live-switch', from: other, to: folder });
    return;
  }
  await startLive(folder, false);
}

export async function startLive(folder: FolderRecord, foldOthers: boolean): Promise<void> {
  try {
    const current = await browser.windows.getCurrent().catch(() => undefined);
    const tabs = current?.id !== undefined ? await browser.tabs.query({ windowId: current.id }).catch(() => []) : [];
    // This page's window has other tabs: the group gets a window of its own.
    const result = await send({ type: 'live-open', folderId: folder.id, foldOthers, newWindow: tabs.length > 1 });
    if (result.reason) toast(result.reason, { tone: 'error' });
    else toast(`“${folder.name}” is open as a tab group. Changes save here.`, { tone: 'success' });
  } catch (error) {
    handleCommandError(error);
  }
}

export async function foldLive(folder: FolderRecord): Promise<void> {
  try {
    const { folded } = await send({ type: 'live-fold', folderId: folder.id });
    toast(`Folded the “${folder.name}” group (${count(folded, 'tab')})`, { tone: 'success' });
  } catch (error) {
    handleCommandError(error);
  }
}

export async function focusLive(folder: FolderRecord): Promise<void> {
  try {
    const { focused } = await send({ type: 'live-focus', folderId: folder.id });
    if (!focused) toast('That window was closed.', { tone: 'error' });
  } catch (error) {
    handleCommandError(error);
  }
}

/** A CommandError's limit details ({ room, needed, limit }). */
export function limitDetails(error: unknown): { room?: number; needed?: number; limit?: number } {
  return error instanceof CommandError ? (error.details ?? {}) : {};
}
