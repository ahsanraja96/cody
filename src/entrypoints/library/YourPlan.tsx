import { useEffect, useState, type ReactNode } from 'react';
import { ExternalLink, LoaderCircle, LogIn, Sparkles, TriangleAlert } from 'lucide-react';
import { send } from '@/lib/messages';
import { hasPro, hasProAi } from '@/lib/pro/tiers';
import { FREE_PLAN, PRICES, type BackupInfo, type PlanState } from '@/lib/pro/types';
import type { SyncStatus } from '@/lib/state';
import { Chip } from '@/ui/components/ProBits';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { useAiRuns, useCloudSyncStatus, useLoadedPlan } from '@/ui/hooks';
import { daysLeftLabel, dollars, intervalName, isTrialing, longDate, openBilling, paidTier, runsLine, shortDate, tierName, trialDaysLeft } from '@/ui/pro';
import { openSignIn, openSignOut } from './AccountDialogs';
import { backupLabel } from './BackupDialog';
import { goToPlans } from './router';

const PRIMARY_SM =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-3 text-small font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60';
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

/** "Signed in as … · Sign out" under the plan. */
function AccountLine({ email }: { email: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-small text-text-3">
      <LogIn size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">Signed in as {email}</span>
      <button type="button" onClick={openSignOut} className={LINK}>
        Sign out
      </button>
    </div>
  );
}

function Box({
  title,
  sub,
  actions,
  email,
  tone,
}: {
  title: ReactNode;
  sub: ReactNode;
  actions: ReactNode;
  email: string | null;
  tone?: 'amber';
}) {
  return (
    <div className={cx('rounded-card border p-4', tone === 'amber' ? 'border-amber-line bg-amber-soft' : 'border-border bg-bg-subtle')}>
      <div className="flex items-start gap-4 max-[560px]:flex-col max-[560px]:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 font-semibold">{title}</div>
          <div className="mt-1 text-small text-text-3">{sub}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 max-[560px]:items-start">{actions}</div>
      </div>
      {email && <AccountLine email={email} />}
    </div>
  );
}

const sparkles = <Sparkles size={14} strokeWidth={1.75} aria-hidden className="text-accent-text" />;

/** The list price of a plan's next charge ("$84"). */
function priceOf(plan: PlanState): string | null {
  const tier = paidTier(plan);
  return tier && plan.interval ? dollars(PRICES[tier][plan.interval]) : null;
}

/**
 * Settings › Your plan (Stripe-Plan-States): Free (signed in or not, with "Already paid? Sign in"),
 * the Pro AI trial, a paid plan ("Renews … for $X", Manage billing, Restore a backup…), a payment
 * that didn't go through (Update card), a cancelled plan still on (Keep Pro AI), and who is signed
 * in, with Sign out.
 */
