import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import type { TabRecord } from '@/lib/types';
import { ConfirmHost } from '@/ui/components/Dialog';
import { dismissToast, toast, ToastViewport } from '@/ui/components/Toast';
import { ImportDialog } from '@/ui/ImportPanel';
import { browser } from 'wxt/browser';
import { extUrl } from '@/lib/extUrl';
import { hasProAi } from '@/lib/pro/tiers';
import { FREE_PLAN } from '@/lib/pro/types';
import { send } from '@/lib/messages';
import {
  useActiveFold,
  useAutoFoldNotice,
  useCloudSyncStatus,
  useFoldedTabs,
  useFolders,
  useFoldWindows,
  useLastAction,
  useListRoom,
  useLiveFolders,
  useLoadedPlan,
  useSettings,
  useSiteKinds,
  useSyncStatus,
  useTidy,
  useWorkerEvents,
} from '@/ui/hooks';
import { autoFoldText } from '@/ui/limits';
import { describeWindows, foldChoice, type WindowInfo } from '@/ui/windows';
import { AccountDialogHost, useCheckoutClosedToast } from './AccountDialogs';
import { AskChip, BestMatches, looksLikeQuestion, useAsk } from './ask';
import { CommandPalette } from './CommandPalette';
import { DuplicatesDialog } from './DuplicatesDialog';
import { EmptyState } from './EmptyState';
import { isFolding, startFold, useFoldCandidates, useFoldToast } from './fold';
import { folderLimitReached, undoAction } from './folderActions';
import { FolderDialogHost } from './FolderDialogs';
import { FoldedHeading } from './FoldedHeading';
import { GroupedList } from './GroupedList';
import { HowPage } from './HowPage';
import { MakeRoomDialog } from './LimitBits';
import { Notices } from './Notices';
import { OpenWindows } from './OpenWindows';
import { OrganiseDialog } from './OrganiseDialog';
import { PlansPage } from './PlansPage';
import { RecentFolds } from './RecentFolds';
import { goToPlans, parseHash, useRoute, type Route } from './router';
import { SearchResults } from './SearchResults';
import { SettingsDialog, useFoldShortcut } from './SettingsDialog';
import { ShareDialog } from './ShareDialog';
import { showTidy, TidyCard } from './TidyCard';
import { TopBar } from './TopBar';
import { openDialog, useLibraryUi } from './uiStore';
import { dropUndo, registerUndo, undoLatest } from './undo';
import { useRemovals } from './actions';
import { WelcomePage } from './WelcomePage';

const NO_TABS: TabRecord[] = [];

/**
 * Ask the worker for the plan when the page opens and whenever it comes back into focus (back from
 * Stripe's pages, say). The worker reads it at most once a minute, and only for a computer that has
 * signed in or paid.
 */
