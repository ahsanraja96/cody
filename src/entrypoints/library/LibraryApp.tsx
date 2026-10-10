import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, Search, X } from 'lucide-react';
import { checkWiped } from '@/lib/dataGuard';
import { send } from '@/lib/messages';
import { listLiveSessions } from '@/lib/repo';
import { Button, IconButton } from '@/ui/components/Button';
import { Kbd } from '@/ui/components/Chips';
import { ConfirmHost } from '@/ui/components/Dialog';
import { ProInfoHost } from '@/ui/components/ProDialog';
import { dismissToast, toast, ToastViewport, triggerLatestUndo } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { useLastAction, useUpdateReady } from '@/ui/hooks';
import { plural } from '@/lib/format';
import { useRoute, type Route } from './router';
import { Sidebar } from './Sidebar';
import { SessionsView } from './SessionsView';
import { SessionDetail } from './SessionDetail';
import { SearchView } from './SearchView';
import { SnapshotsView } from './SnapshotsView';
import { TrashView } from './TrashView';
import { SettingsView } from './SettingsView';
import { GroupsUnavailableBanner, StorageWarning, UpdateBanner } from './flows/Banners';
import { FlowsHost } from './flows/FlowsHost';
import { openShortcutsDialog } from './flows/index';
import { WipedScreen } from './flows/WipedScreen';

/** Below this width the session detail opens as an overlay panel and the sidebar becomes a rail. */
export const WIDE_LAYOUT = '(min-width: 1200px)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener('change', onChange);
    onChange();
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable);
}

function anyDialogOpen(): boolean {
  return !!document.querySelector('dialog[open]');
}

/** A save made from the popup, a shortcut or here shows its Undo with the seconds left, while it is still undoable. */
function useUndoToast() {
  const action = useLastAction();
  const shown = useRef<{ actionId: string; toastId: number } | null>(null);
  useEffect(() => {
    // Undo in one place clears it everywhere.
    if (shown.current && (!action || action.undone || action.id !== shown.current.actionId)) {
      dismissToast(shown.current.toastId);
      if (!action || action.id === shown.current.actionId) shown.current = null;
    }
    if (!action || action.undone || action.expiresAt < Date.now() || shown.current?.actionId === action.id) return;
    const left = Math.max(2000, action.expiresAt - Date.now());
    const message =
      action.closedTabs > 0 || !action.sessionName ? `Saved ${plural(action.savedTabs, 'tab')}` : `Saved ${plural(action.savedTabs, 'tab')} to ${action.sessionName}`;
    const toastId = toast(message, {
      tone: 'success',
      duration: left,
      countdown: true,
      announce: `${message}. Undo available for ${Math.round(left / 1000)} seconds.`,
      action: {
        label: 'Undo',
        onClick: () =>
          send({ type: 'undo', actionId: action.id })
            .then((result) => {
              if (!result.undone && result.reason) toast(result.reason, { tone: 'error' });
            })
            .catch(() => undefined),
      },
    });
    shown.current = { actionId: action.id, toastId };
  }, [action]);
}

