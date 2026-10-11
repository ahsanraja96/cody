import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ExternalLink, Info, LoaderCircle, LogIn, ShieldCheck, Sparkles } from 'lucide-react';
import { proConfigured } from '@/lib/pro/config';
import { AI_RUNS_PER_MONTH, PRICES, TRIAL_DAYS, type BillingInterval, type Tier } from '@/lib/pro/types';
import { Chip } from '@/ui/components/ProBits';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { useCheckout, useNeedsSignIn, usePlan } from '@/ui/hooks';
import {
  bestYearlySaving,
  daysLeftLabel,
  dollars,
  focusCheckout,
  isTrialing,
  openBilling,
  openCheckout,
  paidTier,
  shortDate,
  trialDaysLeft,
  trialUsed,
} from '@/ui/pro';
import { openSignIn, startTrialFlow } from './AccountDialogs';

type PaidTier = Exclude<Tier, 'free'>;

const BTN = 'flex h-10 w-full items-center justify-center gap-2 rounded-control px-4 font-semibold disabled:cursor-default';
const BUTTONS = {
  primary: `${BTN} bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent`,
  soft: `${BTN} border border-accent-line bg-accent-soft text-accent-text hover:brightness-95 disabled:opacity-50 disabled:hover:brightness-100`,
  /** "Waiting for Stripe…": the soft button, not faded. */
  busy: `${BTN} border border-accent-line bg-accent-soft text-accent-text`,
  off: `${BTN} border border-border-strong bg-surface text-text-3`,
};

/** Less than this left in the trial: Stripe charges at once ("You’ll be charged today"); the server's rule. */
const TRIAL_BILLING_MIN_MS = 48 * 60 * 60 * 1000 + 5 * 60 * 1000;

function Feature({ children, shield = false }: { children: ReactNode; shield?: boolean }) {
  return (
    <li className="flex items-start gap-2.5">
      {shield ? (
        <ShieldCheck size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-text-3" />
      ) : (
        <Check size={16} strokeWidth={2} aria-hidden className="mt-0.5 shrink-0 text-green" />
      )}
      <span>{children}</span>
    </li>
  );
}

function PlanCard({
  id,
  name,
  icon,
  badge,
  tagline,
  price,
  unit,
  sub,
  action,
  lead,
  children,
  highlight = false,
  current = false,
}: {
  id: string;
  name: string;
  icon?: ReactNode;
  badge?: ReactNode;
  tagline: string;
  price: string;
  unit: string;
  sub: string;
  action: ReactNode;
  lead: string;
  children: ReactNode;
  highlight?: boolean;
  current?: boolean;
}) {
  return (
    <section
      aria-labelledby={`plan-${id}`}
      aria-current={current ? 'true' : undefined}
      className={cx(
        'flex flex-col rounded-[12px] bg-surface',
        highlight ? 'border-2 border-accent p-[23px]' : 'border border-border p-6',
      )}
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 id={`plan-${id}`} className="m-0 flex items-center gap-2 text-section font-semibold">
          {icon}
          {name}
        </h2>
        {badge}
      </div>
      <p className="mt-1 mb-0 text-text-2">{tagline}</p>
      <div className="mt-[18px] flex items-baseline gap-1.5">
        <span className="text-[32px] leading-[1.45] font-semibold tracking-[-0.01em] tabular-nums">{price}</span>
        <span className="text-text-2">{unit}</span>
      </div>
      <p className="mt-0.5 mb-0 min-h-[17px] text-small text-text-3 tabular-nums">{sub}</p>
      <div className="mt-[18px]">{action}</div>
      <div className="mt-[22px] font-semibold">{lead}</div>
      <ul className="m-0 mt-2.5 flex list-none flex-col gap-2.5 p-0 text-text-2">{children}</ul>
    </section>
  );
}

/** While Stripe's checkout is open in another tab (Stripe-Plans board). */
function WaitingBanner() {
  return (
    <div role="status" className="mb-4 flex items-center gap-3 rounded-card border border-accent-line bg-accent-soft py-3 pr-3 pl-4 max-[560px]:flex-wrap">
      <LoaderCircle size={18} strokeWidth={2} aria-hidden className="tf-spin shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Finish paying in the Stripe tab</div>
        <div className="text-small text-text-2">Pro switches on here as soon as Stripe confirms. Changed your mind? Close that tab; nothing is charged.</div>
      </div>
      <button
        type="button"
        onClick={() => void focusCheckout()}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3.5 text-small font-semibold text-text hover:bg-hover"
      >
        <ExternalLink size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
        Go to the Stripe tab
      </button>
    </div>
  );
}

