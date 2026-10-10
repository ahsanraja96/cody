import { createElement } from 'react';
import { browser } from 'wxt/browser';
import { CircleStop } from 'lucide-react';
import { resetDataGuard } from '@/lib/dataGuard';
import { db } from '@/lib/db';
import { exportFileName, exportHtml } from '@/lib/exporters';
import { plural } from '@/lib/format';
import { send, type RestoreFailure, type RestoreMode, type RestoreOutcome } from '@/lib/messages';
import {
  clearAllData,
  deleteSessionsForever,
  duplicateSession,
  exportGraphs,
  LimitError,
  listTrash,
  restoreFromTrash,
  setSessionPinned,
  trashSessions,
} from '@/lib/repo';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { backup, lastAction, recoveryOffer, snapshotMirror } from '@/lib/state';
import { confirmAction } from '@/ui/components/Dialog';
import { toast } from '@/ui/components/Toast';
import { copyText, currentScreen } from '@/ui/hooks';
import { flows } from './flows/store';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------------------------
// Restoring

interface RestoreContext {
  sessionId: string | null;
  sessionName: string;
  mode?: RestoreMode;
  windowRecordId?: string;
}

function isFileFailure(failure: RestoreFailure): boolean {
  return failure.reason === 'file-access' || (failure.reason === undefined && /^file:/i.test(failure.url));
}

/** "Stopped. 12 tabs opened, the rest are still saved." */
export function stoppedMessage(opened: number): string {
  return `Stopped. ${plural(opened, 'tab')} opened, the rest are still saved.`;
}

/**
 * What the library shows when a restore it started (or cancelled) finishes: the already-open
 * prompt, the file access steps, the "Restored 21 of 24 tabs" card, or a toast. Each restore is
 * reported once, whether the answer or the worker's restore-done event arrives first.
 */
export function reportRestoreOutcome(outcome: RestoreOutcome, context: RestoreContext): void {
  const state = flows();
  if (outcome.restoreId) {
    if (state.handled.has(outcome.restoreId)) return;
    state.handled.add(outcome.restoreId);
    if (state.live?.restoreId === outcome.restoreId) state.setLive(null);
  }
  if (state.pending && state.pending.sessionId === context.sessionId) state.setPending(null);

  if (context.sessionId && (outcome.alreadyOpen || outcome.alreadyOpenWindowId !== undefined)) {
    const windowIds = outcome.alreadyOpen?.windowIds ?? (outcome.alreadyOpenWindowId !== undefined ? [outcome.alreadyOpenWindowId] : []);
    state.open({
      kind: 'already-open',
      sessionId: context.sessionId,
      sessionName: context.sessionName,
      mode: context.mode ?? 'original',
      windowRecordId: context.windowRecordId,
      windowIds,
      openTabs: outcome.alreadyOpen?.openTabs ?? 0,
      totalTabs: outcome.alreadyOpen?.totalTabs ?? 0,
    });
    return;
  }

  if (outcome.cancelled) {
    toast(stoppedMessage(outcome.opened), { icon: createElement(CircleStop, { size: 16, strokeWidth: 2, 'aria-hidden': true }) });
  }

  const files = outcome.failed.filter(isFileFailure);
  const blocked = outcome.failed.filter((f) => !isFileFailure(f));
  if (files.length > 0 || outcome.needsFileAccess > 0) {
    state.enqueue({
      kind: 'file-access',
      sessionId: context.sessionId,
      sessionName: context.sessionName,
      files,
      opened: outcome.opened,
    });
  }
  if (blocked.length > 0) {
    state.setFailures({
      restoreId: outcome.restoreId,
      sessionId: context.sessionId,
      sessionName: context.sessionName,
      opened: outcome.opened,
      total: outcome.opened + outcome.failed.length,
      failed: blocked,
    });
  } else if (state.failures?.sessionId === context.sessionId) {
    state.setFailures(null);
  }

  if (outcome.trashed && context.sessionId) {
    const id = context.sessionId;
    toast('Restored. The session moved to Trash, as set in Settings.', {
      action: { label: 'Keep it', onClick: () => restoreFromTrash([id]) },
    });
  }
}

/**
 * Restore a session (or one of its windows). Progress shows in the detail panel and, for big
 * restores, a floating card; the outcome is reported by `reportRestoreOutcome`.
 */
