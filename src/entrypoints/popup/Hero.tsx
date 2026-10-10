import { useRef, useState, type ReactNode } from 'react';
import { Archive, CircleAlert, MemoryStick, RotateCcw } from 'lucide-react';
import { send } from '@/lib/messages';
import type { ActiveFold } from '@/lib/state';
import { Favicon } from '@/ui/components/Favicon';
import { BigNumber, formatGb, FreedNumber, MemoryCapsule, type TabKind } from '@/ui/components/MemoryCapsule';
import { cx } from '@/ui/cx';
import { useLastAction, useNow } from '@/ui/hooks';
import { showTab, siteLabel, type FoldView, type OpenTabStats } from './popupHooks';

/**
 * The top of the popup: memory in use with the capsule and the Fold button (Min-Popup), the fold
 * in progress (Min-Popup-Folding), the result with Undo (Min-Popup-Folded) and a failed fold
 * (Min-States).
 */

const GB = 1024 ** 3;

function HeroHead({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">{left}</div>
      <div className="flex-none text-right">{right}</div>
    </div>
  );
}

function Caps({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('text-meta font-semibold tracking-[.08em] text-text-3 uppercase', className)}>{children}</div>;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function FoldButton({
  count,
  ready,
  shortcut,
  onFold,
  noted = true,
  className,
}: {
  count: number;
  /** The open tabs have been read. */
  ready: boolean;
  shortcut: string;
  onFold: () => void;
  /** A note under the button explains it. */
  noted?: boolean;
  className?: string;
}) {
  const describedBy = noted ? 'fold-note' : undefined;
  if (ready && count === 0) {
    return (
      <button
        type="button"
        disabled
        aria-describedby={describedBy}
        className={cx(
          'flex h-11 w-full items-center justify-center gap-2 rounded-control bg-hover px-4 font-semibold text-text-3',
          className,
        )}
      >
        <Archive size={16} strokeWidth={1.75} aria-hidden />
        Nothing to fold
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onFold}
      disabled={!ready}
      title="Saves every open tab to your list, then closes it"
      aria-describedby={describedBy}
      className={cx(
        'relative flex h-11 w-full items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold text-on-accent transition-colors hover:bg-accent-hover',
        className,
      )}
    >
      <Archive size={16} strokeWidth={1.75} aria-hidden />
      {ready ? `Fold ${plural(count, 'tab')}` : 'Fold tabs'}
      {shortcut && (
        <span
          aria-hidden="true"
          className={cx('absolute right-3.5 text-meta font-normal opacity-85', shortcut.length > 6 && 'max-[340px]:hidden')}
        >
          {shortcut}
        </span>
      )}
    </button>
  );
}

function FoldNote({ children }: { children: ReactNode }) {
  return (
    <p id="fold-note" className="mt-2.5 text-small text-text-3">
      {children}
    </p>
  );
}

function capsuleLabel(stats: OpenTabStats): string {
  const loaded = stats.tabs.length - stats.sleeping;
  return `Memory in use: ${plural(loaded, 'loaded tab')} and ${plural(stats.sleeping, 'sleeping tab')}, about ${formatGb(stats.inUseBytes)} GB`;
}

function InUseHead({ stats, ready }: { stats: OpenTabStats; ready: boolean }) {
  return (
    <HeroHead
      left={
        <>
          <BigNumber value={formatGb(stats.inUseBytes)} className={ready ? undefined : 'invisible'} />
          <Caps className="mt-2">In use · estimate</Caps>
        </>
      }
      right={
        ready && (
          <span className="text-small text-text-2 tabular-nums">
            {plural(stats.tabs.length, 'tab')} open
            {stats.sleeping > 0 && ` · ${stats.sleeping.toLocaleString()} sleeping`}
          </span>
        )
      }
    />
  );
}

export function Hero({
  view,
  stats,
  ready,
  shortcut,
  onFold,
}: {
  view: FoldView;
  stats: OpenTabStats;
  ready: boolean;
  shortcut: string;
  onFold: () => void;
}) {
  // The last "freed so far" shown, so the finished number rolls up from it.
  const freedSoFar = useRef(0);
  const foldCount = stats.foldable.length;

  if (view.kind === 'folding') {
    const { fold } = view;
    return <Folding fold={fold} stats={stats} freedSoFar={freedSoFar} />;
  }
  if (view.kind === 'done') {
    return (
      <Folded
        fold={view.fold}
        stats={stats}
        rollFrom={view.seenRunning ? freedSoFar.current : undefined}
        button={
          <FoldButton
            className="mt-3.5"
            count={foldCount}
            ready={ready}
            shortcut={shortcut}
            onFold={onFold}
            noted={!!stayedLine(view.fold)}
          />
        }
      />
    );
  }

  return (
    <section aria-label="Memory and Fold" className="flex flex-none flex-col px-4 pt-1 pb-5">
      <InUseHead stats={stats} ready={ready} />
      <MemoryCapsule className="mt-3.5" stayed={stats.kinds} label={capsuleLabel(stats)} />
      {view.kind === 'failed' ? (
        <FoldFailed error={view.fold.error} onRetry={onFold} />
      ) : (
        <>
          <FoldButton className="mt-4" count={foldCount} ready={ready} shortcut={shortcut} onFold={onFold} />
          <FoldNote>
            {ready && foldCount === 0
              ? 'Only pinned and playing tabs are open.'
              : 'Saves and closes them. Pinned and playing tabs stay open.'}
          </FoldNote>
        </>
      )}
    </section>
  );
}

function Folding({
  fold,
  stats,
  freedSoFar,
}: {
  fold: ActiveFold;
  stats: OpenTabStats;
  freedSoFar: React.MutableRefObject<number>;
}) {
  const total = Math.max(fold.total, 0);
  // Tabs still open that the fold will close; with progress not reported yet, closed tabs count as closed.
  const stillOpen = stats.foldableKinds.slice(0, total);
  const closed = Math.max(0, Math.min(total, Math.max(fold.closed, total - stillOpen.length)));
  const pending: TabKind[] = stillOpen.slice(0, total - closed);
  while (pending.length < total - closed) pending.push('loaded');
  const freed = closed * stats.bytesPerFoldedTab;
  freedSoFar.current = freed;
  const waiting = fold.phase === 'waiting' ? fold.waiting : [];
  return (
    <section aria-label="Folding your tabs" className="flex flex-none flex-col px-4 pt-1 pb-5">
      <HeroHead
        left={
          <>
            <BigNumber value={formatGb(freed)} />
            <Caps className="mt-2">Freed so far · estimate</Caps>
          </>
        }
        right={
          <div role="status">
            <div className="font-semibold">Folding…</div>
            <div className="text-small text-text-2 tabular-nums">
              {closed.toLocaleString()} of {total.toLocaleString()} closed
            </div>
          </div>
        }
      />
      <MemoryCapsule
        className="mt-3.5"
        stayed={stats.stayedKinds}
        freed={closed}
        pending={pending}
        fill={total ? closed / total : 0}
        active
        progress={{ now: closed, max: total }}
        label={`Folding tabs: ${closed} of ${total} closed, about ${formatGb(freed)} GB freed so far`}
      />
      {waiting.length > 0 && <LeaveSite waiting={waiting} />}
    </section>
  );
}

function LeaveSite({ waiting }: { waiting: ActiveFold['waiting'] }) {
  const first = waiting[0]!;
  const name = siteLabel(first);
  const text =
    waiting.length === 1
      ? `${name} is asking “Leave site?” in its tab. It’s saved either way.`
      : `${name} and ${plural(waiting.length - 1, 'other tab')} are asking “Leave site?”. They’re saved either way.`;
  return (
    <div role="status" className="mt-4 flex items-start gap-2.5 rounded-card border border-border bg-bg-subtle py-2.5 pr-2.5 pl-3">
      <span className="flex-none pt-0.5">
        <Favicon url={first.url} size={16} />
      </span>
      <p dir="auto" className="min-w-0 flex-1 text-small text-text-2">
        {text}
      </p>
      <button
        type="button"
        onClick={() => showTab(first.tabId, first.windowId)}
        title={`Switches to the ${name} tab so you can answer`}
        className="inline-flex h-[26px] flex-none items-center rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold hover:bg-hover"
      >
        Show tab
      </button>
    </div>
  );
}

function stayedLine(fold: ActiveFold): string | null {
  const outcome = fold.outcome;
  if (!outcome) return null;
  const pinned = outcome.stayedOpen?.pinned ?? outcome.keptOpen.pinned;
  const audible = outcome.stayedOpen?.audible ?? outcome.keptOpen.audible;
  const asking = outcome.failedToClose.length;
  const parts = [
    pinned > 0 && `${pinned} pinned`,
    audible > 0 && `${audible} playing sound`,
    asking > 0 && `${asking} still asking “Leave site?”`,
  ].filter(Boolean);
  const count = pinned + audible + asking;
  return count ? `${count} stayed open: ${parts.join(', ')}` : null;
}

function Folded({
  fold,
  stats,
  rollFrom,
  button,
}: {
  fold: ActiveFold;
  stats: OpenTabStats;
  rollFrom?: number;
  button: ReactNode;
}) {
  const outcome = fold.outcome;
  const folded = Math.max(0, fold.total);
  const freedSlots = Math.max(0, Math.min(fold.closed || folded, folded));
  const freedBytes = outcome?.freedBytes ?? freedSlots * stats.bytesPerFoldedTab;
  const memory = outcome?.memory;
  const note = stayedLine(fold);
  return (
    <section role="status" aria-label="Fold finished" className="flex flex-none flex-col px-4 pt-1 pb-5">
      <HeroHead
        left={
          <>
            <FreedNumber bytes={freedBytes} fromBytes={rollFrom} />
            <Caps className="mt-2.5 ml-[38px]">Folded {plural(folded, 'tab')} · estimate</Caps>
          </>
        }
        right={outcome?.actionId ? <UndoFold actionId={outcome.actionId} /> : null}
      />
      <MemoryCapsule
        className="mt-3.5"
        stayed={stats.kinds}
        freed={freedSlots}
        fill={1}
        label={`Memory: ${plural(freedSlots, 'tab')} freed, ${plural(stats.tabs.length, 'tab')} still open`}
      />
      {memory?.freeAfter != null && (
        <p className="mt-3 flex items-center gap-2 text-small text-text-2 tabular-nums">
          <MemoryStick size={14} strokeWidth={1.75} aria-hidden className="flex-none text-text-3" />
          <span>
            Your computer: <span className="font-semibold text-text">{(memory.freeAfter / GB).toFixed(1)} GB free</span>
            {memory.freeBefore != null && ` (was ${(memory.freeBefore / GB).toFixed(1)})`}
          </span>
        </p>
      )}
      {button}
      {note && <FoldNote>{note}</FoldNote>}
    </section>
  );
}

/** "Undo · 8s" while the fold can still be undone (the countdown follows lastAction.expiresAt). */
function UndoFold({ actionId }: { actionId: string }) {
  const action = useLastAction();
  const [busy, setBusy] = useState(false);
  const live = !!action && action.id === actionId && !action.undone;
  const now = useNow(live, 250);
  if (!live || now >= action.expiresAt) return null;
  const seconds = Math.max(1, Math.ceil((action.expiresAt - now) / 1000));
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={`Undo fold, ${seconds} seconds left`}
      onClick={() => {
        setBusy(true);
        send({ type: 'undo', actionId })
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
      className="inline-flex h-7 flex-none items-center gap-[5px] rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover disabled:opacity-60"
    >
      <RotateCcw size={14} strokeWidth={2} aria-hidden className="text-text-2" />
      Undo
      <span className="font-normal text-text-3 tabular-nums">· {seconds}s</span>
    </button>
  );
}

function failureDetail(error: string | undefined): string | null {
  if (!error) return null;
  if (/storage|quota|disk/i.test(error)) return 'Chrome is out of storage space. Free up some disk space, then try again.';
  const detail = error.replace(/\s*Nothing was closed\.?\s*$/i, '').trim();
  return detail || null;
}

function FoldFailed({ error, onRetry }: { error?: string; onRetry: () => void }) {
  const detail = failureDetail(error);
  return (
    <div role="alert" className="mt-4 flex flex-col gap-2.5 rounded-card border border-red-line bg-red-soft px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <CircleAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 flex-none text-red" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-red">Couldn’t fold. Nothing was closed.</div>
          {detail && <div className="text-small text-text-2">{detail}</div>}
        </div>
      </div>
      <div className="pl-[26px]">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-7 items-center rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold hover:bg-hover"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
