import { useEffect, useState, type ReactNode } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { send } from '@/lib/messages';
import { hasPro, hasProAi } from '@/lib/pro/tiers';
import type { BackupInfo } from '@/lib/pro/types';
import type { SyncStatus } from '@/lib/state';
import { Chip } from '@/ui/components/ProBits';
import { toast } from '@/ui/components/Toast';
import { useAiRuns, useCloudSyncStatus, usePlan } from '@/ui/hooks';
import { daysLeftLabel, intervalName, isTrialing, longDate, openPlanPage, paidTier, runsLine, tierName, trialDaysLeft } from '@/ui/pro';
import { backupLabel } from './BackupDialog';
import { goToPlans } from './router';

const PRIMARY_SM =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-3 text-small font-semibold text-on-accent hover:bg-accent-hover';
const SECONDARY_SM =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover disabled:opacity-60';
const LINK = 'text-small font-semibold text-accent-text hover:underline';

function cloudText(status: SyncStatus | undefined): string | null {
  if (!status) return null;
  if (status.state === 'syncing') return 'Syncing with Tabfold…';
  if (status.state === 'error') return 'Couldn’t sync with Tabfold';
  if (status.state === 'off') return null;
  return `Synced with Tabfold · ${status.syncedTabs.toLocaleString()} ${status.syncedTabs === 1 ? 'tab' : 'tabs'}`;
}

function Box({ title, sub, actions }: { title: ReactNode; sub: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex items-start gap-4 rounded-card border border-border bg-bg-subtle p-4 max-[560px]:flex-col max-[560px]:gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 font-semibold">{title}</div>
        <div className="mt-1 text-small text-text-3">{sub}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5 max-[560px]:items-start">{actions}</div>
    </div>
  );
}

/**
 * Settings › Your plan (Pro-Settings, Pro-States): Free with "See Pro and Pro AI"; the Pro AI trial
 * with days left and AI runs; a paid plan with its period, end date if cancelled, AI runs, the
 * latest backup, "Manage subscription" and "Restore a backup…".
 */
export function YourPlan({ open, onRestore }: { open: boolean; onRestore: () => void }) {
  const plan = usePlan();
  const runs = useAiRuns();
  const cloud = useCloudSyncStatus();
  const [backup, setBackup] = useState<BackupInfo | null>(null);
  const [managing, setManaging] = useState(false);
  const pro = hasPro(plan);

  // The latest backup, for "Backed up today 09:12" (Pro only; quietly nothing when it can't be read).
  useEffect(() => {
    if (!open || !pro) return;
    let alive = true;
    send({ type: 'backups-list' })
      .then((list) => alive && setBackup([...list].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, pro]);

  const manage = async () => {
    setManaging(true);
    const problem = await openPlanPage({ page: 'manage' });
    setManaging(false);
    if (problem) toast(problem, { tone: 'error' });
  };

  let box: ReactNode;
  if (!pro) {
    box = (
      <Box
        title={
          <>
            Free
            <Chip tone="neutral">Your plan</Chip>
          </>
        }
        sub="Everything on this computer; your newest 500 folded tabs on your other computers."
        actions={
          <button type="button" onClick={goToPlans} className={`${PRIMARY_SM} h-8`}>
            <Sparkles size={14} strokeWidth={1.75} aria-hidden />
            See Pro and Pro AI
          </button>
        }
      />
    );
  } else {
    const paid = paidTier(plan);
    const trialing = isTrialing(plan) && paid !== 'pro-ai';
    const ai = hasProAi(plan);
    const synced = cloudText(cloud);
    const first: string[] = [];
    const second: string[] = [];
    if (trialing && paid) first.push(`Then ${tierName(paid)}${plan.interval ? ` · ${intervalName(plan.interval)}` : ''}`);
    if (paid && plan.cancelAt) first.push(`${plan.cancelAt > Date.now() ? 'Ends' : 'Ended'} ${longDate(plan.cancelAt)}`);
    if (paid && plan.status === 'past_due') first.push('The last payment didn’t go through');
    if (ai) first.push(`AI runs: ${runsLine(runs)} this month`);
    if (backup && !trialing) second.push(`Backed up ${backupLabel(backup).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())}`);
    if (synced) (trialing ? first : second).push(synced);
    box = (
      <Box
        title={
          <>
            <Sparkles size={14} strokeWidth={1.75} aria-hidden className="text-accent-text" />
            {trialing ? (
              <>
                Pro AI trial
                <Chip>{daysLeftLabel(trialDaysLeft(plan))}</Chip>
              </>
            ) : (
              `${tierName(paid ?? (ai ? 'pro-ai' : 'pro'))}${plan.interval ? ` · ${intervalName(plan.interval)}` : ''}`
            )}
          </>
        }
        sub={
          <>
            {first.join(' · ')}
            {first.length > 0 && second.length > 0 && <br />}
            {second.join(' · ')}
          </>
        }
        actions={
          <>
            {trialing && (
              <button type="button" onClick={goToPlans} className={`${PRIMARY_SM} h-7`}>
                Choose a plan
              </button>
            )}
            {paid && (
              <button type="button" disabled={managing} onClick={() => void manage()} className={SECONDARY_SM}>
                {managing && <LoaderCircle size={12} aria-hidden className="tf-spin" />}
                Manage subscription
              </button>
            )}
            {paid && (
              <button type="button" onClick={onRestore} className={LINK}>
                Restore a backup…
              </button>
            )}
          </>
        }
      />
    );
  }

  return (
    <section aria-labelledby="plan-h" className="border-b border-border py-6">
      <h2 id="plan-h" className="m-0 mb-2.5 text-body font-semibold">
        Your plan
      </h2>
      {box}
    </section>
  );
}
