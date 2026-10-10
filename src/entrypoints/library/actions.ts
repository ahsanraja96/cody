import { browser } from 'wxt/browser';
import { exportFileName, exportHtml } from '@/lib/exporters';
import { plural } from '@/lib/format';
import { send, type RestoreMode } from '@/lib/messages';
import {
  deleteSessionsForever,
  duplicateSession,
  exportGraphs,
  LimitError,
  restoreFromTrash,
  setSessionPinned,
  trashSessions,
} from '@/lib/repo';
import { backup } from '@/lib/state';
import { confirmAction } from '@/ui/components/Dialog';
import { toast } from '@/ui/components/Toast';
import { copyText, currentScreen } from '@/ui/hooks';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export async function restoreSession(sessionId: string, mode: RestoreMode, windowRecordId?: string, force = false): Promise<void> {
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
    });
    if (outcome.alreadyOpenWindowId !== undefined) {
      const windowId = outcome.alreadyOpenWindowId;
      toast('This session is already open.', {
        duration: 10_000,
        actions: [
          { label: 'Switch to it', onClick: () => browser.windows.update(windowId, { focused: true }) },
          { label: 'Open a copy', onClick: () => restoreSession(sessionId, mode, windowRecordId, true) },
        ],
      });
      return;
    }
    if (outcome.failed.length) {
      toast(`Restored ${outcome.opened} of ${outcome.opened + outcome.failed.length} tabs. Chrome blocked the rest.`, {
        tone: 'error',
        duration: 15_000,
        action: {
          label: 'Copy links',
          onClick: async () => {
            if (await copyText(outcome.failed.map((f) => f.url).join('\n'))) toast('Links copied.');
          },
        },
      });
    } else if (outcome.cancelled) {
      toast(`Stopped after ${plural(outcome.opened, 'tab')}.`);
    } else if (outcome.trashed) {
      toast('Restored. The session moved to Trash, as set in Settings.', {
        action: { label: 'Keep it', onClick: () => restoreFromTrash([sessionId]) },
      });
    }
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

export async function trashWithUndo(ids: string[], label: string): Promise<void> {
  try {
    await trashSessions(ids);
    toast(`Moved ${label} to Trash`, { action: { label: 'Undo', onClick: () => restoreFromTrash(ids) } });
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

export async function deleteForever(ids: string[], label: string): Promise<boolean> {
  const ok = await confirmAction({
    title: `Delete ${label} forever?`,
    body: 'This cannot be undone. The tabs are not open anywhere else.',
    confirmLabel: 'Delete forever',
    danger: true,
  });
  if (ok) await deleteSessionsForever(ids);
  return ok;
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

export async function exportSessions(sessionIds?: string[]): Promise<void> {
  const graphs = await exportGraphs(sessionIds);
  if (graphs.length === 0) {
    toast('Nothing to export yet.');
    return;
  }
  downloadText(exportFileName(), exportHtml(graphs));
  if (!sessionIds) await backup.markDone();
  toast(`Exported ${plural(graphs.length, 'session')}.`);
}
