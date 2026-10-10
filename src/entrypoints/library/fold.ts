import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { estimateBytes } from '@/lib/format';
import { CommandError, send, type FoldOutcome } from '@/lib/messages';
import { UNDO_WINDOW_MS, type ActiveFold } from '@/lib/state';
import { dismissToast, toast } from '@/ui/components/Toast';
import { useActiveFold, useLastAction } from '@/ui/hooks';
import type { WindowInfo } from '@/ui/windows';
import { approxBytes, count } from './format';
import { dropUndo, registerUndo } from './undo';

interface FoldError {
  message: string;
  quota: boolean;
}

/** A fold that failed, for the red line above the list (Min-States "Fold failed"). */
export const useFoldError = create<{ error: FoldError | null; set: (error: FoldError | null) => void }>((set) => ({
  error: null,
  set: (error) => set({ error }),
}));

/** What folding every window would fold now (see `describeWindows` for the rules). */
export function useFoldCandidates(windows: WindowInfo[]): { tabs: number; bytes: number } {
  return useMemo(() => {
    const tabs = windows.flatMap((w) => w.foldable);
    return { tabs: tabs.length, bytes: estimateBytes(tabs.filter((t) => !t.discarded).length) };
  }, [windows]);
}

export function isFolding(fold: ActiveFold | undefined): boolean {
  return (
    !!fold && (fold.phase === 'saving' || fold.phase === 'closing' || fold.phase === 'waiting') && Date.now() - fold.startedAt < 10 * 60_000
  );
}

/** Memory the fold gave back: the computer's real reading when Chrome gave one, else the estimate. */
export function freedBytes(outcome: FoldOutcome): number {
  const { freeBefore, freeAfter } = outcome.memory ?? {};
  if (freeBefore != null && freeAfter != null && freeAfter > freeBefore) return freeAfter - freeBefore;
  return outcome.freedBytes;
}

export function foldMessage(outcome: FoldOutcome): string {
  // Tabs that went into the list (or were already there); blank pages also close but are not counted.
  const folded = outcome.savedTabs + outcome.skippedDuplicates;
  const freed = freedBytes(outcome);
  return `Folded ${count(folded, 'tab')}${freed > 0 ? ` · freed ${approxBytes(freed)}` : ''}`;
}

/** The fold announced last, so the command's answer and the progress broadcast never show two toasts. */
let shownFold: { foldId: string; toastId: number; actionId: string | null } | null = null;

function showFoldToast(foldId: string, outcome: FoldOutcome, finishedAt: number): void {
  if (shownFold?.foldId === foldId) return;
  const left = finishedAt + UNDO_WINDOW_MS - Date.now();
  if (left < 1500 || (outcome.savedTabs === 0 && outcome.closedTabs === 0)) return;
  const message = foldMessage(outcome);
  const actionId = outcome.actionId;
  const key = `fold:${foldId}`;
  let toastId = 0;
  const undo = () => {
    dropUndo(key);
    dismissToast(toastId);
    if (!actionId) return;
    send({ type: 'undo', actionId })
      .then((result) => {
        if (!result.undone && result.reason) toast(result.reason, { tone: 'error' });
      })
      .catch(() => undefined);
  };
  toastId = toast(message, {
    tone: 'success',
    duration: left,
    countdown: true,
    announce: `${message}. Undo available for ${Math.round(left / 1000)} seconds.`,
    ...(actionId ? { action: { label: 'Undo', onClick: undo } } : {}),
  });
  if (actionId) registerUndo(key, undo, finishedAt + UNDO_WINDOW_MS);
  shownFold = { foldId, toastId, actionId };
}

/** Fold every window, or one (`windowId`; `keepWindowOpen` for the window this page is in). */
export async function startFold(options: { windowId?: number; keepWindowOpen?: boolean } = {}): Promise<void> {
  useFoldError.getState().set(null);
  try {
    const outcome = await send({ type: 'fold', ...options });
    if (outcome.savedTabs === 0 && outcome.closedTabs === 0 && outcome.skippedDuplicates === 0) {
      toast('Nothing to fold. Only pinned, playing or new tab pages are open.');
      return;
    }
    showFoldToast(outcome.foldId, outcome, Date.now());
  } catch (error) {
    const quota = error instanceof CommandError && error.code === 'quota';
    useFoldError.getState().set({ message: error instanceof Error ? error.message : 'Something went wrong.', quota });
  }
}

/**
 * The fold's result as a toast at the bottom ("Folded 44 tabs · freed ~2.1 GB · Undo 8s"), for a
 * fold started here, in the popup or with the shortcut. Undo in any of those places clears it here.
 */
export function useFoldToast(): void {
  const fold = useActiveFold();
  const action = useLastAction();

  useEffect(() => {
    if (!fold) return;
    if (fold.phase === 'failed' && fold.finishedAt && Date.now() - fold.finishedAt < 30_000) {
      useFoldError.getState().set({ message: fold.error ?? 'Something went wrong.', quota: /storage|quota|space/i.test(fold.error ?? '') });
      return;
    }
    if (fold.phase === 'done' && fold.outcome) showFoldToast(fold.foldId, fold.outcome, fold.finishedAt ?? fold.startedAt);
  }, [fold]);

  // Undone from the popup or a shortcut: the toast goes away here too.
  useEffect(() => {
    if (!shownFold?.actionId || !action || action.id !== shownFold.actionId || !action.undone) return;
    dismissToast(shownFold.toastId);
    dropUndo(`fold:${shownFold.foldId}`);
  }, [action]);
}
