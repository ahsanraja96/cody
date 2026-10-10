import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { Archive, Search, X } from 'lucide-react';
import { send } from '@/lib/messages';
import { Button, IconButton } from '@/ui/components/Button';
import { Kbd } from '@/ui/components/Chips';
import { ConfirmHost } from '@/ui/components/Dialog';
import { toast, ToastViewport } from '@/ui/components/Toast';
import { useLastAction, useWorkerEvents } from '@/ui/hooks';
import { formatBytes, plural } from '@/lib/format';
import { useRoute } from './router';
import { Sidebar } from './Sidebar';
import { SessionsView } from './SessionsView';
import { SessionDetail } from './SessionDetail';
import { SearchView } from './SearchView';
import { SnapshotsView } from './SnapshotsView';
import { TrashView } from './TrashView';
import { SettingsView } from './SettingsView';
import { RestoreProgress } from './RestoreProgress';

export function LibraryApp() {
  const [route, navigate] = useRoute();
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchText, setSearchText] = useState(route.view === 'search' ? (route.query ?? '') : '');
  const [progress, setProgress] = useState<{ restoreId: string; done: number; total: number } | null>(null);
  const action = useLastAction();
  const shownAction = useRef<string | null>(null);

  // Keep the search box in sync when the route changes from outside (back button, popup link).
  useEffect(() => {
    if (route.view === 'search') setSearchText(route.query ?? '');
  }, [route.view, route.query]);

  // A save made from the popup or a shortcut shows its Undo here too, while it is still undoable.
  useEffect(() => {
    if (!action || action.undone || action.expiresAt < Date.now() || shownAction.current === action.id) return;
    shownAction.current = action.id;
    const left = Math.max(2000, action.expiresAt - Date.now());
    toast(
      action.closedTabs > 0
        ? `Saved ${plural(action.savedTabs, 'tab')} · freed ~${formatBytes(action.freedBytes)}`
        : `Saved ${plural(action.savedTabs, 'tab')} to ${action.sessionName}`,
      {
        tone: 'success',
        duration: left,
        action: { label: 'Undo', onClick: () => send({ type: 'undo', actionId: action.id }).catch(() => undefined) },
      },
    );
  }, [action]);

  useWorkerEvents((event) => {
    if (event.type === 'restore-progress') {
      setProgress(event.done >= event.total ? null : event);
    }
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onSearchChange = (value: string) => {
    setSearchText(value);
    if (value.trim()) navigate({ view: 'search', query: value, sessionId: route.sessionId }, { replace: route.view === 'search' });
    else if (route.view === 'search') navigate({ view: 'all' }, { replace: true });
  };

  const saveAll = async () => {
    try {
      const current = await browser.windows.getCurrent();
      const outcome = await send({ type: 'save', scope: 'all', close: true, windowId: current.id, audible: 'keep' });
      if (outcome.savedTabs === 0) toast('Nothing to save: only pinned, blank or Tabfold tabs are open.');
      else if (outcome.keptOpen.audible) toast(`${plural(outcome.keptOpen.audible, 'tab')} playing audio stayed open.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Saving failed.', { tone: 'error' });
    }
  };

  const selectSession = (sessionId: string | undefined) => navigate({ ...route, sessionId }, { replace: true });
  const showDetail = !!route.sessionId && route.view !== 'settings' && route.view !== 'snapshots';

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text">
      <Sidebar route={route} navigate={navigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-14 flex-wrap items-center gap-2.5 border-b border-border px-6 py-2.5">
          <label className="flex h-9 min-w-[220px] flex-[0_1_440px] items-center gap-2 rounded-control border border-border-strong bg-surface pr-2 pl-3 text-text-3 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]">
            <Search size={16} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={searchText}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onSearchChange('');
              }}
              placeholder="Search tabs by title, address or keyword"
              aria-label="Search saved tabs by title, address or keyword"
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
          <main className="min-w-0 flex-1 overflow-hidden">
            {route.view === 'settings' ? (
              <SettingsView section={route.section} />
            ) : route.view === 'snapshots' ? (
              <SnapshotsView />
            ) : route.view === 'trash' ? (
              <TrashView selectedId={route.sessionId} onSelect={selectSession} />
            ) : route.view === 'search' ? (
              <SearchView query={route.query ?? ''} selectedId={route.sessionId} onSelect={selectSession} />
            ) : (
              <SessionsView route={route} navigate={navigate} onSaveAll={saveAll} />
            )}
          </main>
          {showDetail && route.sessionId && (
            <SessionDetail
              key={route.sessionId}
              sessionId={route.sessionId}
              highlightQuery={route.view === 'search' ? route.query : undefined}
              onClose={() => selectSession(undefined)}
            />
          )}
        </div>
      </div>
      {progress && <RestoreProgress {...progress} onCancel={() => send({ type: 'cancel-restore', restoreId: progress.restoreId })} />}
      <ToastViewport />
      <ConfirmHost />
    </div>
  );
}
