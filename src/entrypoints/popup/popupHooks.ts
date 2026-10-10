import { useEffect, useMemo, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { extUrl } from '@/lib/extUrl';
import { ESTIMATED_BYTES_PER_LOADED_TAB, estimateBytes } from '@/lib/format';
import { send, type TabRef } from '@/lib/messages';
import type { ActiveFold, LastAction } from '@/lib/state';
import { classifyUrl, displayHost, unwrapViewerUrl } from '@/lib/urls';
import type { TabKind } from '@/ui/components/MemoryCapsule';
import { useActiveFold, useLastAction, useWorkerEvents, type OpenWindow } from '@/ui/hooks';

export function tabUrl(tab: Browser.tabs.Tab): string {
  return unwrapViewerUrl(tab.url || tab.pendingUrl || '');
}

export interface OpenTabStats {
  /** Every open tab in normal windows, in window and tab order. */
  tabs: Browser.tabs.Tab[];
  sleeping: number;
  /** Estimated memory of the loaded tabs. */
  inUseBytes: number;
  /** One per open tab, for the capsule. */
  kinds: TabKind[];
  /** Tabs a fold would save and close (not pinned, not playing sound, not a blank or Tabfold page). */
  foldable: Browser.tabs.Tab[];
  foldableKinds: TabKind[];
  /** Tabs a fold leaves open. */
  stayedKinds: TabKind[];
  /** Estimated memory a folded tab gives back, on average (sleeping tabs give back almost nothing). */
  bytesPerFoldedTab: number;
}

const kindOf = (tab: Browser.tabs.Tab): TabKind => (tab.discarded ? 'sleeping' : 'loaded');

/** The numbers above the capsule and what a fold would do, worked out from the open tabs. */
export function useOpenTabStats(windows: OpenWindow[], keepPinnedOpen: boolean): OpenTabStats {
  const lastShare = useRef(1);
  return useMemo(() => {
    const own = extUrl('/');
    const tabs = windows.flatMap((w) => w.tabs);
    const foldable: Browser.tabs.Tab[] = [];
    const stayedKinds: TabKind[] = [];
    let sleeping = 0;
    for (const tab of tabs) {
      if (tab.discarded) sleeping += 1;
      const kind = classifyUrl(tabUrl(tab), own);
      const folds = kind !== 'own' && kind !== 'blank' && !(tab.pinned && keepPinnedOpen) && !tab.audible;
      if (folds) foldable.push(tab);
      else stayedKinds.push(kindOf(tab));
    }
    const foldableKinds = foldable.map(kindOf);
    if (foldable.length) lastShare.current = foldableKinds.filter((k) => k === 'loaded').length / foldable.length;
    return {
      tabs,
      sleeping,
      inUseBytes: estimateBytes(tabs.length - sleeping),
      kinds: tabs.map(kindOf),
      foldable,
      foldableKinds,
      stayedKinds,
      bytesPerFoldedTab: ESTIMATED_BYTES_PER_LOADED_TAB * lastShare.current,
    };
  }, [windows, keepPinnedOpen]);
}

/** The user's shortcut for folding, as Chrome shows it ("⌘⇧S", "Ctrl+Shift+S"). */
export function useFoldShortcut(): string {
  const [shortcut, setShortcut] = useState('');
  useEffect(() => {
    browser.commands
      .getAll()
      .then((commands) => {
        const command = commands.find((c) => c.name === 'fold') ?? commands.find((c) => c.name === 'save-all');
        setShortcut(command?.shortcut ?? '');
      })
      .catch(() => undefined);
  }, []);
  return shortcut;
}

const FOLD_PHASE_RANK: Record<ActiveFold['phase'], number> = { saving: 0, closing: 1, waiting: 1, done: 2, failed: 2 };
/** A fold that never finished (the worker was stopped) is ignored after this long. */
const STALE_FOLD_MS = 10 * 60_000;
/** A finished fold stays on screen when the popup is reopened shortly after. */
export const FINISHED_FOLD_SHOWN_MS = 60_000;

export type FoldView =
  | { kind: 'rest' }
  | { kind: 'folding'; fold: ActiveFold }
  | { kind: 'done'; fold: ActiveFold; seenRunning: boolean }
  | { kind: 'failed'; fold: ActiveFold };

/**
 * The fold to show: the worker's (from session storage and `fold-progress` events), so a popup
 * reopened mid-fold picks it up, or the one this popup just started until the worker reports it.
 */
export function useFold(foldTotal: number) {
  const stored = useActiveFold();
  const action = useLastAction();
  const [remote, setRemote] = useState<ActiveFold | undefined>();
  const [local, setLocal] = useState<ActiveFold | null>(null);
  const openedAt = useRef(Date.now());
  const seenRunning = useRef(false);

  useEffect(() => setRemote(stored), [stored]);
  useWorkerEvents((event) => {
    if (event.type === 'fold-progress') setRemote(event.fold);
  });

  let fold: ActiveFold | undefined = remote;
  if (local) {
    // The worker hasn't reported this fold yet, or its answer arrived before its last progress update.
    const caughtUp = !!remote && remote.startedAt >= local.startedAt - 1000;
    const answerFirst =
      !!remote && remote.foldId === local.foldId && FOLD_PHASE_RANK[local.phase] > FOLD_PHASE_RANK[remote.phase];
    if (!caughtUp || answerFirst) fold = local;
  }

  const now = Date.now();
  let view: FoldView = { kind: 'rest' };
  if (fold) {
    const running = fold.phase === 'saving' || fold.phase === 'closing' || fold.phase === 'waiting';
    const finishedAt = fold.finishedAt ?? fold.startedAt;
    if (running && now - fold.startedAt < STALE_FOLD_MS) {
      seenRunning.current = true;
      view = { kind: 'folding', fold };
    } else if (!running && finishedAt >= openedAt.current - FINISHED_FOLD_SHOWN_MS && !undone(fold, action)) {
      view =
        fold.phase === 'failed'
          ? { kind: 'failed', fold }
          : { kind: 'done', fold, seenRunning: seenRunning.current };
    }
  }

  const start = async () => {
    const startedAt = Date.now();
    const pending: ActiveFold = { foldId: `local-${startedAt}`, phase: 'saving', total: foldTotal, closed: 0, waiting: [], startedAt };
    setLocal(pending);
    const settle = (patch: Partial<ActiveFold>) =>
      setLocal((current) => (current && current.startedAt === startedAt ? { ...current, ...patch, finishedAt: Date.now() } : current));
    try {
      const outcome = await send({ type: 'fold' });
      settle({ phase: 'done', foldId: outcome.foldId, total: outcome.savedTabs + outcome.skippedDuplicates, closed: outcome.closedTabs, outcome });
    } catch (error) {
      settle({ phase: 'failed', error: error instanceof Error ? error.message : 'Something went wrong. Please try again.' });
    }
  };

  return { view, start };
}

/** The fold was undone: the popup goes back to its resting state. */
function undone(fold: ActiveFold, action: LastAction | undefined): boolean {
  const id = fold.outcome?.actionId;
  return !!id && !!action && action.id === id && action.undone === true;
}

/** "Google Docs" from "Q4 roadmap - Google Docs"; otherwise the site's address. */
export function siteLabel(ref: Pick<TabRef, 'title' | 'url'>): string {
  const parts = ref.title.split(/\s[-–—|·]\s/);
  const last = parts.length > 1 ? parts[parts.length - 1]!.trim() : '';
  if (last && last.length <= 24 && !last.includes('/') && !last.includes('@')) return last;
  return displayHost(ref.url).replace(/^www\./, '') || 'A page';
}

/** Switch to an open tab and its window. */
export async function showTab(tabId: number, windowId?: number): Promise<void> {
  await browser.tabs.update(tabId, { active: true }).catch(() => undefined);
  if (windowId !== undefined) await browser.windows.update(windowId, { focused: true }).catch(() => undefined);
}

/** Age for search results: "just now", "12 min ago", "yesterday", "last week", "2 weeks ago". */
export function longAgo(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return weeks === 1 ? 'last week' : `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (days < 365) return months <= 1 ? 'last month' : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'last year' : `${years} years ago`;
}
