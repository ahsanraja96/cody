import { useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { CircleAlert, Info, RefreshCw, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { acknowledgeWipe, checkWiped } from '@/lib/dataGuard';
import { send } from '@/lib/messages';
import { planEnded } from '@/lib/pro/state';
import type { ActiveFold } from '@/lib/state';
import { toast } from '@/ui/components/Toast';
import { currentScreen, useLoadedPlan, usePlanEnded, useRecoveryOffer, useUpdateReady } from '@/ui/hooks';
import { tierName } from '@/ui/pro';
import { errorText } from './actions';
import { startFold, useFoldError } from './fold';
import { count, foldTime } from './format';
import { goToPlans } from './router';

const PRIMARY_SM =
  'inline-flex h-7 shrink-0 items-center justify-center rounded-control bg-accent px-3 text-small font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60';
const SECONDARY_SM =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover';

function DismissButton({ onClick, label = 'Dismiss' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
    >
      <X size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** One quiet line (Min-States): an icon, what happened, and what to do next. */
function Line({ icon, children, actions, role = 'status' }: { icon: ReactNode; children: ReactNode; actions: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div role={role} className="flex items-center gap-2.5 rounded-card border border-border bg-bg-subtle py-2 pr-1.5 pl-3">
      <span className="flex shrink-0 text-text-2">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {actions}
    </div>
  );
}

/** "Tabfold was updated · Reload": the page lost its link to the new background until it reloads. */
function UpdateLine() {
  const update = useUpdateReady();
  if (!update) return null;
  return (
    <Line
      icon={<RefreshCw size={16} strokeWidth={1.75} aria-hidden />}
      actions={
        <button
          type="button"
          className={PRIMARY_SM}
          onClick={() => {
            try {
              browser.runtime.reload();
            } catch {
              location.reload();
            }
          }}
        >
          Reload
        </button>
      }
    >
      Tabfold was updated. Reload to keep going.
    </Line>
  );
}

/** After a crash: "Chrome closed unexpectedly. Reopen your 52 tabs?" (shown until Reopen or ×). */
function CrashLine() {
  const offer = useRecoveryOffer();
  const [busy, setBusy] = useState(false);
  if (!offer) return null;
  const reopen = async () => {
    setBusy(true);
    try {
      const current = await browser.windows.getCurrent().catch(() => undefined);
      const outcome = await send({ type: 'restore-snapshot', snapshotId: offer.snapshotId, mode: 'original', currentWindowId: current?.id, screen: currentScreen() });
      await send({ type: 'dismiss-recovery' }).catch(() => undefined);
      if (outcome.failed.length) toast(`Reopened ${outcome.opened} of ${outcome.opened + outcome.failed.length} tabs.`);
    } catch (error) {
      toast(errorText(error), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Line
      role="alert"
      icon={<RotateCcw size={16} strokeWidth={1.75} aria-hidden />}
      actions={
        <>
          <button type="button" className={PRIMARY_SM} disabled={busy} onClick={() => void reopen()}>
            Reopen
          </button>
          <DismissButton onClick={() => void send({ type: 'dismiss-recovery' }).catch(() => undefined)} />
        </>
      }
    >
      Chrome closed unexpectedly. Reopen your {count(offer.tabCount, 'tab')}?
    </Line>
  );
}

/**
 * Chrome's site data for Tabfold was cleared (the list is empty but Tabfold's own record outside
 * the database remembers folds): offer the copy of the last snapshot kept for this.
 */
function WipedLine({ onImport }: { onImport: () => void }) {
  const [key, setKey] = useState(0);
  const check = useLiveQuery(() => checkWiped(), [key]);
  const [busy, setBusy] = useState(false);
  if (!check?.wiped) return null;
  const mirror = check.mirror;
  const restore = async () => {
    setBusy(true);
    try {
      const { sessionId } = await send({ type: 'recover-from-mirror' });
      if (!sessionId) {
        toast('Couldn’t restore the snapshot. Import a backup file instead.', { tone: 'error' });
        return;
      }
      await acknowledgeWipe();
      setKey((k) => k + 1);
      toast(`Restored ${count(mirror?.tabCount ?? 0, 'tab')} from the last snapshot.`);
    } catch (error) {
      toast(errorText(error), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Line
      role="alert"
      icon={<TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="text-amber" />}
      actions={
        <>
          {mirror ? (
            <button type="button" className={PRIMARY_SM} disabled={busy} onClick={() => void restore()}>
              Restore last snapshot
            </button>
          ) : (
            <button type="button" className={SECONDARY_SM} onClick={onImport}>
              Import a file…
            </button>
          )}
          <DismissButton
            onClick={async () => {
              await acknowledgeWipe();
              setKey((k) => k + 1);
            }}
          />
        </>
      }
    >
      {mirror ? (
        <>
          Chrome cleared Tabfold’s data.{' '}
          <span className="text-text-2" title={`Snapshot from ${foldTime(mirror.createdAt)}`}>
            Your last snapshot has {count(mirror.tabCount, 'tab')}.
          </span>
        </>
      ) : (
        'Chrome cleared Tabfold’s data, so your folded tabs are gone from this computer.'
      )}
    </Line>
  );
}

/** A page is showing Chrome's "Leave site?" dialog during a fold. The tab is saved either way. */
function LeaveSiteLine({ fold }: { fold: ActiveFold | undefined }) {
  if (fold?.phase !== 'waiting' || fold.waiting.length === 0) return null;
  const first = fold.waiting[0]!;
  const show = async () => {
    await browser.tabs.update(first.tabId, { active: true }).catch(() => undefined);
    await browser.windows.update(first.windowId, { focused: true }).catch(() => undefined);
  };
  return (
    <Line
      icon={<CircleAlert size={16} strokeWidth={1.75} aria-hidden />}
      actions={
        <button type="button" className={SECONDARY_SM} onClick={() => void show()}>
          Show tab
        </button>
      }
    >
      {fold.waiting.length === 1 ? (
        <>
          <span dir="auto">{first.title || 'A page'}</span> is asking “Leave site?” in its tab. It’s saved either way.
        </>
      ) : (
        `${fold.waiting.length} tabs are asking “Leave site?”. They’re saved either way.`
      )}
    </Line>
  );
}

/** Couldn't fold (Min-States "Fold failed · storage full"): tabs close only after they are saved. */
function FoldFailedLine() {
  const { error, set } = useFoldError();
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-col gap-2.5 rounded-card border border-red-line bg-red-soft px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <CircleAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-red" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-red">Couldn’t fold. Nothing was closed.</div>
          <div className="text-small text-text-2">
            {error.quota ? 'Chrome is out of storage space. Free up some disk space, then try again.' : error.message}
          </div>
        </div>
        <DismissButton onClick={() => set(null)} />
      </div>
      <div className="pl-[26px]">
        <button type="button" className={SECONDARY_SM} onClick={() => void startFold()}>
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * "Your Pro AI trial has ended" (Pro-States "Plan ended"): once, at the top of the list. Nothing is
 * deleted or locked; only new AI runs and syncing past 500 stop.
 */
const TIER_RANK = { free: 0, pro: 1, 'pro-ai': 2 } as const;

function PlanEndedLine() {
  const ended = usePlanEnded();
  const plan = useLoadedPlan();
  // Nothing until the plan is read, and nothing once a plan at least as good is back.
  if (!ended || !plan || TIER_RANK[plan.tier] >= TIER_RANK[ended.tier]) return null;
  const title = ended.wasTrial ? 'Your Pro AI trial has ended' : `Your ${tierName(ended.tier)} plan has ended`;
  const detail =
    ended.tier === 'pro-ai' || ended.wasTrial
      ? 'Your list, projects and backups stay. Organising with AI and syncing more than 500 tabs are paused.'
      : 'Your list and backups stay. Syncing more than 500 tabs is paused.';
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-card border border-border bg-bg-subtle py-3 pr-2 pl-3.5">
      <Info size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-text-2" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="text-small text-text-2">{detail}</div>
      </div>
      <button type="button" className={PRIMARY_SM} onClick={goToPlans}>
        Choose a plan
      </button>
      <DismissButton onClick={() => void planEnded.set(null).catch(() => undefined)} />
    </div>
  );
}

/** The small states at the top of the full list, newest concern first. Nothing when all is well. */
export function Notices({ fold, onImport }: { fold: ActiveFold | undefined; onImport: () => void }) {
  return (
    <div className="flex flex-col gap-3 empty:hidden [&:not(:empty)]:mb-6">
      <UpdateLine />
      <FoldFailedLine />
      <LeaveSiteLine fold={fold} />
      <CrashLine />
      <WipedLine onImport={onImport} />
      <PlanEndedLine />
    </div>
  );
}