export async function restoreSession(sessionId: string, mode: RestoreMode, windowRecordId?: string, force = false): Promise<void> {
  const session = await db.sessions.get(sessionId).catch(() => undefined);
  const sessionName = session?.name ?? 'Session';
  const state = flows();
  state.setPending({ sessionId, sessionName, windowRecordId, startedAt: Date.now() });
  if (state.failures?.sessionId === sessionId) state.setFailures(null);
  try {
    const current = await browser.windows.getCurrent();
    const outcome = await send({
      type: 'restore',
      sessionId,
      windowRecordId,
      mode,
      currentWindowId: current.id,
      screen: currentScreen(),
      force,
      // New windows open behind the library, so its progress stays in view; the first one is focused at the end.
      background: mode !== 'current',
    });
    reportRestoreOutcome(outcome, { sessionId, sessionName, mode, windowRecordId });
  } catch (error) {
    if (flows().pending?.sessionId === sessionId) flows().setPending(null);
    toast(errorText(error), { tone: 'error' });
  }
}

/** Stop a restore after its current batch. What's open stays open; the session isn't changed. */
export async function cancelRestore(restoreId: string): Promise<void> {
  flows().owned.add(restoreId);
  try {
    await send({ type: 'cancel-restore', restoreId });
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

export async function copyFailedLinks(failed: RestoreFailure[]): Promise<void> {
  if (await copyText(failed.map((f) => f.url).join('\n'))) toast('Links copied.');
  else toast("Couldn't copy. Select the links and copy them by hand.", { tone: 'error' });
}

// ---------------------------------------------------------------------------------------------
// Sessions

export async function trashWithUndo(ids: string[], label: string): Promise<void> {
  try {
    await trashSessions(ids);
    toast(`Moved ${label} to Trash`, { action: { label: 'Undo', onClick: () => restoreFromTrash(ids) } });
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

/**
 * Delete sessions for good (only offered inside Trash). One session: "Delete Competitor teardown
 * forever?" / "Its 17 tabs can't be recovered."; several: their count and tabs.
 */
export async function deleteForever(ids: string[], label: string): Promise<boolean> {
  const rows = (await db.sessions.bulkGet(ids)).filter((s) => !!s);
  const tabs = rows.reduce((n, s) => n + s.tabCount, 0);
  const single = rows.length === 1 ? rows[0] : undefined;
  const ok = await confirmAction(
    single
      ? {
          title: `Delete ${single.name} forever?`,
          body: single.tabCount === 1 ? "Its 1 tab can't be recovered." : `Its ${plural(single.tabCount, 'tab')} can't be recovered.`,
          confirmLabel: 'Delete forever',
          danger: true,
        }
      : {
          title: `Delete ${label} forever?`,
          body: `${plural(rows.length, 'session')} and ${plural(tabs, 'tab')} will be deleted for good.`,
          confirmLabel: 'Delete forever',
          danger: true,
        },
  );
  if (!ok) return false;
  try {
    await deleteSessionsForever(ids);
    // Tabfold deleted these itself, so a smaller (or empty) database isn't a wipe.
    await resetDataGuard();
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
    return false;
  }
  return true;
}

/** "Empty Trash?" / "4 sessions and 63 tabs will be deleted for good." Resolves true when emptied. */
export async function emptyTrash(): Promise<boolean> {
  const trash = await listTrash();
  if (trash.length === 0) return false;
  const tabs = trash.reduce((n, s) => n + s.tabCount, 0);
  const ok = await confirmAction({
    title: 'Empty Trash?',
    body: `${plural(trash.length, 'session')} and ${plural(tabs, 'tab')} will be deleted for good.`,
    confirmLabel: 'Empty Trash',
    danger: true,
  });
  if (!ok) return false;
  try {
    await deleteSessionsForever(trash.map((s) => s.id));
    await resetDataGuard();
    toast('Trash emptied.');
    return true;
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
    return false;
  }
}

export async function togglePin(id: string, pinned: boolean): Promise<void> {
  await setSessionPinned(id, pinned);
}

export async function duplicate(id: string): Promise<string | null> {
  try {
    const copy = await duplicateSession(id);
    if (copy) toast('Duplicated.');
    return copy;
  } catch (error) {
    toast(error instanceof LimitError ? error.message : errorText(error), { tone: 'error' });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Export and data

export function downloadText(fileName: string, text: string, type = 'text/html;charset=utf-8'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Download sessions as a UTF-8 HTML page (every live session when no ids are given). */
export async function exportSessions(sessionIds?: string[]): Promise<boolean> {
  try {
    const graphs = await exportGraphs(sessionIds);
    if (graphs.length === 0) {
      toast('Nothing to export yet.');
      return false;
    }
    downloadText(exportFileName(), exportHtml(graphs));
    if (!sessionIds) await backup.markDone();
    toast(`Exported ${plural(graphs.length, 'session')}.`);
    return true;
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
    return false;
  }
}

/** Settings › Clear all data, after the typed confirmation. */
export async function clearEverything(): Promise<void> {
  await clearAllData();
  await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
  await Promise.all([snapshotMirror.set(null), recoveryOffer.set(null), lastAction.set(null)]).catch(() => undefined);
  await resetDataGuard();
}
