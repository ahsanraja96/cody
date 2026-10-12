import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { PanelRight, Search, Settings as SettingsIcon, X } from 'lucide-react';
import { send } from '@/lib/messages';
import { openLibrary } from '@/lib/openLibrary';
import { extUrl } from '@/lib/extUrl';
import { FREE_LIMITS } from '@/lib/limits';
import { hasPro } from '@/lib/pro/tiers';
import { pendingFoldAsk, pendingFoldInto, pendingKeywordSave } from '@/lib/state';
import { personalFolders } from '@/lib/teams';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { FoldedList, useRemoveWithUndo, type OpenableGroup } from '@/ui/components/FoldedList';
import { Logo } from '@/ui/components/Logo';
import type { MenuAnchor } from '@/ui/components/Menu';
import { UpgradeButton } from '@/ui/components/ProBits';
import { QuickResults, RESULTS_ID, type SearchNav } from '@/ui/components/QuickResults';
import { ToastViewport } from '@/ui/components/Toast';
import { WeeklyLine } from '@/ui/components/Weekly';
import { WindowMenu, type FoldTarget } from '@/ui/components/WindowMenu';
import { PLANS_HASH } from '@/ui/pro';
import { cx } from '@/ui/cx';
import { folderCounts, starredFirst } from '@/ui/folders';
import { closeCopies, copiesIn, foldBackFolders, foldBackText, openSearchDocs, renameWindow, tidyWindow } from '@/ui/openTabs';
import { describeWindows, foldChoice, type WindowInfo } from '@/ui/windows';
import {
  foldIntoOrder,
  hasFreeLimits,
  isStarred,
  useGroupFolders,
  usePendingFoldInto,
  useRecentFolders,
  useStarredTeamFolders,
  useTabGroups,
  useWeeklySummary,
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
import { FoldBackHint } from '@/ui/components/WindowParts';
import { OpenWindows } from './OpenWindows';
import { CrashLine, OpenProblem, PopupFooter, SectionLabel } from './parts';
import { longAgo, useFold, useFoldShortcut, useOpenTabStats } from './popupHooks';
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

type PopupMenu =
  /** A window's ⋯ (Fold into…, Tidy into groups, Rename window, Close the copies). */
  | { kind: 'window'; info: WindowInfo; anchor: MenuAnchor; button: HTMLElement | null }
  /** The Fold button's ▾, or right-click › "Choose a folder…" (a tab). */
  | { kind: 'fold-into'; info?: WindowInfo; tabId?: number; anchor: MenuAnchor; button: HTMLElement | null };

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
  // 1.0: starred folders first, Fold into, fold back, the copies, the weekly summary.
  const teamStars = useStarredTeamFolders();
  const recentFolders = useRecentFolders();
  const groupFolders = useGroupFolders();
  const tabGroups = useTabGroups();
  const weekly = useWeeklySummary();
  const pendingInto = usePendingFoldInto();
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

  const starred = useCallback((folder: FolderRecord) => isStarred(folder, teamStars), [teamStars]);
  const shownFolders = useMemo(() => (folders ? starredFirst(folders, teamStars) : undefined), [folders, teamStars]);
  const intoFolders = useMemo(() => foldIntoOrder(folders ?? [], teamStars, recentFolders), [folders, teamStars, recentFolders]);
  const counts = useMemo(() => folderCounts(folded?.tabs), [folded]);
  const folderLimit = free && personalFolders(folders ?? []).length >= FREE_LIMITS.folders;
  const copies = useMemo(() => copiesIn(infos), [infos]);
  const hints = useMemo(() => {
    const map = new Map<number, ReactNode>();
    for (const info of infos) {
      const back = foldBackFolders(info.tabs, tabGroups, groupFolders, folders);
      if (back.length) map.set(info.id, <FoldBackHint folders={back} text={foldBackText(back)} />);
    }
    return map;
  }, [infos, tabGroups, groupFolders, folders]);

  const [menu, setMenu] = useState<PopupMenu | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const foldButtonRef = useRef<HTMLElement | null>(null);
  const foldInto = (info: WindowInfo | undefined, target: FoldTarget, tabId?: number) => {
    setAsking(false);
    const into = 'folderId' in target ? { intoFolderId: target.folderId } : { newFolderName: target.newName };
    if (tabId !== undefined) void start({ tabIds: [tabId], keepWindowOpen: true, ...into }, 1);
    else if (info) void start({ windowId: info.id, keepWindowOpen: info.current, ...into }, info.foldable.length);
  };

  // Right-click › "Fold this tab into › Choose a folder…": the folder list for that tab, once.
  const handledInto = useRef<number>(0);
  useEffect(() => {
    if (!pendingInto || handledInto.current === pendingInto.at || !ready) return;
    handledInto.current = pendingInto.at;
    void pendingFoldInto.set(null).catch(() => undefined);
    if (Date.now() - pendingInto.at > PENDING_MAX_AGE_MS) return;
    setMenu({ kind: 'fold-into', tabId: pendingInto.tabId, anchor: { x: window.innerWidth - 16, y: 56, alignRight: true }, button: null });
  }, [pendingInto, ready]);

  const openWindows = (
    <OpenWindows
      windows={infos}
      highlight={asking && choice.ask ? highlight : null}
      disabled={folding}
      menuFor={menu?.kind === 'window' ? menu.info.id : undefined}
      hints={hints}
      copies={copies}
      renaming={renaming}
      onRenaming={setRenaming}
      onCloseCopies={() => void closeCopies()}
      actions={{
        onFold: foldWindow,
        onMenu: (info, anchor, button) => setMenu({ kind: 'window', info, anchor, button }),
        onRename: (info, name) => void renameWindow(info.id, name),
      }}
    />
  );

  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const docs = useMemo(() => openSearchDocs(infos, extUrl('/')), [infos]);
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
        ...(group.folderId ? { folderId: group.folderId } : {}),
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
  const sidePanel = !!browser.sidePanel?.open;
  const thisWindow = choice.thisWindow;
  const tabsText = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'tab' : 'tabs'}`;

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
        {sidePanel && (
          <button
            type="button"
            aria-label="Open in side panel"
            title="Open in side panel"
            onClick={() => {
              // Chrome opens the side panel only from a click, so it's asked for right here.
              browser.sidePanel
                .open({ windowId: currentWindowId ?? browser.windows.WINDOW_ID_CURRENT })
                .then(() => window.close())
                .catch(() => setProblem('Chrome didn’t open the side panel. Try again from the toolbar.'));
            }}
            className="flex size-8 flex-none items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
          >
            <PanelRight size={18} strokeWidth={1.75} aria-hidden />
          </button>
        )}
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
          <QuickResults
            query={query}
            result={result}
            openCount={docs.length}
            folders={shownFolders ?? []}
            counts={counts}
            tabs={foldedTabs}
            siteKinds={siteKinds}
            currentWindowId={currentWindowId}
            navRef={navRef}
            onActiveChange={setActiveId}
            onProblem={setProblem}
            onDone={() => window.close()}
            ago={(at) => longAgo(at)}
            onOpenFolder={(folder) =>
              onOpenAll({
                name: folder.name,
                color: folder.color,
                items: (foldedTabs ?? []).filter((t) => t.folderId === folder.id && !t.snoozeUntil),
                folderId: folder.id,
              })
            }
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
            foldMenu={
              thisWindow && thisWindow.foldable.length > 0
                ? {
                    open: menu?.kind === 'fold-into' && menu.tabId === undefined,
                    onOpen: (button) => {
                      foldButtonRef.current = button;
                      setMenu({ kind: 'fold-into', info: thisWindow, anchor: anchorBelowButton(button), button });
                    },
                  }
                : undefined
            }
            weekly={weekly ? <WeeklyLine week={weekly} /> : undefined}
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
                    folders={shownFolders}
                    siteKinds={siteKinds}
                    removal={removal}
                    newSince={newSince}
                    live={view.kind === 'folding'}
                    onOpen={onOpen}
                    onOpenAll={onOpenAll}
                    isStarred={starred}
                  />
                </>
              )}
            </div>
          )}
          <PopupFooter sync={sync} cloud={cloud} pro={plan ? hasPro(plan) : undefined} />
        </>
      )}
      {menu && (
        <WindowMenu
          anchor={menu.anchor}
          returnFocus={menu.button}
          name={menu.kind === 'window' ? menu.info.name : (menu.info?.name ?? 'This tab')}
          folders={intoFolders}
          counts={counts}
          starred={starred}
          folderLimit={folderLimit}
          start={menu.kind === 'fold-into' ? 'into' : 'menu'}
          heading={
            menu.kind === 'fold-into'
              ? menu.tabId !== undefined
                ? { title: 'Fold this tab into' }
                : { title: 'Fold into a folder', right: `This window · ${tabsText(menu.info?.foldable.length ?? 0)}` }
              : undefined
          }
          copies={menu.kind === 'window' ? copiesIn(infos, menu.info.id).pages : 0}
          canFold={menu.kind === 'window' ? menu.info.folds && menu.info.foldable.length > 0 : true}
          onFoldInto={(target) => (menu.kind === 'fold-into' && menu.tabId !== undefined ? foldInto(undefined, target, menu.tabId) : foldInto(menu.info, target))}
          onTidy={menu.kind === 'window' && !menu.info.incognito ? () => void tidyWindow(menu.info.id) : undefined}
          onRename={menu.kind === 'window' && !menu.info.incognito ? () => setRenaming(menu.info.id) : undefined}
          onCloseCopies={menu.kind === 'window' ? () => void closeCopies(menu.info.id) : undefined}
          onUpgrade={() => toLibrary(PLANS_HASH)}
          onClose={() => setMenu(null)}
        />
      )}
      <ToastViewport className="bottom-14" />
    </div>
  );
}

/** Below a button, right-aligned with it (the menus' usual place). */
function anchorBelowButton(el: HTMLElement): MenuAnchor {
  const r = el.getBoundingClientRect();
  return { x: r.right, y: r.bottom + 4, alignRight: true, flipY: r.top - 4 };
}
