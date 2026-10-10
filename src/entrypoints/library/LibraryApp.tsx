import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TabRecord } from '@/lib/types';
import { ConfirmHost } from '@/ui/components/Dialog';
import { ToastViewport } from '@/ui/components/Toast';
import { ImportDialog } from '@/ui/ImportPanel';
import { browser } from 'wxt/browser';
import { extUrl } from '@/lib/extUrl';
import { useActiveFold, useFoldedTabs, useFoldWindows, useSettings, useSyncStatus } from '@/ui/hooks';
import { describeWindows, foldChoice, type WindowInfo } from '@/ui/windows';
import { EmptyState } from './EmptyState';
import { isFolding, startFold, useFoldCandidates, useFoldToast } from './fold';
import { count } from './format';
import { GroupedList } from './GroupedList';
import { HowPage } from './HowPage';
import { Notices } from './Notices';
import { OpenWindows } from './OpenWindows';
import { RecentFolds } from './RecentFolds';
import { useRoute } from './router';
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
 * open windows, each with its own Fold; the last three folds; every folded tab grouped by kind of site. Search results replace the list while
 * there is a query. Settings and Import open over it; How it works is its own page.
 */
export function LibraryApp() {
  const [route, navigate] = useRoute();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const [settings, , settingsLoaded] = useSettings();
  const folded = useFoldedTabs();
  const fold = useActiveFold();
  const syncStatus = useSyncStatus();
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
    document.title = route === 'how' ? 'How Tabfold frees memory' : 'Tabfold';
  }, [route]);

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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-text">
      <TopBar
        ref={searchRef}
        query={query}
        onQuery={setQuery}
        syncStatus={syncStatus}
        syncEnabled={settingsLoaded && settings.syncWithChrome}
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
                  <div className={recent.length ? 'mt-7 mb-1 flex items-baseline gap-2.5 px-0.5' : 'mb-1 flex items-baseline gap-2.5 px-0.5'}>
                    <h1 className="m-0 text-page leading-[1.45] font-semibold">Folded</h1>
                    <span className="text-text-3">{count(tabs.length, 'tab')} · newest first</span>
                  </div>
                )}
              </>
            )}
          </div>
          {!searching && !empty && folded && <GroupedList tabs={tabs} scrollRef={scrollRef} />}
        </div>
      </main>
      {hosts}
    </div>
  );
}