function usePlanRefresh() {
  useEffect(() => {
    let last = 0;
    const refresh = () => {
      if (Date.now() - last < 5_000) return;
      last = Date.now();
      void send({ type: 'plan-refresh' }).catch(() => undefined);
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
}

/**
 * Every automatic fold says what it did, with Undo while it lasts: a toast when a rule runs while
 * the page is open (or ran just before it opened).
 */
function useAutoFoldToast() {
  const notice = useAutoFoldNotice();
  const action = useLastAction();
  const shown = useRef<number>(0);
  const openedAt = useRef(Date.now());
  useEffect(() => {
    if (!notice || notice.at <= shown.current || notice.folded <= 0) return;
    if (notice.at < openedAt.current - 2 * 60_000) return;
    shown.current = notice.at;
    const message = autoFoldText(notice);
    const live = !!notice.actionId && !!action && action.id === notice.actionId && !action.undone && action.expiresAt > Date.now();
    const left = live ? action!.expiresAt - Date.now() : 0;
    const key = `auto:${notice.at}`;
    let id = 0;
    const undo = () => {
      dropUndo(key);
      dismissToast(id);
      if (notice.actionId) void undoAction(notice.actionId);
    };
    id = toast(message, {
      icon: <Zap size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />,
      duration: live ? left : 8_000,
      countdown: live,
      ...(live ? { action: { label: 'Undo', onClick: undo } } : {}),
    });
    if (live) registerUndo(key, undo, action!.expiresAt);
  }, [notice, action]);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable);
}

/**
 * The full list (Fo-List, Min-List-Windows): top bar with search, sync line, Upgrade (Free),
 * Settings and Fold tabs; the open windows, each with its own Fold; the last three folds; the
 * weekly tidy-up (Pro AI); every folded tab, snoozed ones first, then the person's folders, then
 * by kind of site. Search results replace the list while there is a query. Settings, Import, Make
 * room and Ctrl+K open over it; How it works, the plans page (Mx-Plans) and the page a paid
 * checkout lands on (Stripe-Welcome) are their own pages.
 */
export function LibraryApp() {
  const [route, navigate] = useRoute();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const [settings, , settingsLoaded] = useSettings();
  const folded = useFoldedTabs();
  const folders = useFolders();
  const siteKinds = useSiteKinds();
  const room = useListRoom();
  const liveFolders = useLiveFolders();
  const tidy = useTidy();
  const fold = useActiveFold();
  const syncStatus = useSyncStatus();
  const loadedPlan = useLoadedPlan();
  const plan = loadedPlan ?? FREE_PLAN;
  const cloudStatus = useCloudSyncStatus();
  const [organising, setOrganising] = useState(false);
  const { windows, allWindows, foldsIncognito } = useFoldWindows();
  const [currentWindowId, setCurrentWindowId] = useState<number>();
  const dialog = useLibraryUi((s) => s.dialog);
  const closeDialog = useLibraryUi((s) => s.close);
  useEffect(() => {
    browser.windows
      .getCurrent()
      .then((w) => setCurrentWindowId(w.id))
      .catch(() => undefined);
  }, []);
  const infos = useMemo(
    () => describeWindows(allWindows, { currentWindowId, keepPinnedOpen: settings.keepPinnedOpen, foldsIncognito, ownOrigin: extUrl('/') }),
    [allWindows, currentWindowId, settings.keepPinnedOpen, foldsIncognito],
  );
  const choice = foldChoice(infos);
  const candidates = useFoldCandidates(infos);
  // The window this page is in stays open with a new tab; another window is folded away.
  const foldWindow = (info: WindowInfo) => void startFold({ windowId: info.id, keepWindowOpen: info.current });
  const shortcut = useFoldShortcut();
  const hasRemovals = useRemovals((s) => s.removals.size > 0);
  const [activeResult, setActiveResult] = useState<string | undefined>();
  const { ask, run: runAsk } = useAsk(query);
  useFoldToast();
  usePlanRefresh();
  useCheckoutClosedToast();
  useAutoFoldToast();

  // A Free action hit a limit where no page asked (the shortcut, a rule).
  useWorkerEvents((event) => {
    if (event.type !== 'limit-hit') return;
    if (event.code === 'list-full') useLibraryUi.getState().setLimitHit('list-full');
    else if (event.code === 'folder-limit') openDialog({ kind: 'folder-limit' });
    else if (event.code === 'snooze-limit') openDialog({ kind: 'snooze-limit' });
  });

  const tabs = folded?.tabs ?? NO_TABS;
  const recent = useMemo(
    () =>
      (folded?.folds ?? [])
        .filter((f) => f.kind !== 'unsorted' && f.source !== 'import' && f.tabCount > 0)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 3),
    [folded],
  );
  const searching = query.trim().length > 0;
  const askable = searching && looksLikeQuestion(query);
  const proAi = hasProAi(plan);

  useEffect(() => {
    document.title = route === 'how' ? 'How Tabfold frees memory' : route === 'pro' || route === 'welcome' ? 'Tabfold Pro' : 'Tabfold';
  }, [route]);

  // Typing a search on the plans or welcome page goes back to the list, where the results show.
  const onQuery = (value: string) => {
    setQuery(value);
    if ((route === 'pro' || route === 'welcome') && value.trim()) navigate('list');
  };

  // / focuses search, Esc clears it, ⌘K / Ctrl+K opens the palette, ⌘Z / Ctrl+Z undoes the last removal or fold.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
      const typing = isTyping(e.target);
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (route !== 'list') navigate('list');
        openDialog({ kind: 'palette' });
      } else if (e.key === '/' && !typing && route === 'list') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'Escape' && query && route === 'list') {
        e.preventDefault();
        setQuery('');
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && !typing) {
        if (undoLatest()) e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [query, route, navigate]);

  // A new query starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [searching]);

  const onActiveResult = useCallback((id: string | undefined) => setActiveResult(id), []);
  // A dialog closes (and fires "close") when the route moves on, for example Settings › See Pro and
  // Pro AI: only a dialog that is still the current route goes back to the list.
  const closeRoute = (from: Route) => {
    if (parseHash(location.hash) === from) navigate('list', { replace: true });
  };
  const openImport = () => navigate('import');
  const makeRoom = () => navigate('room');
  const windowLabel = useCallback((id: number) => infos.find((w) => w.id === id)?.name ?? 'Another window', [infos]);
  const newFolder = () => {
    if (folderLimitReached(plan, folders)) openDialog({ kind: 'folder-limit' });
    // The left column's field when it shows (wide windows); a small dialog otherwise.
    else if (window.matchMedia('(min-width: 1320px)').matches && !searching) useLibraryUi.getState().setCreating(true);
    else openDialog({ kind: 'new-folder' });
  };

  const hosts = (
    <>
      <SettingsDialog
        open={route === 'settings'}
        onClose={() => closeRoute('settings')}
        onHow={() => navigate('how')}
        onImport={() => navigate('import', { replace: true })}
        onDuplicates={() => openDialog({ kind: 'duplicates' })}
        syncStatus={syncStatus}
        foldedCount={tabs.length}
      />
      <ImportDialog open={route === 'import'} onClose={() => closeRoute('import')} />
      <MakeRoomDialog open={route === 'room'} onClose={() => closeRoute('room')} />
      <OrganiseDialog open={organising && route === 'list'} onClose={() => setOrganising(false)} tabs={tabs} folders={folders ?? []} />
      <FolderDialogHost
        render={(d, close) => {
          if (d.kind === 'duplicates') return <DuplicatesDialog onClose={close} />;
          if (d.kind === 'share') {
            const folder = folders?.find((f) => f.id === d.folderId);
            const pages = tabs.filter((t) => t.folderId === d.folderId && !t.incognito).length;
            return folder ? <ShareDialog folder={folder} pages={pages} onClose={close} /> : null;
          }
          if (d.kind === 'palette') {
            return (
              <CommandPalette
                onClose={close}
                folders={folders ?? []}
                tabs={tabs}
                plan={plan}
                liveFolders={liveFolders}
                actions={{
                  settings: () => navigate('settings'),
                  importer: openImport,
                  makeRoom,
                  organise: () => setOrganising(true),
                }}
              />
            );
          }
          return null;
        }}
      />
      <AccountDialogHost />
      <ToastViewport />
      <ConfirmHost />
    </>
  );

  // A dialog from the store stays only on the list (a route change closes it).
  useEffect(() => {
    if (dialog && route !== 'list' && route !== 'settings' && route !== 'room') closeDialog();
  }, [route, dialog, closeDialog]);

  if (route === 'how') {
    return (
      <>
        <HowPage onBack={() => navigate('list')} />
        {hosts}
      </>
    );
  }

  const empty = folded !== undefined && tabs.length === 0 && !hasRemovals && (folders?.length ?? 0) === 0;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-text">
      <TopBar
        ref={searchRef}
        query={query}
        onQuery={onQuery}
        syncStatus={syncStatus}
        syncEnabled={settingsLoaded && settings.syncWithChrome}
        plan={loadedPlan}
        cloudStatus={cloudStatus}
        onSyncAll={goToPlans}
        onMakeRoom={makeRoom}
        onSettings={() => navigate('settings')}
        onUpgrade={goToPlans}
        askChip={askable ? <AskChip proAi={proAi} busy={ask?.status === 'loading'} onAsk={runAsk} /> : undefined}
        onFold={() => void startFold()}
        fold={fold}
        candidates={candidates}
        choice={{
          ask: choice.ask,
          thisCount: choice.thisWindow?.foldable.length ?? 0,
          allCount: choice.allTabs,
          windowCount: choice.withTabs.length,
          allNamed: choice.withTabs.length === infos.filter((w) => w.folds).length,
          onThis: () => choice.thisWindow && foldWindow(choice.thisWindow),
          onAll: () => void startFold(),
        }}
        shortcut={shortcut}
        activeDescendant={searching ? activeResult : undefined}
      />
      {route === 'pro' || route === 'welcome' ? (
        <main className="scroll-thin relative min-h-0 flex-1 overflow-y-auto bg-bg-subtle [scrollbar-gutter:stable_both-edges]">
          {route === 'pro' ? (
            <PlansPage onBack={() => navigate('list')} />
          ) : (
            <WelcomePage
              onBack={() => navigate('list', { replace: true })}
              onOrganise={() => {
                navigate('list', { replace: true });
                setOrganising(true);
              }}
              onTeam={() => navigate('settings', { replace: true })}
            />
          )}
        </main>
      ) : (
        <main ref={scrollRef} className="scroll-thin relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,880px)_minmax(0,1fr)] px-8 pt-6 pb-12 max-[720px]:px-4">
            <div className="col-start-2 row-start-1 min-w-0">
              <Notices fold={fold} onImport={openImport} onMakeRoom={makeRoom} />
              {searching ? (
                <SearchResults
                  query={query}
                  windows={windows}
                  foldedCount={tabs.length}
                  scrollRef={scrollRef}
                  onClear={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  onActive={onActiveResult}
                  top={ask ? <BestMatches ask={ask} tabs={tabs} folders={folders ?? []} /> : undefined}
                  onShiftEnter={askable && proAi ? runAsk : undefined}
                />
              ) : empty ? (
                <>
                  <OpenWindows windows={infos} disabled={isFolding(fold)} onFold={foldWindow} />
                  <EmptyState onImport={openImport} foldable={candidates.tabs} />
                </>
              ) : (
                <>
                  {proAi && showTidy(tidy, settings.tidyUp) && <TidyCard tidy={tidy} onSettings={() => navigate('settings')} />}
                  <OpenWindows windows={infos} disabled={isFolding(fold)} onFold={foldWindow} />
                  <RecentFolds folds={recent} tabs={tabs} />
                  {folded && (
                    <FoldedHeading
                      tabs={room ? room.tabs : tabs.length}
                      limit={room ? room.limit : null}
                      near={!!room?.near}
                      folders={folders?.length ?? 0}
                      spaced={recent.length > 0}
                      onNewFolder={newFolder}
                      onOrganise={() => setOrganising(true)}
                    />
                  )}
                </>
              )}
            </div>
            {!searching && !empty && folded && (
              <GroupedList
                tabs={tabs}
                folders={folders ?? []}
                siteKinds={siteKinds}
                liveFolders={liveFolders}
                plan={plan}
                windowLabel={windowLabel}
                scrollRef={scrollRef}
                canCopyContext={proAi}
              />
            )}
          </div>
        </main>
      )}
      {hosts}
    </div>
  );
}
