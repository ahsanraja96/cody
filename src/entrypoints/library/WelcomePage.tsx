import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Cloud, FolderOpen, History, LoaderCircle, LogIn, Sparkles, UserPlus, Users } from 'lucide-react';
import { send } from '@/lib/messages';
import { AI_RUNS_PER_MONTH } from '@/lib/pro/types';
import { useCloudSyncStatus, useNeedsSignIn, usePlan } from '@/ui/hooks';
import { isLifetime, paidTier, teamLine, tierName } from '@/ui/pro';
import { openSignIn } from './AccountDialogs';

/** While the payment isn't confirmed yet: ask again this often, for this long. */
const POLL_MS = 3_000;
const POLL_FOR_MS = 2 * 60_000;

function OnItem({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 border-t border-border py-3">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-text">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        <span className="block text-small text-text-3">{children}</span>
      </span>
    </li>
  );
}

/**
 * The page the Stripe checkout tab turns into after paying (Stripe-Welcome, `#/pro/welcome`):
 * "Confirming your payment" until the server has the subscription (asked every 3 s for up to 2
 * minutes; after that it says it can take a minute and Pro switches on by itself), then what is
 * now on, with "Organise my tabs" (Pro AI) and "Back to your list". Pro for life says "You’re on
 * Tabfold Pro, for life"; a Teams plan says "Your team is ready" with "Invite people". When the
 * payment went to an email that already had an account, this computer signs in with a code first.
 */
