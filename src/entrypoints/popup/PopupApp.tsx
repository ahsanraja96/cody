import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { Search, Settings as SettingsIcon, X } from 'lucide-react';
import { send } from '@/lib/messages';
import { openLibrary } from '@/lib/openLibrary';
import { extUrl } from '@/lib/extUrl';
import { hasPro } from '@/lib/pro/tiers';
import { pendingFoldAsk, pendingKeywordSave } from '@/lib/state';
import type { TabRecord } from '@/lib/types';
import { FoldedList, useRemoveWithUndo, type OpenableGroup } from '@/ui/components/FoldedList';
import { Logo } from '@/ui/components/Logo';
import { UpgradeButton } from '@/ui/components/ProBits';
import { PLANS_HASH } from '@/ui/pro';
import { cx } from '@/ui/cx';
import { describeWindows, foldChoice, type WindowInfo } from '@/ui/windows';
import {
  hasFreeLimits,
  useAutoFoldNotice,
  useCloudSyncStatus,
  useFoldedCount,
  useFoldedTabs,
  useFolders,
  useFoldWindows,
  useListRoom,
  useLiveFolders,
  useLoadedPlan,
  useRecoveryOffer,
  useSettings,
  useSiteKinds,
  useSnoozeBack,
  useSyncStatus,
  useTabSearch,
  useUpdateReady,
  type OpenWindow,
} from '@/ui/hooks';
import { FirstRun } from './FirstRun';
import { Hero } from './Hero';
import { KeywordFold } from './KeywordFold';
import { AutoFoldLine, SearchActions, SnoozeBackLine, WorkingIn } from './Lines';
import { MilestoneCard, useFoldMilestone } from './Milestone';
import { OpenWindows } from './OpenWindows';
import { CrashLine, OpenProblem, PopupFooter, SectionLabel } from './parts';
import { useFold, useFoldShortcut, useOpenTabStats } from './popupHooks';
import { openDocs, RESULTS_ID, SearchResults, type SearchNav } from './SearchResults';
import { UpdateDialog } from './UpdateDialog';

type View = { kind: 'loading' } | { kind: 'home' } | { kind: 'keywords'; tabIds: number[] };

/** A keyword request from the right-click menu is only picked up shortly after it was made. */
const PENDING_MAX_AGE_MS = 60_000;
/** Search results listed in the popup (the footer counts them all). */
const SEARCH_LIMIT = 50;

export function PopupApp() {
  const asWindow = document.documentElement.dataset.mode === 'window';
  // The toolbar popup paints its home right away; a keyword request (right-click) swaps it in. The
  // small window is only ever opened for keywords, so it waits for the request instead.
  const [view, setView] = useState<View>({ kind: asWindow ? 'loading' : 'home' });
  const [currentWindowId, setCurrentWindowId] = useState<number>();
  // With "Fold Incognito windows too" on (and allowed), Incognito tabs count as tabs to fold.
  const { windows, allWindows, loaded, foldsIncognito } = useFoldWindows();
  // Opened by the fold shortcut with several windows open: start at "Fold which windows?".
  const [askOnOpen, setAskOnOpen] = useState(false);
  const update = useUpdateReady();

  useEffect(() => {
    const lookup = asWindow ? browser.windows.getLastFocused({ windowTypes: ['normal'] }) : browser.windows.getCurrent();
    lookup.then((w) => setCurrentWindowId(w.id)).catch(() => undefined);
    pendingFoldAsk
      .get()
      .then((pending) => {
        if (!pending) return;
        if (Date.now() - pending.at < PENDING_MAX_AGE_MS) setAskOnOpen(true);
        void pendingFoldAsk.set(null);
      })
      .catch(() => undefined);
    pendingKeywordSave
      .get()
      .then((pending) => {
        const fresh = pending && Date.now() - pending.at < PENDING_MAX_AGE_MS && pending.tabIds.length > 0;
        if (fresh) setView({ kind: 'keywords', tabIds: pending.tabIds });
        else setView((v) => (v.kind === 'loading' ? { kind: 'home' } : v));
        if (pending) void pendingKeywordSave.set(null);
      })
      .catch(() => setView((v) => (v.kind === 'loading' ? { kind: 'home' } : v)));
  }, [asWindow]);

  const overlay = update && <UpdateDialog version={update.version} />;
  if (view.kind === 'loading') return <div className="h-full bg-bg" />;
  if (view.kind === 'keywords') {
    return (
      <>
        <KeywordFold
          tabIds={view.tabIds}
          windows={windows}
          loaded={loaded}
          onCancel={() => (asWindow ? window.close() : setView({ kind: 'home' }))}
        />
        {overlay}
      </>
    );
  }
  return (
    <>
      <Home
        windows={windows}
        allWindows={allWindows}
        foldsIncognito={foldsIncognito}
        loaded={loaded}
        currentWindowId={currentWindowId}
        askOnOpen={askOnOpen}
      />
      {overlay}
    </>
  );
}