export function LibraryApp() {
  const [route, navigate] = useRoute();
  const wide = useMediaQuery(WIDE_LAYOUT);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchText, setSearchText] = useState(route.view === 'search' ? (route.query ?? '') : '');
  const updateReady = useUpdateReady();
  const live = useLiveQuery(() => listLiveSessions(), []);
  const [wipeCheckKey, setWipeCheckKey] = useState(0);
  const wipe = useLiveQuery(() => checkWiped(), [wipeCheckKey]);
  const tabTotal = live?.reduce((n, s) => n + s.tabCount, 0) ?? 0;

  useUndoToast();

  // Keep the search box in sync when the route changes from outside (back button, popup link).
  useEffect(() => {
    if (route.view === 'search') setSearchText(route.query ?? '');
  }, [route.view, route.query]);

  const selectSession = (sessionId: string | undefined) => navigate({ ...route, sessionId }, { replace: true });
  const openSession = (sessionId: string) => navigate({ view: 'all', sessionId });
  const showDetail = !!route.sessionId && route.view !== 'settings' && route.view !== 'snapshots';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typing = isTyping(e.target);
      if (e.key === '/' && !typing && !anyDialogOpen()) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === '?' && !typing && !anyDialogOpen()) {
        e.preventDefault();
        openShortcutsDialog();
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && !typing && !anyDialogOpen()) {
        if (triggerLatestUndo()) e.preventDefault();
      } else if (e.key === 'Escape' && !anyDialogOpen() && showDetail && !typing) {
        e.preventDefault();
        selectSession(undefined);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const onSearchChange = (value: string) => {
    setSearchText(value);
    if (value.trim()) navigate({ view: 'search', query: value, sessionId: route.sessionId }, { replace: route.view === 'search' });
    else if (route.view === 'search') navigate({ view: 'all' }, { replace: true });
  };

  const saveAll = async () => {
    try {
      const current = await browser.windows.getCurrent();
      const outcome = await send({ type: 'save', scope: 'all', close: true, windowId: current.id, audible: 'keep' });
      if (outcome.savedTabs === 0 && outcome.skippedDuplicates === 0) toast('Nothing to save: only pinned, blank or Tabfold tabs are open.');
      else if (outcome.keptOpen.audible) toast(`${plural(outcome.keptOpen.audible, 'tab')} playing audio stayed open.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Saving failed.', { tone: 'error' });
    }
  };

  const hosts = (
    <>
      <FlowsHost detailSessionId={showDetail ? route.sessionId : undefined} onOpenSession={openSession} />
      <ToastViewport />
      <ConfirmHost />
      <ProInfoHost />
    </>
  );

  if (route.view === 'settings') {
    return (
      <div className="relative flex h-screen flex-col overflow-hidden bg-bg text-text">
        {updateReady && <UpdateBanner />}
        <div className={cx('min-h-0 flex-1', updateReady && 'pointer-events-none opacity-50')} inert={!!updateReady}>
          <SettingsView section={route.section} onBack={() => navigate({ view: 'all' })} />
        </div>
        {hosts}
      </div>
    );
  }

  const view = (r: Route) => {
    if (wipe?.wiped && (r.view === 'all' || r.view === 'pinned' || r.view === 'recent' || r.view === 'tag')) {
      return (
        <WipedScreen
          check={wipe}
          onRecovered={(id) => {
            setWipeCheckKey((k) => k + 1);
            openSession(id);
          }}
          onDismissed={() => setWipeCheckKey((k) => k + 1)}
        />
      );
    }
    switch (r.view) {
      case 'snapshots':
        return <SnapshotsView />;
      case 'trash':
        return <TrashView selectedId={r.sessionId} onSelect={selectSession} />;
      case 'search':
        return <SearchView query={r.query ?? ''} selectedId={r.sessionId} onSelect={selectSession} />;
      default:
        return <SessionsView route={r} navigate={navigate} onSaveAll={saveAll} />;
    }
  };

  const detail = showDetail && route.sessionId && (
    <SessionDetail
      key={route.sessionId}
      sessionId={route.sessionId}
      highlightQuery={route.view === 'search' ? route.query : undefined}
      overlay={!wide}
      onClose={() => selectSession(undefined)}
    />
  );

  return (
    <div className="relative flex h-screen overflow-hidden bg-bg text-text">
      <Sidebar route={route} navigate={navigate} />
      <div className="relative flex min-w-0 flex-1 flex-col">
        {updateReady && <UpdateBanner />}
        <div className={cx('flex min-h-0 flex-1 flex-col', updateReady && 'pointer-events-none opacity-50')} inert={!!updateReady}>
          <div className="flex min-h-14 flex-wrap items-center gap-2.5 border-b border-border px-6 py-2.5">
            <label className="flex h-9 min-w-[220px] flex-[0_1_420px] items-center gap-2 rounded-control border border-border-strong bg-surface pr-2 pl-3 text-text-3 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]">
              <Search size={16} aria-hidden className="shrink-0" />
              <input
                ref={searchRef}
                type="search"
                value={searchText}
                onChange={(e) => onSearchChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchText) {
                    e.preventDefault();
                    onSearchChange('');
                  }
                }}
                placeholder={tabTotal > 0 ? `Search ${plural(tabTotal, 'tab')} by title, address or keyword` : 'Search tabs by title, address or keyword'}
                aria-label="Search saved and open tabs by title, address or keyword"
                className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {searchText ? (
                <IconButton label="Clear search" size="sm" tone="muted" onClick={() => onSearchChange('')}>
                  <X size={14} aria-hidden />
                </IconButton>
              ) : (
                <Kbd>/</Kbd>
              )}
            </label>
            <span className="flex-1" />
            <Button variant="primary" icon={<Archive size={16} aria-hidden />} onClick={saveAll}>
              Save all now
            </Button>
          </div>

          <div className="flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <LibraryNotices />
              <div className="relative min-h-0 flex-1">{view(route)}</div>
            </main>
            {wide && detail}
          </div>
        </div>
        {!wide && showDetail && (
          <div aria-hidden className="anim-in absolute inset-0 z-20 bg-overlay" onClick={() => selectSession(undefined)} />
        )}
      </div>
      {!wide && detail}
      {hosts}
    </div>
  );
}

/** Policy and storage notices above the current view. */
function LibraryNotices() {
  return (
    <div className="flex shrink-0 flex-col gap-3 px-6 empty:hidden [&>*:first-child]:mt-4">
      <GroupsUnavailableBanner />
      <StorageWarning />
    </div>
  );
}
