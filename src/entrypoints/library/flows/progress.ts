import { useActiveRestore } from '@/ui/hooks';
import { useFlows } from './store';

export interface RestoreProgressInfo {
  restoreId: string;
  sessionId: string | null;
  name: string;
  done: number;
  total: number;
  /** 0-based window being opened, out of windowCount (when the worker says). */
  windowIndex?: number;
  windowCount?: number;
  /** Set when this page restored a single window of the session. */
  windowRecordId?: string;
}

/**
 * The restore in progress anywhere (popup, library, shortcut): the worker's `activeRestore` in
 * session storage, kept fresh by its restore-progress events.
 */
export function useRestoreProgress(): RestoreProgressInfo | undefined {
  const active = useActiveRestore();
  const live = useFlows((s) => s.live);
  const pending = useFlows((s) => s.pending);
  const handled = useFlows((s) => s.handled);

  let info: RestoreProgressInfo | undefined;
  // A finished restore whose worker state is already gone (no restore-done heard) shows nothing.
  const liveFinished = !!live && !active && live.done >= live.total;
  if (live && !liveFinished && (!active || active.restoreId === live.restoreId)) {
    const sessionId = live.sessionId ?? active?.sessionId ?? pending?.sessionId ?? null;
    info = {
      restoreId: live.restoreId,
      sessionId,
      name: active?.name ?? (pending && pending.sessionId === sessionId ? pending.sessionName : ''),
      done: Math.max(live.done, active?.done ?? 0),
      total: live.total || active?.total || 0,
      windowIndex: live.windowIndex ?? active?.windowIndex,
      windowCount: live.windowCount ?? active?.windowCount,
    };
  } else if (active) {
    info = { ...active };
  }
  if (!info || handled.has(info.restoreId) || info.total <= 0) return undefined;
  if (pending && pending.sessionId === info.sessionId) info.windowRecordId = pending.windowRecordId;
  return info;
}

export type WindowRestoreStatus =
  | { kind: 'opened' }
  | { kind: 'opening'; opened: number; total: number }
  | { kind: 'next' }
  | null;

/**
 * Per saved window: "Opened", "Opening 3 of 6" or "Up next", from how many tabs are done. Windows
 * open in saved order, so the count of finished tabs says which window is being opened.
 */
export function windowStatuses(
  windows: Array<{ id: string; tabCount: number }>,
  progress: RestoreProgressInfo | undefined,
): Map<string, WindowRestoreStatus> {
  const out = new Map<string, WindowRestoreStatus>();
  if (!progress) return out;
  const involved = progress.windowRecordId ? windows.filter((w) => w.id === progress.windowRecordId) : windows;
  const useIndex =
    progress.windowIndex !== undefined && progress.windowCount === involved.length && involved.length > 0;
  let start = 0;
  involved.forEach((window, index) => {
    const end = start + window.tabCount;
    let status: WindowRestoreStatus;
    if (useIndex) {
      const current = progress.windowIndex!;
      if (index < current) status = { kind: 'opened' };
      else if (index > current) status = { kind: 'next' };
      else {
        const opened = Math.min(window.tabCount, Math.max(0, progress.done - start));
        status = opened >= window.tabCount && progress.done >= end ? { kind: 'opened' } : { kind: 'opening', opened, total: window.tabCount };
      }
    } else if (progress.done >= end) {
      status = { kind: 'opened' };
    } else if (progress.done >= start) {
      status = { kind: 'opening', opened: progress.done - start, total: window.tabCount };
    } else {
      status = { kind: 'next' };
    }
    out.set(window.id, status);
    start = end;
  });
  return out;
}