function Home({
  windows,
  allWindows,
  foldsIncognito,
  loaded,
  currentWindowId,
  askOnOpen,
}: {
  /** Windows a fold covers. */
  windows: OpenWindow[];
  /** Every window Chrome shows Tabfold (for "Open windows"). */
  allWindows: OpenWindow[];
  foldsIncognito: boolean;
  loaded: boolean;
  currentWindowId?: number;
  askOnOpen: boolean;
}) {
  const [settings, , settingsLoaded] = useSettings();
  const stats = useOpenTabStats(windows, settings.keepPinnedOpen);
  const ready = loaded && settingsLoaded;
  const { view, start } = useFold();
  const infos = useMemo(
    () => describeWindows(allWindows, { currentWindowId, keepPinnedOpen: settings.keepPinnedOpen, foldsIncognito, ownOrigin: extUrl('/') }),
    [allWindows, currentWindowId, settings.keepPinnedOpen, foldsIncognito],
  );
  const choice = foldChoice(infos);
  const [asking, setAsking] = useState(false);
  const [highlight, setHighlight] = useState<'this' | 'all'>('this');
  useEffect(() => {
    if (askOnOpen && ready) setAsking(true);
  }, [askOnOpen, ready]);
  const folding = view.kind === 'folding';
  const foldAll = () => {
    setAsking(false);
    void start({}, stats.foldable.length);
  };
  const foldWindow = (info: WindowInfo) => {
    setAsking(false);
    // The window you're in stays open with a new tab; another window is folded away.
    void start({ windowId: info.id, keepWindowOpen: info.current }, info.foldable.length);
  };
  const onFold = () => (choice.ask ? setAsking(true) : foldAll());
  const openWindows = (
    <OpenWindows windows={infos} highlight={asking && choice.ask ? highlight : null} disabled={folding} onFold={foldWindow} />
  );
  const folded = useFoldedTabs();
  const offer = useRecoveryOffer();
  const sync = useSyncStatus();
  const plan = useLoadedPlan();
  const cloud = useCloudSyncStatus();
  const milestone = useFoldMilestone(view);
  const shortcut = useFoldShortcut();
  const removal = useRemoveWithUndo();
  // 0.6: folders, the free list's room (from the folds' counts, no tab scan), snooze and live folders.
  const folders = useFolders();
  const siteKinds = useSiteKinds();
  const room = useListRoom();
  const counted = useFoldedCount();
  const liveFolders = useLiveFolders();
  const snoozeBack = useSnoozeBack();
  const autoNotice = useAutoFoldNotice();
  const free = !!plan && hasFreeLimits(plan);
  // Teams: the team's folders are read when the popup opens (the worker keeps to its back-off).
  const teamId = plan?.email ? (plan.team?.id ?? null) : null;
  useEffect(() => {
    if (teamId) void send({ type: 'team-sync-now', background: true }).catch(() => undefined);
  }, [teamId]);
  const toLibrary = (hash: string) => void openLibrary(hash).finally(() => window.close());
  const limit = room
    ? { full: room.full, near: room.near, room: room.room, onUpgrade: () => toLibrary(PLANS_HASH), onMakeRoom: () => toLibrary('#/room') }
    : null;

  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const docs = useMemo(() => openDocs(windows, currentWindowId), [windows, currentWindowId]);
  // The search index builds in its worker once the list is on screen, so the first keystroke is quick.
  const { result } = useTabSearch(query, docs, { limit: SEARCH_LIMIT, warm: folded !== undefined });
  const navRef = useRef<SearchNav | null>(null);
  const [activeId, setActiveId] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  // The search field is focused on open; its focus ring shows once the person focuses it themselves.
  const [ringed, setRinged] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        setRinged(true);
        inputRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        const input = e.target instanceof HTMLInputElement ? e.target : null;
        if ((!input || !input.value) && removal.undoLast()) e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [removal]);

  // Why the last open didn't work (the popup stays open to say so).
  const [problem, setProblem] = useState<string | null>(null);
  const onOpen = useCallback(
    (tab: TabRecord, background: boolean) => {
      setProblem(null);
      void send({ type: 'open-saved-tab', tabRecordId: tab.id, active: !background, windowId: currentWindowId })
        .then((result) => {
          if (!result.opened) setProblem(result.reason ?? 'Chrome wouldn’t open this page.');
          else if (!background) window.close();
        })
        .catch(() => undefined);
    },
    [currentWindowId],
  );
  const onOpenAll = useCallback(
    (group: OpenableGroup) => {
      void send({
        type: 'open-tabs',
        tabRecordIds: group.items.map((t) => t.id),
        asGroup: { name: group.name, color: group.color },
        windowId: currentWindowId,
      })
        .then((result) => {
          if (result.reason) setProblem(result.reason);
          else window.close();
        })
        .catch(() => undefined);
    },
    [currentWindowId],
  );

  const foldedTabs = folded?.tabs;
  const firstRun = !!foldedTabs && foldedTabs.length === 0 && (view.kind === 'rest' || view.kind === 'failed');
  const newSince = view.kind === 'folding' || view.kind === 'done' ? view.fold.startedAt - 1000 : undefined;

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex flex-none items-center gap-2 px-4 py-3">
        <Logo size={24} />
        <label
          className={cx(
            'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control border bg-surface pl-2.5 text-text-3',
            query ? 'pr-1' : 'pr-2.5',
            query || ringed
              ? 'border-border-strong focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]'
              : 'border-border-strong',
          )}
        >
          <Search size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
          <input
            ref={inputRef}
            type="search"
            autoFocus
            role="combobox"
            aria-expanded={searching}
            aria-controls={searching ? RESULTS_ID : undefined}
            aria-activedescendant={searching ? activeId : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => setRinged(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (!searching) return;
                e.preventDefault();
                navRef.current?.move(e.key === 'ArrowDown' ? 1 : -1);
              } else if (e.key === 'Enter' && searching) {
                e.preventDefault();
                navRef.current?.open(e.metaKey || e.ctrlKey);
              } else if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }}
            placeholder="Search tabs"
            aria-label="Search open and folded tabs by title, address or keyword"
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              className="flex size-6 flex-none items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
            >
              <X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </label>
        {free && <UpgradeButton size="sm" onClick={() => toLibrary(PLANS_HASH)} />}
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={() => {
            void openLibrary('#/settings').finally(() => window.close());
          }}
          className="flex size-8 flex-none items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
        >
          <SettingsIcon size={20} strokeWidth={1.75} aria-hidden />
        </button>
      </header>

      {problem && <OpenProblem text={problem} onDismiss={() => setProblem(null)} />}
      {searching ? (
        <>
        <SearchActions
          query={query}
          tab={windows.find((w) => w.id === currentWindowId)?.tabs.find((t) => t.active)}
          folders={folders ?? []}
          onProblem={setProblem}
        />
        <SearchResults
          onProblem={setProblem}
          query={query}
          result={result}
          openCount={docs.length}
          navRef={navRef}
          onActiveChange={setActiveId}
          onClear={() => {
            setQuery('');
            inputRef.current?.focus();
          }}
        />
        </>
      ) : (
        <>
          {offer && <CrashLine offer={offer} windowId={currentWindowId} />}
          <SnoozeBackLine back={snoozeBack} />
          <AutoFoldLine notice={autoNotice} />
          <Hero
            view={view}
            stats={stats}
            ready={ready}
            shortcut={shortcut}
            onFold={onFold}
            windowCount={infos.filter((w) => w.folds).length}
            currentWindowId={currentWindowId}
            milestone={milestone && <MilestoneCard freedBytes={milestone.freedBytes} onDismiss={milestone.dismiss} />}
            ask={{
              available: choice.ask,
              open: asking,
              thisCount: choice.thisWindow?.foldable.length ?? 0,
              allCount: choice.allTabs,
              windowCount: choice.withTabs.length,
              allNamed: choice.withTabs.length === infos.filter((w) => w.folds).length,
              onThis: () => choice.thisWindow && foldWindow(choice.thisWindow),
              onAll: foldAll,
              onCancel: () => setAsking(false),
              onFocusChange: setHighlight,
            }}
            limit={limit}
          />
          {!free && folders && <WorkingIn folders={folders} live={liveFolders} tabs={foldedTabs} onProblem={setProblem} />}
          {firstRun ? (
            <FirstRun top={ready && openWindows} />
          ) : (
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-border px-2 pt-1 pb-2">
              {ready && openWindows}
              {foldedTabs && (
                <>
                  <SectionLabel
                    countText={
                      room ? (
                        <span className={room.near ? 'font-semibold text-amber' : undefined}>
                          {room.tabs.toLocaleString()} of {room.limit.toLocaleString()}
                        </span>
                      ) : (
                        (counted?.tabs ?? foldedTabs.length).toLocaleString()
                      )
                    }
                  >
                    Folded
                  </SectionLabel>
                  <FoldedList
                    tabs={foldedTabs}
                    folders={folders}
                    siteKinds={siteKinds}
                    removal={removal}
                    newSince={newSince}
                    live={view.kind === 'folding'}
                    onOpen={onOpen}
                    onOpenAll={onOpenAll}
                  />
                </>
              )}
            </div>
          )}
          <PopupFooter sync={sync} cloud={cloud} pro={plan ? hasPro(plan) : undefined} />
        </>
      )}
    </div>
  );
}