export function YourPlan({ open, onRestore }: { open: boolean; onRestore: () => void }) {
  const loaded = useLoadedPlan();
  const plan = loaded ?? FREE_PLAN;
  const runs = useAiRuns();
  const cloud = useCloudSyncStatus();
  const [backup, setBackup] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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

  const billing = async (key: string, flow?: 'payment-method') => {
    setBusy(key);
    const problem = await openBilling(flow);
    setBusy(null);
    if (problem) toast(problem, { tone: 'error' });
  };
  const spinner = (key: string) => busy === key && <LoaderCircle size={12} aria-hidden className="tf-spin" />;
  const external = (key: string) => spinner(key) || <ExternalLink size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />;

  const now = Date.now();
  let box: ReactNode;
  if (!loaded) {
    // Until the plan is read: the box's place, so nothing jumps.
    box = <div aria-hidden className="h-[78px] rounded-card border border-border bg-bg-subtle" />;
  } else if (!pro) {
    box = (
      <Box
        title={
          <>
            Free
            <Chip tone="neutral">Your plan</Chip>
          </>
        }
        sub={plan.email ? 'No plan on this email.' : 'Everything on this computer; your newest 500 folded tabs on your other computers.'}
        actions={
          <>
            <button type="button" onClick={goToPlans} className={`${PRIMARY_SM} h-8`}>
              <Sparkles size={14} strokeWidth={1.75} aria-hidden />
              See Pro and Pro AI
            </button>
            {!plan.email && (
              <button type="button" onClick={() => openSignIn('signin')} className={LINK}>
                Already paid? Sign in
              </button>
            )}
          </>
        }
        email={plan.email}
      />
    );
  } else {
    const paid = paidTier(plan);
    const trialing = !paid && isTrialing(plan, now);
    const ai = hasProAi(plan);
    const synced = cloudText(cloud);
    const price = priceOf(plan);
    const name = tierName(paid ?? (ai ? 'pro-ai' : 'pro'));
    const title = `${name}${plan.interval ? ` · ${intervalName(plan.interval)}` : ''}`;
    const aiRuns = ai ? `AI runs: ${runsLine(runs)} this month` : null;
    const backedUp = backup ? `Backed up ${backupLabel(backup).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())}` : null;
    const lines = (first: Array<string | null>, second: Array<string | null> = []) => {
      const a = first.filter(Boolean);
      const b = second.filter(Boolean);
      return (
        <>
          {a.join(' · ')}
          {a.length > 0 && b.length > 0 && <br />}
          {b.join(' · ')}
        </>
      );
    };

    if (trialing) {
      box = (
        <Box
          title={
            <>
              {sparkles}
              Pro AI trial
              <Chip>{daysLeftLabel(trialDaysLeft(plan, now))}</Chip>
            </>
          }
          sub={lines([`Ends ${shortDate(plan.trial!.endsAt)}`, aiRuns, synced])}
          actions={
            <button type="button" onClick={goToPlans} className={`${PRIMARY_SM} h-7`}>
              Choose a plan
            </button>
          }
          email={plan.email}
        />
      );
    } else if (plan.status === 'past_due') {
      box = (
        <Box
          tone="amber"
          title={
            <>
              <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-amber" />
              Payment didn’t go through
            </>
          }
          sub={`Stripe couldn’t take ${price ?? 'the payment'} and will try again. ${name} keeps working meanwhile; after 3 failed tries it ends.`}
          actions={
            <button type="button" disabled={busy !== null} onClick={() => void billing('card', 'payment-method')} className={`${PRIMARY_SM} h-7`}>
              {spinner('card') || <ExternalLink size={14} strokeWidth={1.75} aria-hidden />}
              Update card
            </button>
          }
          email={plan.email}
        />
      );
    } else if (plan.cancelAt && plan.cancelAt > now) {
      box = (
        <Box
          title={
            <>
              {sparkles}
              {title}
              <Chip tone="neutral">Ends {longDate(plan.cancelAt)}</Chip>
            </>
          }
          sub={`Cancelled; everything stays on until then. Your list${ai ? ', projects' : ''} and backups stay after it ends.`}
          actions={
            <button type="button" disabled={busy !== null} onClick={() => void billing('keep')} className={SECONDARY_SM}>
              {external('keep')}
              Keep {name}
            </button>
          }
          email={plan.email}
        />
      );
    } else {
      const renews = plan.renewsAt ? `Renews ${longDate(plan.renewsAt)}${price ? ` for ${price}` : ''}` : null;
      box = (
        <Box
          title={
            <>
              {sparkles}
              {title}
            </>
          }
          sub={lines([renews, aiRuns], [backedUp, synced])}
          actions={
            <>
              {paid && (
                <button type="button" disabled={busy !== null} onClick={() => void billing('manage')} className={SECONDARY_SM}>
                  {external('manage')}
                  Manage billing
                </button>
              )}
              <button type="button" onClick={onRestore} className={LINK}>
                Restore a backup…
              </button>
            </>
          }
          email={plan.email}
        />
      );
    }
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
