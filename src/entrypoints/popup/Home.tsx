import { useEffect, useMemo, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { AppWindow, Archive, Check, Info, Pause, Tag } from 'lucide-react';
import { estimateBytes, formatBytes, plural } from '@/lib/format';
import {
  CommandError,
  send,
  type PreflightResult,
  type RestoreFailure,
  type SaveOutcome,
  type SaveScope,
  type SuspendOutcome,
  type TabRef,
} from '@/lib/messages';
import { openLibrary } from '@/lib/openLibrary';
import { listRecentSessions } from '@/lib/repo';
import { windowNames } from '@/lib/state';
import type { SessionRecord } from '@/lib/types';
import { extUrl } from '@/lib/extUrl';
import { classifyUrl } from '@/lib/urls';
import { Banner } from '@/ui/components/Banner';
import { Button } from '@/ui/components/Button';
import { cx } from '@/ui/cx';
import { Kbd } from '@/ui/components/Chips';
import { confirmAction } from '@/ui/components/Dialog';
import {
  currentScreen,
  useActiveRestore,
  useCommandShortcut,
  useLastAction,
  useNow,
  useRecoveryOffer,
  useSettings,
  useWorkerEvents,
  type OpenWindow,
} from '@/ui/hooks';
import {
  ErrorBanner,
  IncognitoBanner,
  MemoryBanner,
  RecoveryBanner,
  RefusedCard,
  RestoreFailedCard,
  SavedBanner,
  SuspendedBanner,
} from './banners';
import { IncognitoWindowCard, WindowCard, tabUrl, type RowHandlers } from './parts';
import { clickKey, useFadingWindows } from './popupHooks';
import { RecentSessions, type AlreadyOpenView, type RestoreProgressView } from './sessions';
import { BeforeCloseSheet, DuplicatesSheet, type BeforeCloseAnswer, type DuplicatesAnswer } from './sheets';
import { PopupToasts, type PopupToast } from './toasts';

type Status =
  | { kind: 'none' }
  | { kind: 'saved'; outcome: SaveOutcome; at: number }
  | { kind: 'suspended'; outcome: SuspendOutcome }
  | { kind: 'info'; message: string }
  | { kind: 'error'; title: string; detail?: string; retry?: () => void };

interface SaveRequest {
  scope: SaveScope;
  windowId?: number;
  tabIds?: number[];
  includeIncognito?: boolean;
}

interface Answers {
  duplicates?: 'skip' | 'keep';
  audible: 'keep' | 'close';
}

type SheetState =
  | { kind: 'duplicates'; preflight: PreflightResult; resolve: (answer: DuplicatesAnswer | null) => void }
  | { kind: 'before-close'; preflight: PreflightResult; warnAudio: boolean; resolve: (answer: BeforeCloseAnswer | null) => void };

/** How long a save's green banner stays when there is no Undo to count down. */
const SAVED_BANNER_MS = 10_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function isLoaded(tab: Browser.tabs.Tab): boolean {
  return !tab.discarded && classifyUrl(tabUrl(tab)) === 'web';
}

export function Home({
  windows,
  loaded,
  currentWindowId,
  incognito,
  narrow,
  onAskKeywords,
}: {
  windows: OpenWindow[];
  loaded: boolean;
  currentWindowId: number | undefined;
  /** The popup was opened in an Incognito window. */
  incognito: boolean;
  narrow: boolean;
  onAskKeywords: (tabIds: number[]) => void;
}) {
  const [settings, updateSettings] = useSettings();
  const action = useLastAction();
  const offer = useRecoveryOffer();
  const activeRestore = useActiveRestore();
  const recent = useLiveQuery(() => listRecentSessions(5), []);
  const saveShortcut = useCommandShortcut('save-all');
  const mountedAt = useRef(Date.now());

  const [status, setStatus] = useState<Status>({ kind: 'none' });
  const [busy, setBusy] = useState<null | 'save' | 'suspend' | 'undo' | 'recover'>(null);
  const [refused, setRefused] = useState<TabRef[]>([]);
  const [restoreFailed, setRestoreFailed] = useState<{ opened: number; failed: RestoreFailure[] } | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [openPreflight, setOpenPreflight] = useState<PreflightResult | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [pendingRestore, setPendingRestore] = useState<RestoreProgressView | null>(null);
  const [progress, setProgress] = useState<RestoreProgressView | null>(null);
  const [alreadyOpen, setAlreadyOpen] = useState<AlreadyOpenView | null>(null);
  const [toasts, setToasts] = useState<PopupToast[]>([]);
  const [toastDismissed, setToastDismissed] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /** The save command itself is running (not just its preflight or a sheet). */
  const [writing, setWriting] = useState(false);
  const saveInFlight = useRef(false);

  // ---------------------------------------------------------------------------------------------
  // Windows, tabs and the selection

  const normalWindows = windows.filter((w) => !w.incognito);
  const incognitoWindows = windows.filter((w) => w.incognito);
  const ordered = useMemo(
    () => [...normalWindows].sort((a, b) => Number(b.id === currentWindowId) - Number(a.id === currentWindowId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windows, currentWindowId],
  );
  const listed = useFadingWindows(ordered);
  const allTabs = windows.flatMap((w) => w.tabs);
  const tabById = useMemo(
    () => new Map(windows.flatMap((w) => w.tabs).filter((t) => t.id !== undefined).map((t) => [t.id!, t])),
    [windows],
  );
  const loadedBytes = estimateBytes(allTabs.filter(isLoaded).length);

  // Chrome's own multi-selection (highlighted tabs) starts the popup's selection.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !loaded || currentWindowId === undefined) return;
    seeded.current = true;
    const current = windows.find((w) => w.id === currentWindowId && !w.incognito);
    const highlighted = (current?.tabs ?? []).filter((t) => t.highlighted && t.id !== undefined).map((t) => t.id!);
    if (highlighted.length > 1) setSelection(new Set(highlighted));
  }, [loaded, currentWindowId, windows]);

  // Tabs closed in Chrome (or whose window closed) drop out of the selection.
  useEffect(() => {
    setSelection((prev) => {
      const next = new Set([...prev].filter((id) => tabById.has(id) && !tabById.get(id)!.incognito));
      return next.size === prev.size ? prev : next;
    });
  }, [tabById]);

  const selectedIds = [...selection];
  const selecting = selectedIds.length > 0;

  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || sheet) return;
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && target.value) return;
      e.preventDefault();
      setSelection(new Set());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting, sheet]);

  const select = (tab: Browser.tabs.Tab, mode: 'toggle' | 'range') => {
    if (tab.id === undefined || tab.incognito) return;
    const id = tab.id;
    setSelection((prev) => {
      const next = new Set(prev);
      const from = anchor.current;
      const window = windows.find((w) => w.tabs.some((t) => t.id === id));
      const fromIndex = from === null ? -1 : (window?.tabs.findIndex((t) => t.id === from) ?? -1);
      if (mode === 'range' && window && fromIndex >= 0) {
        const toIndex = window.tabs.findIndex((t) => t.id === id);
        const [lo, hi] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
        for (const t of window.tabs.slice(lo, hi + 1)) if (t.id !== undefined) next.add(t.id);
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    anchor.current = id;
  };

  // ---------------------------------------------------------------------------------------------
  // "Nothing to save": checked once the popup has painted, never before.

  const tabKey = allTabs.map((t) => `${t.id}:${t.pinned ? 1 : 0}:${tabUrl(t)}`).join('|');
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    const timer = setTimeout(() => {
      send({ type: 'preflight-save', scope: 'all', windowId: incognito ? undefined : currentWindowId })
        .then((result) => alive && setOpenPreflight(result))
        .catch(() => undefined);
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [loaded, tabKey, currentWindowId, incognito]);

  // ---------------------------------------------------------------------------------------------
  // Undo: the banner after a save made here, a toast when the popup reopens within 10 seconds.

  const undoLive = !!action && !action.undone && action.expiresAt > Date.now();
  const savedHere = status.kind === 'saved' ? status : null;
  const savedRecent = !!savedHere && Date.now() - savedHere.at < SAVED_BANNER_MS;
  const now = useNow(undoLive || savedRecent);
  const secondsLeft = action ? Math.max(0, Math.ceil((action.expiresAt - now) / 1000)) : 0;
  const undoForSaved = !!savedHere && undoLive && action?.id === savedHere.outcome.actionId && secondsLeft > 0;
  const showSavedBanner = !!savedHere && (undoForSaved || (!savedHere.outcome.actionId && now - savedHere.at < SAVED_BANNER_MS));
  const reopenToast =
    undoLive && action && action.at < mountedAt.current && secondsLeft > 0 && toastDismissed !== action.id ? action : null;
  // A save where every tab was already saved points at the existing session: nothing is "just saved".
  const justSavedId =
    (showSavedBanner && savedHere && savedHere.outcome.savedTabs > 0 ? savedHere.outcome.sessionId : null) ||
    (reopenToast && reopenToast.savedTabs > 0 ? reopenToast.sessionId : null);

  useEffect(() => {
    if (status.kind === 'saved' && !showSavedBanner && now - status.at > 1000) setStatus({ kind: 'none' });
  }, [status, showSavedBanner, now]);

  const undo = async (actionId: string) => {
    setBusy('undo');
    try {
      const result = await send({ type: 'undo', actionId });
      if (result.undone) {
        setStatus({ kind: 'none' });
        setRefused([]);
        setToasts([]);
        setAnnouncement('Undone. Your tabs are open again.');
      } else {
        setStatus({ kind: 'error', title: result.reason ?? 'Undo is no longer available.' });
      }
    } catch (error) {
      setStatus({ kind: 'error', title: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  // ---------------------------------------------------------------------------------------------
  // Saving: preflight, the duplicates and "before closing" sheets, then the save itself.

  const askDuplicates = (preflight: PreflightResult) =>
    new Promise<DuplicatesAnswer | null>((resolve) => setSheet({ kind: 'duplicates', preflight, resolve }));
  const askBeforeClose = (preflight: PreflightResult, warnAudio: boolean) =>
    new Promise<BeforeCloseAnswer | null>((resolve) => setSheet({ kind: 'before-close', preflight, warnAudio, resolve }));

  const pushToast = (toast: Omit<PopupToast, 'id'>) =>
    setToasts((list) => [...list.slice(-1), { ...toast, id: Date.now() + Math.random() }]);

  const report = (outcome: SaveOutcome) => {
    setStatus({ kind: 'saved', outcome, at: Date.now() });
    setRefused(outcome.failedToClose);
    setRestoreFailed(null);
    const saved =
      outcome.savedTabs === 0 && outcome.skippedDuplicates > 0
        ? `${plural(outcome.skippedDuplicates, 'tab')} already saved; ${outcome.skippedDuplicates === 1 ? 'it stays' : 'they stay'} saved where ${outcome.skippedDuplicates === 1 ? 'it is' : 'they are'}.`
        : `Saved ${plural(outcome.savedTabs, 'tab')}.`;
    if (outcome.truncatedTabs > 0) {
      const n = outcome.truncatedTabs;
      pushToast({
        message: `${saved} ${n} ${n === 1 ? 'was' : 'were'} saved in part.`,
        action: outcome.sessionId
          ? {
              label: 'Show',
              onClick: () => {
                openLibrary(`#/session/${outcome.sessionId}`);
                window.close();
              },
            }
          : undefined,
      });
    }
    if (outcome.newTabsLeftOpen > 0) {
      const n = outcome.newTabsLeftOpen;
      pushToast({
        message: `${saved} ${n} new ${n === 1 ? 'tab was' : 'tabs were'} left open.`,
        action: outcome.actionId ? { label: 'Undo', onClick: () => undo(outcome.actionId!) } : undefined,
      });
    }
    setAnnouncement(outcome.actionId ? `${saved} Undo available for 10 seconds.` : saved);
  };

  const runSave = async (request: SaveRequest, answers?: Answers): Promise<void> => {
    // One save at a time from this popup (double clicks, a click while a sheet is closing).
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setBusy('save');
    setStatus((s) => (s.kind === 'error' ? { kind: 'none' } : s));
    let preflight: PreflightResult | null = null;
    let chosen: Answers | undefined = answers;
    try {
      if (!chosen) {
        preflight = await send({ type: 'preflight-save', ...request });
        if (preflight.nothingToSave) {
          setOpenPreflight((p) => (request.scope === 'all' ? preflight : p));
          setStatus({ kind: 'info', message: 'Nothing to save. Pinned tabs stay open and new tab pages are skipped.' });
          return;
        }
        let duplicates: 'skip' | 'keep' | undefined;
        if (settings.duplicates === 'ask' && preflight.duplicates.length > 0) {
          const answer = await askDuplicates(preflight);
          setSheet(null);
          if (!answer) return;
          duplicates = answer.choice;
          if (answer.remember) updateSettings({ duplicates: answer.choice });
        }
        let audible: 'keep' | 'close' = 'close';
        if (request.scope !== 'tabs') {
          const audioCount = preflight.audibleTabs.length || preflight.audible;
          const warnAudio = settings.warnAudioBeforeClose && audioCount > 0;
          if (warnAudio || preflight.longUrls.length > 0) {
            const answer = await askBeforeClose(preflight, warnAudio);
            setSheet(null);
            if (!answer) return;
            audible = answer.audible;
            if (answer.stopAudioWarning) updateSettings({ warnAudioBeforeClose: false });
          }
        }
        chosen = { duplicates, audible };
      }
      setWriting(true);
      const outcome = await send({ type: 'save', ...request, close: true, audible: chosen.audible, duplicates: chosen.duplicates });
      if (request.scope === 'tabs') setSelection(new Set());
      report(outcome);
    } catch (error) {
      const retryWith = chosen;
      const count = preflight?.tabs ?? request.tabIds?.length;
      if (error instanceof CommandError && error.code === 'quota') {
        setStatus({ kind: 'error', title: 'Browser storage is full', detail: 'Nothing was closed. Free up disk space, then try again.' });
      } else {
        setStatus({
          kind: 'error',
          title: "Couldn't save. Nothing was closed.",
          detail: count
            ? `Your ${plural(count, 'tab')} ${count === 1 ? 'is' : 'are'} still open.`
            : 'Your tabs are still open.',
          retry: () => runSave(request, retryWith),
        });
      }
    } finally {
      saveInFlight.current = false;
      setSheet(null);
      setWriting(false);
      setBusy(null);
    }
  };

  const saveTabs = (tabIds: number[]) => {
    if (tabIds.length === 1 && settings.askKeywordsOnSingleSave) {
      onAskKeywords(tabIds);
      return;
    }
    runSave({ scope: 'tabs', tabIds, windowId: currentWindowId });
  };

  const saveIncognito = async (window: OpenWindow) => {
    const count = window.tabs.length;
    const ok = await confirmAction({
      title: 'Save this Incognito window?',
      body: `Its ${plural(count, 'tab')} go into a new session in your library and the window closes. Tabfold never saves Incognito tabs without asking.`,
      confirmLabel: `Save & close ${plural(count, 'tab')}`,
    });
    if (ok) runSave({ scope: 'window', windowId: window.id, includeIncognito: true });
  };

  // ---------------------------------------------------------------------------------------------
  // Suspending

  const suspendAll = async () => {
    setBusy('suspend');
    try {
      const outcome = await send({ type: 'suspend-inactive' });
      setStatus({ kind: 'suspended', outcome });
      setAnnouncement(
        outcome.suspended ? `Suspended ${plural(outcome.suspended, 'tab')}, freed about ${formatBytes(outcome.freedBytes)}.` : 'No inactive tabs to suspend.',
      );
    } catch (error) {
      setStatus({ kind: 'error', title: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  // ---------------------------------------------------------------------------------------------
  // Restoring: progress from the worker's events and from storage (so a reopened popup shows it).

  useWorkerEvents((event) => {
    if (event.type === 'restore-progress') {
      setProgress({
        sessionId: event.sessionId,
        name: activeRestore?.name ?? pendingRestore?.name ?? '',
        restoreId: event.restoreId,
        done: event.done,
        total: event.total,
        windowCount: event.windowCount,
      });
    } else if (event.type === 'restore-done') {
      setProgress(null);
    }
  });

  const fromStorage: RestoreProgressView | null = activeRestore
    ? {
        sessionId: activeRestore.sessionId,
        name: activeRestore.name,
        restoreId: activeRestore.restoreId,
        done: activeRestore.done,
        total: activeRestore.total,
        windowCount: activeRestore.windowCount,
      }
    : null;
  const live = progress && (!fromStorage || progress.restoreId === fromStorage.restoreId) ? progress : fromStorage;
  const restoring: RestoreProgressView | null =
    live || pendingRestore
      ? {
          sessionId: live?.sessionId ?? pendingRestore?.sessionId ?? null,
          name: live?.name || pendingRestore?.name || '',
          restoreId: live?.restoreId ?? pendingRestore?.restoreId,
          done: live?.done ?? 0,
          total: live?.total || pendingRestore?.total || 0,
          windowCount: live?.windowCount || pendingRestore?.windowCount || 1,
        }
      : null;

  const restore = async (session: SessionRecord, force = false) => {
    setAlreadyOpen(null);
    setRestoreFailed(null);
    setPendingRestore({
      sessionId: session.id,
      name: session.name,
      done: 0,
      total: session.tabCount,
      windowCount: session.windowCount,
    });
    try {
      const outcome = await send({
        type: 'restore',
        sessionId: session.id,
        mode: 'original',
        currentWindowId,
        screen: currentScreen(),
        force,
        background: true,
      });
      const openIds = outcome.alreadyOpen?.windowIds ?? (outcome.alreadyOpenWindowId !== undefined ? [outcome.alreadyOpenWindowId] : []);
      if (openIds.length > 0) {
        setAlreadyOpen({
          sessionId: session.id,
          name: session.name,
          windowIds: openIds,
          openTabs: outcome.alreadyOpen?.openTabs ?? session.tabCount,
          totalTabs: outcome.alreadyOpen?.totalTabs ?? session.tabCount,
        });
      } else if (outcome.failed.length > 0) {
        setRestoreFailed({ opened: outcome.opened, failed: outcome.failed });
      }
    } catch (error) {
      setStatus({ kind: 'error', title: messageOf(error) });
    } finally {
      setPendingRestore(null);
      setProgress(null);
    }
  };

  const cancelRestore = () => {
    if (restoring?.restoreId) send({ type: 'cancel-restore', restoreId: restoring.restoreId }).catch(() => undefined);
  };

  const restoreRecovery = async () => {
    if (!offer) return;
    setBusy('recover');
    try {
      const outcome = await send({
        type: 'restore-snapshot',
        snapshotId: offer.snapshotId,
        mode: 'original',
        currentWindowId,
        screen: currentScreen(),
      });
      if (outcome.failed.length) setRestoreFailed({ opened: outcome.opened, failed: outcome.failed });
    } catch (error) {
      setStatus({ kind: 'error', title: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  // ---------------------------------------------------------------------------------------------
  // Rows

  const rowHandlers = (tab: Browser.tabs.Tab): RowHandlers => ({
    onActivate: () => {
      if (tab.id === undefined) return;
      browser.tabs.update(tab.id, { active: true }).catch(() => undefined);
      if (tab.windowId !== undefined) browser.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
      window.close();
    },
    onSelect: tab.incognito ? undefined : (mode) => select(tab, mode),
    onSuspend: tab.incognito
      ? undefined
      : () => {
          if (tab.id !== undefined) send({ type: 'suspend-tab', tabId: tab.id }).catch(() => undefined);
        },
    onSave: tab.incognito
      ? undefined
      : () => {
          if (tab.id !== undefined) saveTabs([tab.id]);
        },
    onClose: () => {
      if (tab.id !== undefined) browser.tabs.remove(tab.id).catch(() => undefined);
    },
  });

  // ---------------------------------------------------------------------------------------------
  // Render

  const nothingToSave = !!openPreflight?.nothingToSave && !showSavedBanner;
  // While a sheet asks a question the popup behind it keeps its look; only the write itself disables.
  const saving = writing;
  const saveDisabled = saving || nothingToSave;
  const ownPrefix = extUrl('/');
  /** Would "Save this window" save anything (pinned kept open, new tab pages skipped)? */
  const hasSavable = (w: OpenWindow) =>
    w.tabs.some((t) => {
      const url = tabUrl(t);
      if (url.startsWith(ownPrefix)) return false;
      if (settings.skipBlankPages && classifyUrl(url) === 'blank') return false;
      return !(t.pinned && settings.keepPinnedOpen);
    });
  const shortcutHint = saveShortcut ? (
    // "Ctrl+Shift+S" would run into the label when the popup is narrow; "⌘⇧S" fits.
    <span aria-hidden className={cx('absolute right-3 text-meta font-normal', saveShortcut.length > 4 && 'max-[360px]:hidden')}>
      {saveShortcut}
    </span>
  ) : undefined;
  const selectedTabs = selectedIds.map((id) => tabById.get(id)).filter((t): t is Browser.tabs.Tab => !!t);

  const mainSlot = (() => {
    if (status.kind === 'error') return <ErrorBanner title={status.title} detail={status.detail} onRetry={status.retry} />;
    if (status.kind === 'info') {
      return (
        <Banner tone="neutral" role="status" className="shrink-0">
          {status.message}
        </Banner>
      );
    }
    if (showSavedBanner && savedHere) {
      const o = savedHere.outcome;
      const freed = `~${formatBytes(o.freedBytes || estimateBytes(o.closedTabs))}`;
      const allDuplicates = o.savedTabs === 0 && o.skippedDuplicates > 0;
      const one = o.skippedDuplicates === 1;
      const [lead, detail] = allDuplicates
        ? [
            one ? 'Already saved' : `${o.skippedDuplicates} tabs were already saved`,
            one ? 'it stays saved where it is' : 'they stay saved where they are',
          ]
        : o.closedTabs === 0
          ? [`Saved ${plural(o.savedTabs, 'tab')}`, `in ${o.sessionName}`]
          : o.failedToClose.length > 0
            ? [`Saved ${plural(o.savedTabs, 'tab')}`, `freed ${freed}`]
            : [`Freed ${freed}`, `${plural(o.savedTabs, 'tab')} saved`];
      return (
        <SavedBanner
          lead={lead}
          detail={detail}
          note={o.intoUnsorted ? 'Into Unsorted: Free holds 50 named sessions.' : undefined}
          secondsLeft={undoForSaved ? secondsLeft : null}
          undoing={busy === 'undo'}
          onUndo={() => o.actionId && undo(o.actionId)}
        />
      );
    }
    if (selecting) {
      const freed = estimateBytes(selectedTabs.filter(isLoaded).length);
      return (
        <MemoryBanner
          lead={`~${formatBytes(freed)}`}
          detail={`freed by saving ${selectedIds.length === 1 ? 'this tab' : `these ${selectedIds.length} tabs`}`}
          aside={`${allTabs.length} open`}
        />
      );
    }
    if (status.kind === 'suspended') return <SuspendedBanner outcome={status.outcome} />;
    return (
      <MemoryBanner
        lead={`${plural(allTabs.length, 'tab')} open`}
        detail={`· ~${formatBytes(loadedBytes)} in use`}
        aside={plural(windows.length, 'window')}
      />
    );
  })();

  const hint = (() => {
    if (incognito || nothingToSave) return null;
    if (showSavedBanner && savedHere && savedHere.outcome.keptOpen.pinned > 0) return 'Pinned tabs kept open';
    if (selecting) return `${clickKey}-click to add tabs · Shift-click for a range`;
    return `${clickKey}-click tabs to select`;
  })();

  const numbered = new Map(normalWindows.map((w, i) => [w.id, i + 1]));
  const tagFor = (windowId: number) => (alreadyOpen?.windowIds.includes(windowId) ? alreadyOpen.name : undefined);

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 px-3">
        {offer && (
          <RecoveryBanner
            offer={offer}
            busy={busy === 'recover'}
            onRestore={restoreRecovery}
            onReview={() => {
              openLibrary('#/snapshots');
              window.close();
            }}
            onDismiss={() => send({ type: 'dismiss-recovery' }).catch(() => undefined)}
          />
        )}
        {incognito && <IncognitoBanner />}
        {mainSlot}
        {refused.length > 0 && <RefusedCard tabs={refused} onDismiss={() => setRefused([])} />}
        {restoreFailed && (
          <RestoreFailedCard opened={restoreFailed.opened} failed={restoreFailed.failed} onDismiss={() => setRestoreFailed(null)} />
        )}
      </div>

      <div className="shrink-0 px-3 pt-2.5 pb-3 max-[360px]:py-2">
        {selecting ? (
          <div
            role="toolbar"
            aria-label={`${plural(selectedIds.length, 'tab')} selected`}
            className="flex flex-col gap-2 rounded-card border border-accent-line bg-accent-soft p-2"
          >
            <div className="flex h-6 items-center gap-2 pl-1">
              <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center rounded bg-accent text-on-accent">
                <Check size={12} strokeWidth={3} />
              </span>
              <span role="status" className="min-w-0 flex-1 truncate font-semibold text-accent-text">
                {plural(selectedIds.length, 'tab')} selected
              </span>
              <button
                type="button"
                onClick={() => setSelection(new Set())}
                className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-small text-text-2 hover:bg-hover"
              >
                Clear <Kbd>Esc</Kbd>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                className="h-9 min-w-0 px-2"
                icon={<Archive size={16} aria-hidden className="shrink-0" />}
                disabled={saving}
                onClick={() => runSave({ scope: 'tabs', tabIds: selectedIds, windowId: currentWindowId })}
              >
                {writing ? 'Saving…' : `Save ${plural(selectedIds.length, 'tab')}`}
              </Button>
              <Button
                className="h-9 min-w-0 gap-1.5 px-2"
                icon={<Tag size={16} aria-hidden className="shrink-0 text-text-2" />}
                disabled={saving}
                onClick={() => onAskKeywords(selectedIds)}
              >
                <span className="max-[360px]:hidden">Save with keywords…</span>
                <span className="hidden max-[360px]:inline">Keywords…</span>
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              size="lg"
              className="relative w-full"
              icon={<Archive size={16} aria-hidden className="shrink-0" />}
              disabled={saveDisabled}
              aria-describedby={nothingToSave ? 'nothing-why' : undefined}
              onClick={() => runSave({ scope: 'all', windowId: incognito ? undefined : currentWindowId })}
              trailing={shortcutHint}
            >
              {writing ? 'Saving…' : incognito ? 'Save all normal windows' : 'Save all & free memory'}
            </Button>
            {nothingToSave && (
              <p id="nothing-why" className="flex items-start gap-2 px-1 text-small text-text-2">
                <Info size={14} aria-hidden className="mt-0.5 shrink-0 text-text-3" />
                <span>
                  Nothing to save. Pinned tabs stay open and new tab pages are skipped.{' '}
                  <button
                    type="button"
                    className="font-semibold whitespace-nowrap text-accent-text hover:underline"
                    onClick={() => {
                      openLibrary('#/settings/general');
                      window.close();
                    }}
                  >
                    Change in Settings
                  </button>
                </span>
              </p>
            )}
            {!incognito && (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  className="h-[34px] min-w-0 gap-1.5 px-2 max-[360px]:h-8"
                  icon={<AppWindow size={16} aria-hidden className="shrink-0 text-text-2" />}
                  disabled={saveDisabled || currentWindowId === undefined}
                  onClick={() => runSave({ scope: 'window', windowId: currentWindowId })}
                >
                  <span className="max-[360px]:hidden">Save this window</span>
                  <span className="hidden max-[360px]:inline">Save window</span>
                </Button>
                <Button
                  className="h-[34px] min-w-0 gap-1.5 px-2 max-[360px]:h-8"
                  icon={<Pause size={16} aria-hidden className="shrink-0 text-text-2" />}
                  disabled={busy === 'suspend' || nothingToSave}
                  onClick={suspendAll}
                >
                  <span className="max-[360px]:hidden">Suspend inactive</span>
                  <span className="hidden max-[360px]:inline">Suspend</span>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* With a toast showing, the list can scroll its last card clear of it. */}
      <div
        className={cx(
          'scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-border px-3',
          toasts.length > 0 || reopenToast ? 'pb-[72px]' : 'pb-3',
        )}
      >
        <div className="flex h-[38px] items-center justify-between gap-3 max-[360px]:h-[30px]">
          <h2 className="label-caps shrink-0">Open now</h2>
          {hint && <span className="min-w-0 truncate text-meta text-text-3 max-[360px]:hidden">{hint}</span>}
        </div>
        {!loaded ? (
          <div className="flex flex-col gap-3 rounded-card border border-border p-3" aria-busy="true">
            {[70, 82, 58].map((w) => (
              <div key={w} className="flex items-center gap-2.5">
                <span className="size-4 rounded bg-skeleton" />
                <span className="h-2.5 rounded bg-skeleton" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {incognitoWindows.map((w) => (
              <IncognitoWindowCard
                key={w.id}
                window={w}
                expanded={expanded[w.id] ?? false}
                onToggle={() => setExpanded((e) => ({ ...e, [w.id]: !(e[w.id] ?? false) }))}
                rowHandlers={rowHandlers}
                onSave={() => saveIncognito(w)}
                saveDisabled={saving}
                skipBlank={settings.skipBlankPages}
              />
            ))}
            {listed.map((w, index) => {
              const label = w.name || `Window ${numbered.get(w.id) ?? index + 1}`;
              const isCurrent = !incognito && w.id === currentWindowId;
              const defaultOpen = !incognito && (isCurrent || (index === 0 && currentWindowId === undefined));
              return (
                <WindowCard
                  key={w.id}
                  window={w}
                  label={label}
                  isCurrent={isCurrent}
                  expanded={expanded[w.id] ?? defaultOpen}
                  onToggle={() => setExpanded((e) => ({ ...e, [w.id]: !(e[w.id] ?? defaultOpen) }))}
                  onRename={(name) => windowNames.set(w.id, name)}
                  selection={selection}
                  rowHandlers={rowHandlers}
                  onSaveWindow={hasSavable(w) ? () => runSave({ scope: 'window', windowId: w.id }) : undefined}
                  saveDisabled={saving}
                  skipBlank={settings.skipBlankPages}
                  narrow={narrow}
                  sessionTag={tagFor(w.id)}
                  suspendedNote={status.kind === 'suspended'}
                  closing={w.closing}
                />
              );
            })}
          </div>
        )}

        <RecentSessions
          sessions={recent}
          narrow={narrow}
          incognito={incognito}
          justSavedId={justSavedId}
          restoring={restoring}
          alreadyOpen={alreadyOpen}
          lazyRestore={settings.lazyRestore}
          restoreDisabled={false}
          onRestore={(session) => restore(session)}
          onCancelRestore={cancelRestore}
          onSwitch={() => {
            const target = alreadyOpen?.windowIds[0];
            if (target === undefined) return;
            browser.windows.update(target, { focused: true }).catch(() => undefined);
            window.close();
          }}
          onOpenCopy={() => {
            const session = recent?.find((s) => s.id === alreadyOpen?.sessionId);
            if (session) restore(session, true);
          }}
          onDismissAlreadyOpen={() => setAlreadyOpen(null)}
        />
      </div>

      <PopupToasts
        toasts={toasts}
        onDismiss={(id) => setToasts((list) => list.filter((t) => t.id !== id))}
        undo={
          reopenToast
            ? {
                message:
                  reopenToast.savedTabs === 0 && reopenToast.reopenOnly?.length
                    ? `${plural(reopenToast.reopenOnly.length, 'tab')} already saved`
                    : `Saved ${plural(reopenToast.savedTabs, 'tab')}`,
                secondsLeft,
                busy: busy === 'undo',
                onUndo: () => undo(reopenToast.id),
                onDismiss: () => setToastDismissed(reopenToast.id),
              }
            : null
        }
      />

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {sheet?.kind === 'duplicates' && <DuplicatesSheet preflight={sheet.preflight} onAnswer={sheet.resolve} />}
      {sheet?.kind === 'before-close' && (
        <BeforeCloseSheet preflight={sheet.preflight} warnAudio={sheet.warnAudio} onAnswer={sheet.resolve} />
      )}
    </>
  );
}