export function WelcomePage({ onBack, onOrganise, onTeam }: { onBack: () => void; onOrganise: () => void; onTeam: () => void }) {
  const plan = usePlan();
  const cloud = useCloudSyncStatus();
  const signInAs = useNeedsSignIn();
  const lifetime = isLifetime(plan);
  const team = plan.team ?? null;
  const tier = paidTier(plan);
  // Pro for life and a team count as paid even without a subscription on this account.
  const paid = tier ?? (team ? 'pro-ai' : lifetime ? 'pro' : null);
  const [slow, setSlow] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const needsSignIn = !paid && !!signInAs;

  useEffect(() => {
    // Paid, or paid on an account this computer has to sign in to: nothing more to wait for.
    if (paid || needsSignIn) return;
    const started = Date.now();
    const ask = () => void send({ type: 'plan-refresh', force: true }).catch(() => undefined);
    ask();
    const timer = setInterval(() => {
      if (Date.now() - started >= POLL_FOR_MS) {
        clearInterval(timer);
        setSlow(true);
        return;
      }
      ask();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [paid, needsSignIn]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [paid, needsSignIn]);

  const card = 'flex w-[560px] max-w-full flex-col items-center rounded-[12px] border border-border bg-surface p-8 text-center max-[560px]:p-5';

  if (needsSignIn) {
    return (
      <div className="flex justify-center px-4 pt-14 pb-10">
        <section aria-labelledby="welcome-h" className={card}>
          <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-text">
            <LogIn size={24} strokeWidth={2} />
          </span>
          <h1 id="welcome-h" ref={headingRef} tabIndex={-1} className="mt-4 mb-0 text-[22px] leading-[1.45] font-semibold outline-none">
            Sign in to switch Pro on here
          </h1>
          <p role="status" className="mt-1.5 mb-0 text-text-2">
            Your payment is on {signInAs}. Sign in with a code to use Pro on this computer.
          </p>
          <button
            type="button"
            onClick={() => openSignIn('signin', signInAs)}
            className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover"
          >
            <LogIn size={16} strokeWidth={1.75} aria-hidden />
            Sign in
          </button>
        </section>
      </div>
    );
  }

  if (!paid) {
    return (
      <div className="flex justify-center px-4 pt-14 pb-10">
        <section aria-labelledby="welcome-h" className={card}>
          <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-text">
            <LoaderCircle size={24} strokeWidth={2} className="tf-spin" />
          </span>
          <h1 id="welcome-h" ref={headingRef} tabIndex={-1} className="mt-4 mb-0 text-[22px] leading-[1.45] font-semibold outline-none">
            Confirming your payment
          </h1>
          <p role="status" className="mt-1.5 mb-0 text-text-2">
            {slow
              ? 'Stripe is taking longer than usual. It can take a minute; you can close this tab, and Pro switches on by itself.'
              : 'Stripe usually takes a few seconds. You can close this tab; Pro switches on by itself.'}
          </p>
        </section>
      </div>
    );
  }

  const ai = paid === 'pro-ai';
  const title = team ? 'Your team is ready' : lifetime && !tier ? 'You’re on Tabfold Pro, for life' : `You’re on Tabfold ${tierName(paid)}`;
  const synced = cloud?.state === 'synced' ? `${cloud.syncedTabs.toLocaleString()} ${cloud.syncedTabs === 1 ? 'tab' : 'tabs'} synced` : null;
  const account = [plan.email ? `Signed in as ${plan.email}` : null, synced, 'Chrome sync takes a rest'].filter(Boolean).join(' · ');
  const secondary =
    'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-control border border-border-strong bg-surface px-4 font-semibold text-text hover:bg-hover';
  const primary = 'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover';

  return (
    <div className="flex justify-center px-4 pt-14 pb-10">
      <section aria-labelledby="welcome-h" className={card}>
        <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-green-soft text-green">
          <Check size={24} strokeWidth={2.4} />
        </span>
        <h1 id="welcome-h" ref={headingRef} tabIndex={-1} className="mt-4 mb-0 text-[22px] leading-[1.45] font-semibold outline-none">
          {title}
        </h1>
        <p role="status" className="mt-1.5 mb-0 text-text-2">
          {plan.email ? `Thank you! Stripe has emailed your receipt to ${plan.email}.` : 'Thank you! Stripe has emailed your receipt.'}
        </p>
        <ul className="m-0 mt-6 w-full list-none p-0 text-left">
          {team && (
            <OnItem icon={<Users size={16} strokeWidth={1.75} />} title={teamLine(plan) ?? 'Your team'}>
              Everyone in it gets Pro AI. Team folders come next; invite people by email.
            </OnItem>
          )}
          {lifetime && !tier && (
            <OnItem icon={<FolderOpen size={16} strokeWidth={1.75} />} title="No limits, for life">
              Unlimited tabs, folders, snoozes and rules, live folders and sharing. One payment, no renewal.
            </OnItem>
          )}
          <OnItem icon={<Cloud size={16} strokeWidth={1.75} />} title="Every folded tab syncs with your Tabfold account">
            {account}
          </OnItem>
          <OnItem icon={<History size={16} strokeWidth={1.75} />} title="A backup every day, kept 30 days">
            Settings › Your plan › Restore a backup…
          </OnItem>
          {ai && (
            <OnItem icon={<Sparkles size={16} strokeWidth={1.75} />} title="Organise with AI">
              Puts your folded tabs into folders. {AI_RUNS_PER_MONTH} runs a month.
            </OnItem>
          )}
        </ul>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {team && team.role === 'owner' && (
            <button type="button" onClick={onTeam} className={primary}>
              <UserPlus size={16} strokeWidth={1.75} aria-hidden />
              Invite people
            </button>
          )}
          {ai && !team && (
            <button type="button" onClick={onOrganise} className={primary}>
              <Sparkles size={16} strokeWidth={1.75} aria-hidden />
              Organise my tabs
            </button>
          )}
          <button type="button" onClick={onBack} className={ai || (team && team.role === 'owner') ? secondary : primary}>
            Back to your list
          </button>
        </div>
        <p className="mt-4 mb-0 text-small text-text-3">
          {lifetime && !tier
            ? 'Your receipt and invoice are in the email from Stripe.'
            : 'Change plan, update your card or cancel anytime: Settings › Your plan › Manage billing.'}
        </p>
      </section>
    </div>
  );
}
