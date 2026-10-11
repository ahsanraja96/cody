import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppWindow, Archive, Layers, Search, Settings, X } from 'lucide-react';
import { hasPro } from '@/lib/pro/tiers';
import type { PlanState } from '@/lib/pro/types';
import type { ActiveFold, SyncStatus } from '@/lib/state';
import { Kbd } from '@/ui/components/Chips';
import { Logo } from '@/ui/components/Logo';
import { PlanChip, TrialChip, UpgradeButton } from '@/ui/components/ProBits';
import { cx } from '@/ui/cx';
import { hasFreeLimits } from '@/ui/hooks';
import { isTrialing, paidTier, trialDaysLeft } from '@/ui/pro';
import { isFolding } from './fold';
import { approxBytes, count } from './format';
import { CloudSyncLine, SyncLine } from './SyncLine';

/** What Fold offers (Min-Windows-States "Full list › Fold tabs"). */
export interface FoldMenuChoice {
  /** More than one window has tabs to fold: Fold asks. */
  ask: boolean;
  thisCount: number;
  allCount: number;
  /** Windows with tabs to fold. */
  windowCount: number;
  /** Every open window has tabs to fold, so "All 3 windows" (otherwise just "All windows"). */
  allNamed: boolean;
  onThis: () => void;
  onAll: () => void;
}

/**
 * The full list's top bar (Min-List-Windows, Up-List): logo, the wide search, the sync line,
 * "✦ Upgrade" on Free (the trial's days left while it runs), Settings and the primary "Fold tabs",
 * which asks "Just this window" or "All N windows" when several windows have tabs to fold. While a
 * fold runs the button shows its progress.
 */
export const TopBar = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQuery: (query: string) => void;
    syncStatus: SyncStatus | undefined;
    syncEnabled: boolean;
    /** The plan: a chip by the name, and on Pro the Tabfold account's sync line instead of Chrome's. */
    /** Undefined while it is being read: no chip and no sync line yet. */
    plan: PlanState | undefined;
    cloudStatus: SyncStatus | undefined;
    /** Free, over Chrome sync's 500: "Latest 500 synced · Sync all" opens the plans page. */
    onSyncAll: () => void;
    onSettings: () => void;
    /** "✦ Upgrade" and the trial chip open the plans page. */
    onUpgrade: () => void;
    /** Inside the search field while there's a query: Ask your tabs. */
    askChip?: ReactNode;
    onFold: () => void;
    fold: ActiveFold | undefined;
    candidates: { tabs: number; bytes: number };
    choice: FoldMenuChoice;
    shortcut: string;
    /** The highlighted search result, for screen readers (↑↓ move it while typing). */
    activeDescendant?: string;
  }
>(function TopBar(
  {
    query,
    onQuery,
    syncStatus,
    syncEnabled,
    plan,
    cloudStatus,
    onSyncAll,
    onSettings,
    onUpgrade,
    askChip,
    onFold,
    fold,
    candidates,
    choice,
    shortcut,
    activeDescendant,
  },
  searchRef,
) {
  const [menuOpen, setMenuOpen] = useState(false);
  const folding = isFolding(fold);
  const trialing = !!plan && isTrialing(plan) && !paidTier(plan);
  const progress = folding && fold ? (fold.phase === 'saving' ? 'Folding…' : `Folding ${Math.min(fold.closed, fold.total)} of ${fold.total}…`) : '';
  const title = choice.ask
    ? `Asks: just this window, or all ${choice.windowCount}. Pinned and playing tabs stay open.${shortcut ? ` ${shortcut}` : ''}`
    : candidates.tabs > 0
      ? `Saves and closes ${count(candidates.tabs, 'tab')}${candidates.bytes > 0 ? ` · frees ${approxBytes(candidates.bytes)}` : ''}. Pinned and playing tabs stay open.${shortcut ? ` ${shortcut}` : ''}`
      : 'Nothing to fold: only pinned, playing or new tab pages are open.';
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-8 max-[720px]:px-4">
      <div className="flex shrink-0 items-center gap-2.5 min-[1320px]:w-[236px]">
        <Logo size={28} />
        <span className="text-section font-semibold max-[720px]:sr-only">Tabfold</span>
        {plan && !trialing && <PlanChip plan={plan} className="max-[720px]:hidden" />}
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
        {query && askChip}
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
      {!plan ? null : hasPro(plan) ? (
        <CloudSyncLine status={cloudStatus} className="shrink-0 max-[860px]:hidden" />
      ) : (
        <SyncLine status={syncStatus} enabled={syncEnabled} compact onSyncAll={onSyncAll} className="shrink-0 max-[860px]:hidden" />
      )}
      <span className="w-1 shrink-0" />
      {plan && hasFreeLimits(plan) && <UpgradeButton onClick={onUpgrade} className="max-[560px]:hidden" />}
      {plan && trialing && <TrialChip days={trialDaysLeft(plan)} onClick={onUpgrade} className="max-[560px]:hidden" />}
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        onClick={onSettings}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
      >
        <Settings size={20} strokeWidth={1.75} aria-hidden />
      </button>
      <span className="relative shrink-0">
        <button
          type="button"
          onClick={() => (choice.ask ? setMenuOpen((o) => !o) : onFold())}
          disabled={folding}
          title={folding ? progress : title}
          aria-haspopup={choice.ask ? 'menu' : undefined}
          aria-expanded={choice.ask ? menuOpen : undefined}
          className={cx(
            'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold whitespace-nowrap text-on-accent',
            'hover:bg-accent-hover disabled:cursor-default disabled:opacity-90',
          )}
        >
          <Archive size={16} strokeWidth={1.75} aria-hidden className={cx(folding && 'animate-pulse')} />
          {folding ? progress : 'Fold tabs'}
        </button>
        {menuOpen && choice.ask && !folding && <FoldMenu choice={choice} onClose={() => setMenuOpen(false)} />}
      </span>
      <span role="status" className="sr-only">
        {progress}
      </span>
    </header>
  );
});

/** "Fold which windows?" under the Fold button: Just this window (first) or All N windows. */
function FoldMenu({ choice, onClose }: { choice: FoldMenuChoice; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    const away = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [onClose]);
  const item = (Icon: typeof AppWindow, label: string, tabs: number, run: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClose();
        run();
      }}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-[9px] text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-2" />
      <span className="flex-1 font-semibold">{label}</span>
      <span className="text-small text-text-3 tabular-nums">{count(tabs, 'tab')}</span>
    </button>
  );
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Fold which windows?"
      onKeyDown={(e) => {
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        } else if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="absolute top-12 right-0 z-30 w-[300px] rounded-card border border-border bg-surface p-1.5 text-text shadow-pop"
    >
      <div className="px-2 pt-1.5 pb-2 text-small font-semibold text-text-2">Fold which windows?</div>
      {item(AppWindow, 'Just this window', choice.thisCount, choice.onThis)}
      {item(Layers, choice.allNamed ? `All ${choice.windowCount} windows` : 'All windows', choice.allCount, choice.onAll)}
    </div>
  );
}
