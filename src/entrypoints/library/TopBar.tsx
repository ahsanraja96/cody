import { forwardRef } from 'react';
import { Archive, Search, Settings, X } from 'lucide-react';
import type { ActiveFold, SyncStatus } from '@/lib/state';
import { Kbd } from '@/ui/components/Chips';
import { Logo } from '@/ui/components/Logo';
import { cx } from '@/ui/cx';
import { isFolding } from './fold';
import { approxBytes, count } from './format';
import { SyncLine } from './SyncLine';

/**
 * The full list's top bar (Min-List): logo, the wide search, the sync line, Settings and the
 * primary "Fold all tabs". While a fold runs the button shows its progress.
 */
export const TopBar = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQuery: (query: string) => void;
    syncStatus: SyncStatus | undefined;
    syncEnabled: boolean;
    onSettings: () => void;
    onFold: () => void;
    fold: ActiveFold | undefined;
    candidates: { tabs: number; bytes: number };
    shortcut: string;
    /** The highlighted search result, for screen readers (↑↓ move it while typing). */
    activeDescendant?: string;
  }
>(function TopBar({ query, onQuery, syncStatus, syncEnabled, onSettings, onFold, fold, candidates, shortcut, activeDescendant }, searchRef) {
  const folding = isFolding(fold);
  const progress = folding && fold ? (fold.phase === 'saving' ? 'Folding…' : `Folding ${Math.min(fold.closed, fold.total)} of ${fold.total}…`) : '';
  const title =
    candidates.tabs > 0
      ? `Saves and closes ${count(candidates.tabs, 'tab')}${candidates.bytes > 0 ? ` · frees ${approxBytes(candidates.bytes)}` : ''}. Pinned and playing tabs stay open.${shortcut ? ` ${shortcut}` : ''}`
      : 'Nothing to fold: only pinned, playing or new tab pages are open.';
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-8 max-[720px]:px-4">
      <div className="flex shrink-0 items-center gap-2.5 min-[1320px]:w-[236px]">
        <Logo size={28} />
        <span className="text-section font-semibold max-[720px]:sr-only">Tabfold</span>
      </div>
      <label
        className={cx(
          'flex h-10 min-w-[200px] flex-[0_1_560px] items-center gap-2.5 rounded-control border border-border-strong bg-surface pr-2.5 pl-3 text-text-3',
          'focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]',
        )}
      >
        <Search size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              e.stopPropagation();
              onQuery('');
            }
          }}
          placeholder="Search open and folded tabs"
          aria-controls={query ? 'search-results' : undefined}
          aria-activedescendant={activeDescendant}
          aria-label="Search open and folded tabs by title, address or keyword"
          className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => onQuery('')}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        ) : (
          <Kbd className="px-[5px]">/</Kbd>
        )}
      </label>
      <span className="min-w-0 flex-1" />
      <SyncLine status={syncStatus} enabled={syncEnabled} compact className="shrink-0 max-[860px]:hidden" />
      <span className="w-1 shrink-0" />
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        onClick={onSettings}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
      >
        <Settings size={20} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onFold}
        disabled={folding}
        title={folding ? progress : title}
        className={cx(
          'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold whitespace-nowrap text-on-accent',
          'hover:bg-accent-hover disabled:cursor-default disabled:opacity-90',
        )}
      >
        <Archive size={16} strokeWidth={1.75} aria-hidden className={cx(folding && 'animate-pulse')} />
        {folding ? progress : 'Fold all tabs'}
      </button>
      <span role="status" className="sr-only">
        {progress}
      </span>
    </header>
  );
});
