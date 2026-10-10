import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TabRecord } from '@/lib/types';
import { ConfirmHost } from '@/ui/components/Dialog';
import { ToastViewport } from '@/ui/components/Toast';
import { ImportDialog } from '@/ui/ImportPanel';
import { browser } from 'wxt/browser';
import { extUrl } from '@/lib/extUrl';
import { hasProAi } from '@/lib/pro/tiers';
import { FREE_PLAN } from '@/lib/pro/types';
import { useActiveFold, useCloudSyncStatus, useFoldedTabs, useFoldWindows, useLoadedPlan, useProjects, useSettings, useSyncStatus } from '@/ui/hooks';
import { describeWindows, foldChoice, type WindowInfo } from '@/ui/windows';
import { EmptyState } from './EmptyState';
import { isFolding, startFold, useFoldCandidates, useFoldToast } from './fold';
import { FoldedHeading } from './FoldedHeading';
import { GroupedList } from './GroupedList';
import { HowPage } from './HowPage';
import { Notices } from './Notices';
import { OpenWindows } from './OpenWindows';
import { OrganiseDialog } from './OrganiseDialog';
import { PlansPage } from './PlansPage';
import { RecentFolds } from './RecentFolds';
import { goToPlans, useRoute } from './router';
import { SearchResults } from './SearchResults';
import { SettingsDialog, useFoldShortcut } from './SettingsDialog';
import { TopBar } from './TopBar';
import { undoLatest } from './undo';
import { useRemovals } from './actions';

const NO_TABS: TabRecord[] = [];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable);
}

/**
 * The full list (Min-List-Windows): top bar with search, sync line, Settings and Fold tabs; the
 * open windows, each with its own Fold; the last three folds; every folded tab grouped by kind of
 * site, or by project after Organise with AI (Pro-List-Projects). Search results replace the list
 * while there is a query. Settings and Import open over it; How it works and the plans page
 * (Pro-Plans) are their own pages.
 */
export function LibraryApp() {
  const [route, navigate] = useRoute();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const [settings, updateSettings, settingsLoaded] = useSettings();
  const folded = useFoldedTabs();
  const fold = useActiveFold();
  const syncStatus = useSyncStatus();
  const loadedPlan = useLoadedPlan();
  const plan = loadedPlan ?? FREE_PLAN;
  const cloudStatus = useCloudSyncStatus();
  const projects = useProjects();
  const [organising, setOrganising] = useState(false);
  const { windows, allWindows, foldsIncognito } = useFoldWindows();
  const [currentWindowId, setCurrentWindowId] = useState<number>();
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
  useFoldToast();

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

  useEffect(() => {
    document.title = route === 'how' ? 'How Tabfold frees memory' : route === 'pro' ? 'Tabfold Pro' : 'Tabfold';
  }, [route]);

  // Typing a search on the plans page goes back to the list, where the results show.
  const onQuery = (value: string) => {
    setQuery(value);
    if (route === 'pro' && value.trim()) navigate('list');
  };

  // / focuses search, Esc clears it, ⌘Z / Ctrl+Z undoes the last removal or fold.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
      const typing = isTyping(e.target);
      if (e.key === '/' && !typing && route === 'list') {
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
  }, [query, route]);

  // A new query starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [searching]);

  const onActiveResult = useCallback((id: string | undefined) => setActiveResult(id), []);
  const openImport = () => navigate('import');

  const hosts = (
    <>
      <SettingsDialog
        open={route === 'settings'}
        onClose={() => navigate('list', { replace: true })}
        onHow={() => navigate('how')}
        onImport={() => navigate('import', { replace: true })}
        syncStatus={syncStatus}
        foldedCount={tabs.length}
      />
      <ImportDialog open={route === 'import'} onClose={() => navigate('list', { replace: true })} />
      <OrganiseDialog open={organising && route === 'list'} onClose={() => setOrganising(false)} tabs={tabs} />
      <ToastViewport />
      <ConfirmHost />
    </>
  );

  if (route === 'how') {
    return (
      <>
        <HowPage onBack={() => navigate('list')} />
        {hosts}
      </>
    );
  }

  const empty = folded !== undefined && tabs.length === 0 && !hasRemovals;
  const groupBy = settings.groupBy === 'project' && projects.projects.length > 0 ? 'project' : 'site';

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
        onSettings={() => navigate('settings')}
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
      {route === 'pro' ? (
        <main className="scroll-thin relative min-h-0 flex-1 overflow-y-auto bg-bg-subtle [scrollbar-gutter:stable_both-edges]">
          <PlansPage onBack={() => navigate('list')} />
        </main>
      ) : (
      <main ref={scrollRef} className="scroll-thin relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,880px)_minmax(0,1fr)] px-8 pt-6 pb-12 max-[720px]:px-4">
          <div className="col-start-2 row-start-1 min-w-0">
            <Notices fold={fold} onImport={openImport} />
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
              />
            ) : empty ? (
              <>
                <OpenWindows windows={infos} disabled={isFolding(fold)} onFold={foldWindow} />
                <EmptyState onImport={openImport} foldable={candidates.tabs} />
              </>
            ) : (
              <>
                <OpenWindows windows={infos} disabled={isFolding(fold)} onFold={foldWindow} />
                <RecentFolds folds={recent} tabs={tabs} />
                {folded && (
                  <FoldedHeading
                    tabs={tabs}
                    spaced={recent.length > 0}
                    groupBy={groupBy}
                    projects={projects}
                    onGroupBy={(by) => updateSettings({ groupBy: by })}
                    onOrganise={() => setOrganising(true)}
                  />
                )}
              </>
            )}
          </div>
          {!searching && !empty && folded && (
            <GroupedList tabs={tabs} scrollRef={scrollRef} groupBy={groupBy} projects={projects.projects} canCopyContext={hasProAi(plan)} />
          )}
        </div>
      </main>
      )}
      {hosts}
    </div>
  );
}
