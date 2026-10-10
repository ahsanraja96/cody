import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { Layers, Search, Settings as SettingsIcon, X } from 'lucide-react';
import { CURRENT_PLAN } from '@/lib/limits';
import { openLibrary } from '@/lib/openLibrary';
import { pendingKeywordSave } from '@/lib/state';
import { IconButton } from '@/ui/components/Button';
import { Kbd, PlanBadge } from '@/ui/components/Chips';
import { Logo } from '@/ui/components/Logo';
import { modKey, useOpenWindows } from '@/ui/hooks';
import { Home } from './Home';
import { KeywordSave } from './KeywordSave';
import { SearchResults, type SearchNav } from './SearchResults';

type View = { kind: 'home' } | { kind: 'keywords'; tabIds: number[] };

const PENDING_MAX_AGE_MS = 60_000;

export function PopupApp() {
  const { windows, loaded } = useOpenWindows();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ kind: 'home' });
  const [currentWindowId, setCurrentWindowId] = useState<number>();
  const inputRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<SearchNav | null>(null);
  const searching = query.trim().length > 0;

  useEffect(() => {
    const asWindow = document.documentElement.dataset.mode === 'window';
    const lookup = asWindow
      ? browser.windows.getLastFocused({ windowTypes: ['normal'] })
      : browser.windows.getCurrent();
    lookup.then((w) => setCurrentWindowId(w.id)).catch(() => undefined);
    pendingKeywordSave.get().then((pending) => {
      if (pending && Date.now() - pending.at < PENDING_MAX_AGE_MS && pending.tabIds.length) {
        setView({ kind: 'keywords', tabIds: pending.tabIds });
      }
      if (pending) pendingKeywordSave.set(null);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (view.kind === 'keywords') {
    return <KeywordSave tabIds={view.tabIds} windows={windows} onBack={() => setView({ kind: 'home' })} />;
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className={`flex shrink-0 items-center gap-1.5 px-3 pt-3 pb-2.5 ${searching ? 'border-b border-border' : ''}`}>
        <Logo size={24} />
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control border border-border-strong bg-surface pr-1 pl-2.5 text-text-3 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]">
          <Search size={16} aria-hidden className="shrink-0" />
          <input
            ref={inputRef}
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                navRef.current?.move(1);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                navRef.current?.move(-1);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                navRef.current?.open(e.metaKey || e.ctrlKey);
              } else if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }}
            placeholder="Search tabs and keywords"
            aria-label="Search open and saved tabs by title, address or keyword"
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <IconButton label="Clear search" size="sm" tone="muted" onClick={() => setQuery('')}>
              <X size={14} aria-hidden />
            </IconButton>
          )}
        </label>
        <IconButton
          label="Settings"
          size="lg"
          onClick={() => {
            openLibrary('#/settings');
            window.close();
          }}
        >
          <SettingsIcon size={20} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </header>

      {searching ? (
        <SearchResults query={query} windows={windows} navRef={navRef} onClear={() => setQuery('')} />
      ) : (
        <Home
          windows={windows}
          loaded={loaded}
          currentWindowId={currentWindowId}
          onAskKeywords={(tabIds) => setView({ kind: 'keywords', tabIds })}
        />
      )}

      <footer className="flex h-11 shrink-0 items-center justify-between gap-3 border-t border-border bg-bg-subtle px-3">
        {searching ? (
          <span className="flex items-center gap-3 text-meta text-text-3">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> Move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> Open
            </span>
            <span className="flex items-center gap-1">
              <Kbd>{modKey}↵</Kbd> Background
            </span>
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> Clear
            </span>
          </span>
        ) : (
          <>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 font-semibold text-accent-text hover:underline"
              onClick={() => {
                openLibrary();
                window.close();
              }}
            >
              <Layers size={16} aria-hidden />
              Open library
            </button>
            <PlanBadge plan={CURRENT_PLAN} />
          </>
        )}
      </footer>
    </div>
  );
}