/** The payment went to an email that already had an account: this computer signs in to use it. */
function SignInBanner({ email }: { email: string }) {
  return (
    <div role="status" className="mb-4 flex items-center gap-3 rounded-card border border-accent-line bg-accent-soft py-3 pr-3 pl-4 max-[560px]:flex-wrap">
      <LogIn size={18} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Your payment is on {email}</div>
        <div className="text-small text-text-2">Sign in with a code to use Pro on this computer.</div>
      </div>
      <button
        type="button"
        onClick={() => openSignIn('signin', email)}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control bg-accent px-3.5 text-small font-semibold text-on-accent hover:bg-accent-hover"
      >
        Sign in
      </button>
    </div>
  );
}

/**
 * The plans page (Pro-Plans, Stripe-Plans, `#/pro`): Free, Pro and Pro AI side by side with a
 * Monthly / Yearly switch. "Get Pro" and "Get Pro AI" open Stripe Checkout in a tab
 * (`checkout-open`) and the page waits for it; the trial starts with an emailed code; once paying,
 * plan changes go through Stripe's billing page.
 */
export function PlansPage({ onBack }: { onBack: () => void }) {
  const plan = usePlan();
  const checkout = useCheckout();
  const signInAs = useNeedsSignIn();
  const [interval, setBilling] = useState<BillingInterval>('year');
  const [busy, setBusy] = useState<string | null>(null);
  const [showSent, setShowSent] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const configured = proConfigured();

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const now = Date.now();
  const paid = paidTier(plan);
  const trialing = !paid && isTrialing(plan, now);
  const offerTrial = !paid && !trialing && !trialUsed(plan);
  const yearly = interval === 'year';

  const run = async (key: string, task: () => Promise<string | null | void>) => {
    setBusy(key);
    const problem = await task();
    setBusy(null);
    if (problem) toast(problem, { tone: 'error' });
  };

  const spinner = (key: string) => busy === key && <LoaderCircle size={16} aria-hidden className="tf-spin" />;
  const disabled = !configured || busy !== null || !!checkout;

  const manage = (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void run('manage', () => openBilling())}
      className="mt-2 flex h-6 w-full items-center justify-center gap-1.5 text-small font-semibold text-accent-text hover:underline disabled:opacity-50 disabled:hover:no-underline"
    >
      {spinner('manage')}
      Manage billing
    </button>
  );
  // A paid plan shows "Manage billing" under its card's button; the other cards keep the same height.
  const reserve = paid ? 'min-h-[72px]' : undefined;

  const priceOf = (tier: PaidTier) => {
    const p = PRICES[tier];
    return yearly
      ? { price: dollars(p.year / 12), sub: `${dollars(p.year)} billed yearly · or ${dollars(p.month)} monthly` }
      : { price: dollars(p.month), sub: `Billed monthly · or ${dollars(p.year)} a year` };
  };

  const actionFor = (tier: PaidTier): ReactNode => {
    if (checkout?.tier === tier) {
      return (
        <button type="button" aria-busy="true" disabled className={BUTTONS.busy}>
          <LoaderCircle size={16} strokeWidth={2} aria-hidden className="tf-spin" />
          Waiting for Stripe…
        </button>
      );
    }
    if (paid === tier) {
      return (
        <div className={reserve}>
          <button type="button" disabled className={BUTTONS.off}>
            Your plan
          </button>
          {manage}
        </div>
      );
    }
    const label = tier === 'pro-ai' ? 'Pro AI' : 'Pro';
    if (paid) {
      // Moving between paid plans happens on Stripe's billing page.
      return (
        <div className={reserve}>
          <button type="button" disabled={disabled} onClick={() => void run(tier, () => openBilling())} className={BUTTONS.soft}>
            {spinner(tier)}
            Switch to {label}
          </button>
        </div>
      );
    }
    if (tier === 'pro') {
      return (
        <button type="button" disabled={disabled} onClick={() => void run(tier, () => openCheckout(tier, interval))} className={BUTTONS.soft}>
          {spinner(tier)}
          {trialing ? 'Switch to Pro' : 'Get Pro'}
        </button>
      );
    }
    if (trialing) {
      const left = plan.trial!.endsAt - now;
      return (
        <>
          <button type="button" disabled={disabled} onClick={() => void run(tier, () => openCheckout(tier, interval))} className={BUTTONS.primary}>
            {spinner(tier)}
            Keep Pro AI
          </button>
          <p className="mt-2 mb-0 text-small text-text-2">
            {left < TRIAL_BILLING_MIN_MS ? 'You’ll be charged today.' : `You won’t be charged until ${shortDate(plan.trial!.endsAt)}, when your trial ends.`}
          </p>
        </>
      );
    }
    return offerTrial ? (
      <button type="button" disabled={disabled} onClick={() => void run(tier, () => startTrialFlow(plan))} className={BUTTONS.primary}>
        {spinner(tier)}
        Start {TRIAL_DAYS}-day free trial
      </button>
    ) : (
      <button type="button" disabled={disabled} onClick={() => void run(tier, () => openCheckout(tier, interval))} className={BUTTONS.primary}>
        {spinner(tier)}
        Get Pro AI
      </button>
    );
  };

  const pro = priceOf('pro');
  const proAi = priceOf('pro-ai');

  return (
    <div className="mx-auto w-full max-w-[1104px] px-8 pt-6 pb-10 max-[720px]:px-4">
      <a
        href="#/"
        onClick={(e) => {
          e.preventDefault();
          onBack();
        }}
        className="inline-flex items-center gap-1.5 rounded-control font-semibold text-text-2 no-underline hover:text-text"
      >
        <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
        Your list
      </a>

      <div className="mt-1 mb-5 text-center">
        {!configured && (
          <p role="status" className="mx-auto mt-0 mb-4 inline-flex items-center gap-2 rounded-control border border-border bg-surface px-3 py-1.5 text-small text-text-2">
            <Info size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
            Pro isn’t switched on in this build yet.
          </p>
        )}
        <h1 ref={headingRef} tabIndex={-1} className="m-0 text-hero leading-[1.45] font-semibold outline-none">
          Tabfold Pro
        </h1>
        <p className="mt-2 mb-[18px] text-text-2">Free stays complete. Pro keeps every tab in sync and backed up. Pro AI sorts them into projects.</p>
        <div role="radiogroup" aria-label="Billing period" className="inline-flex h-9 rounded-[10px] border border-border-strong bg-bg-subtle p-[3px]">
          {(['month', 'year'] as const).map((value) => {
            const on = interval === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => setBilling(value)}
                onKeyDown={(e) => {
                  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                    e.preventDefault();
                    const next = value === 'year' ? 'month' : 'year';
                    setBilling(next);
                    (e.currentTarget.parentElement?.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
                  }
                }}
                data-value={value}
                className={cx(
                  'inline-flex h-7 items-center gap-2 rounded-[7px] pl-3.5',
                  value === 'year' ? 'pr-3' : 'pr-3.5',
                  on ? 'border border-border bg-surface font-semibold text-text' : 'text-text-2 hover:text-text',
                )}
              >
                {value === 'year' ? 'Yearly' : 'Monthly'}
                {value === 'year' && <Chip tone="green">Save up to {bestYearlySaving()}%</Chip>}
              </button>
            );
          })}
        </div>
      </div>

      {signInAs && !paid ? <SignInBanner email={signInAs} /> : checkout && <WaitingBanner />}

      <div className="grid grid-cols-3 items-stretch gap-4 max-[960px]:mx-auto max-[960px]:max-w-[480px] max-[960px]:grid-cols-1">
        <PlanCard
          id="free"
          name="Free"
          tagline="Everything on this computer"
          price="$0"
          unit="forever"
          sub=""
          current={plan.tier === 'free'}
          action={
            <div className={reserve}>
              <button type="button" disabled className={BUTTONS.off}>
                {plan.tier === 'free' ? 'Your plan' : trialing ? 'Free' : 'Included in your plan'}
              </button>
            </div>
          }
          lead={plan.tier === 'free' ? 'What you have now' : 'Always included'}
        >
          <Feature>Fold tabs and free memory</Feature>
          <Feature>One list, sorted by kind of site</Feature>
          <Feature>Search by title, address or keyword</Feature>
          <Feature>Your newest 500 folded tabs on your other computers, with Chrome sync</Feature>
          <Feature>Crash recovery</Feature>
        </PlanCard>

        <PlanCard
          id="pro"
          name="Pro"
          tagline="Every tab, on every computer, backed up"
          price={pro.price}
          unit="/ month"
          sub={pro.sub}
          current={paid === 'pro'}
          action={actionFor('pro')}
          lead="Everything in Free, plus"
        >
          <Feature>
            <b className="font-semibold text-text">All</b> your folded tabs on every computer, no 500 limit
          </Feature>
          <Feature>Works without signing in to Chrome, across profiles and Chromium browsers</Feature>
          <Feature>Daily backup: bring your list back from any of the last 30 days</Feature>
          <Feature>Export to Markdown, CSV and JSON</Feature>
        </PlanCard>

        <PlanCard
          id="pro-ai"
          name="Pro AI"
          icon={<Sparkles size={18} strokeWidth={1.75} aria-hidden className="text-accent-text" />}
          badge={
            trialing ? (
              <Chip>Your trial · {daysLeftLabel(trialDaysLeft(plan, now))}</Chip>
            ) : offerTrial ? (
              <Chip>{TRIAL_DAYS}-day free trial · no card</Chip>
            ) : undefined
          }
          tagline="Your tabs sorted into projects for you"
          price={proAi.price}
          unit="/ month"
          sub={proAi.sub}
          current={plan.tier === 'pro-ai'}
          action={actionFor('pro-ai')}
          lead="Everything in Pro, plus"
          highlight
        >
          <Feature>
            <b className="font-semibold text-text">Organise with AI</b>: groups your tabs by project, not just by site. {AI_RUNS_PER_MONTH} runs a month
          </Feature>
          <Feature>Smart names for your folds, like “Checkout app · Stripe webhooks”</Feature>
          <Feature>Copy a group as context for Claude, ChatGPT or Cursor</Feature>
          <Feature shield>Only titles and addresses are sent, never page content</Feature>
        </PlanCard>
      </div>

      <p className="mt-5 mb-0 text-small text-text-3">
        Prices in USD; tax added at checkout where it applies. Cancel anytime in Settings. If you stop paying, everything you folded stays here,
        readable and exportable. Payments by Stripe; Tabfold never sees your card.
      </p>
      <div className="mt-2 flex flex-wrap gap-5 text-small font-semibold">
        {!paid && (
          <button
            type="button"
            disabled={!configured}
            onClick={() => openSignIn('signin')}
            className="text-accent-text hover:underline disabled:opacity-50 disabled:hover:no-underline"
          >
            Already paid? Sign in
          </button>
        )}
        <button
          type="button"
          aria-expanded={showSent}
          aria-controls="sent-where"
          onClick={() => setShowSent((v) => !v)}
          className="text-accent-text hover:underline"
        >
          What gets sent where
        </button>
      </div>
      {showSent && (
        <dl id="sent-where" className="anim-in mt-3 mb-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-card border border-border bg-surface px-4 py-3.5 text-small text-text-2 max-[720px]:grid-cols-1">
          <dt className="font-semibold text-text">Free</dt>
          <dd className="m-0">Nothing leaves your computer, except your newest 500 folded tabs in Chrome’s own sync when you’re signed in to Chrome.</dd>
          <dt className="font-semibold text-text">Pro</dt>
          <dd className="m-0">
            Your folded tabs (titles, addresses and keywords) sync through your Tabfold account, with a daily backup kept 30 days. Incognito tabs stay on
            this computer.
          </dd>
          <dt className="font-semibold text-text">Pro AI</dt>
          <dd className="m-0">
            When you organise or copy context, the titles and sites of up to 300 tabs go to Tabfold’s server and its AI (Claude, by Anthropic). Never page
            content, never Incognito tabs.
          </dd>
          <dt className="font-semibold text-text">Account</dt>
          <dd className="m-0">Your email is your Tabfold account. Sign-in codes are emailed through Resend.</dd>
          <dt className="font-semibold text-text">Payments</dt>
          <dd className="m-0">Stripe takes your payment on its own page and keeps your card details. Tabfold never sees your card.</dd>
        </dl>
      )}
    </div>
  );
}
