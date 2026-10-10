import { useEffect, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { send } from '@/lib/messages';
import { openLibrary } from '@/lib/openLibrary';
import { dismissMilestone, milestoneDue } from '@/lib/pro/milestone';
import { milestoneState, planState } from '@/lib/pro/state';
import { useMilestoneState } from '@/ui/hooks';
import { PLANS_HASH } from '@/ui/pro';
import type { FoldView } from './popupHooks';

const GB = 1024 ** 3;

/**
 * "You've freed 12.4 GB with Tabfold this month" after a fold (Pro-Popup-Milestone), when
 * `milestoneDue` says so: Free only, after a fold that freed something, at most once a week, never
 * in the first 3 days or for 30 days after "Not now". Showing it records `lastShownAt`; it then
 * stays for this fold. Nothing is read before the fold finishes, so the popup opens as fast as ever.
 */
export function useFoldMilestone(view: FoldView): { freedBytes: number; dismiss: () => void } | null {
  const state = useMilestoneState();
  const done = view.kind === 'done' ? view.fold : null;
  const foldId = done?.foldId;
  const freed = done?.outcome?.freedBytes ?? 0;
  const [shown, setShown] = useState<{ foldId: string; freedBytes: number } | null>(null);
  const claimed = useRef<string | null>(null);

  useEffect(() => {
    if (!foldId || freed <= 0 || !state || claimed.current === foldId) return;
    let alive = true;
    // The stored plan, not the page's default: a Pro plan still loading must not count as Free.
    planState
      .get()
      .then((plan) => {
        if (!alive || claimed.current === foldId) return;
        const now = Date.now();
        const due = milestoneDue(state, plan, now);
        if (!due) return;
        claimed.current = foldId;
        setShown({ foldId, freedBytes: due.freedBytes });
        void milestoneState.set({ ...state, lastShownAt: now }).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [foldId, freed, state]);

  if (!shown || shown.foldId !== foldId) return null;
  return {
    freedBytes: shown.freedBytes,
    dismiss: () => {
      setShown(null);
      send({ type: 'milestone-dismiss' }).catch(async () => {
        // The worker couldn't take it: keep "Not now" anyway, the same way it would.
        const current = await milestoneState.get();
        if (current) await milestoneState.set(dismissMilestone(current, Date.now()));
      });
    },
  };
}

export function MilestoneCard({ freedBytes, onDismiss }: { freedBytes: number; onDismiss: () => void }) {
  return (
    <div role="note" className="mt-3.5 flex items-start gap-2.5 rounded-card border border-accent-line bg-accent-soft py-2.5 pr-1.5 pl-3">
      <Sparkles size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 flex-none text-accent-text" />
      <div className="min-w-0 flex-1 text-small text-text-2">
        <div className="font-semibold text-text">You’ve freed {(freedBytes / GB).toFixed(1)} GB with Tabfold this month</div>
        Pro keeps every folded tab synced and backed up.{' '}
        <a
          href={PLANS_HASH}
          onClick={(e) => {
            e.preventDefault();
            void openLibrary(PLANS_HASH).finally(() => window.close());
          }}
          className="font-semibold no-underline hover:underline"
        >
          See Pro
        </a>
      </div>
      <button
        type="button"
        aria-label="Not now"
        title="Not now"
        onClick={onDismiss}
        className="flex size-6 flex-none items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
