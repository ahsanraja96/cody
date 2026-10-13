import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ExternalLink, Info, LoaderCircle, LogIn, Minus, Plus, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { proConfigured } from '@/lib/pro/config';
import { LIFETIME_PRICE, PRICES, TEAMS_PRICES, TRIAL_DAYS, type BillingInterval, type CheckoutPlan, type Tier } from '@/lib/pro/types';
import { Chip } from '@/ui/components/ProBits';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { useCheckout, useNeedsSignIn, usePlan } from '@/ui/hooks';
import {
  bestYearlySaving,
  daysLeftLabel,
  dollars,
  focusCheckout,
  isLifetime,
  isTrialing,
  openBilling,
  openCheckout,
  paidTier,
  shortDate,
  trialDaysLeft,
  trialUsed,
} from '@/ui/pro';
import { openSignIn, startTrialFlow } from './AccountDialogs';
import { PRIMARY, SECONDARY, SmallDialog } from './FolderDialogs';

type PaidTier = Exclude<Tier, 'free'>;

const BTN = 'flex h-[38px] w-full items-center justify-center gap-2 rounded-control px-4 font-semibold disabled:cursor-default';
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
        <ShieldCheck size={15} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-text-3" />
      ) : (
        <Check size={15} strokeWidth={2} aria-hidden className="mt-0.5 shrink-0 text-green" />
      )}
      <span>{children}</span>
    </li>
  );
}

const B = ({ children }: { children: ReactNode }) => <b className="font-semibold text-text">{children}</b>;

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
  sub: ReactNode;
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
      className={cx('flex flex-col rounded-[12px] bg-surface', highlight ? 'border-2 border-accent p-[21px]' : 'border border-border p-[22px]')}
    >
      <div className="flex min-h-[22px] items-center justify-between gap-2">
        <h2 id={`plan-${id}`} className="m-0 flex items-center gap-2 text-section font-semibold">
          {icon}
          {name}
        </h2>
        {badge}
      </div>
      <p className="mt-1 mb-0 min-h-[38px] text-text-2">{tagline}</p>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-[30px] leading-[1.45] font-semibold tracking-[-0.01em] tabular-nums">{price}</span>
        <span className="text-text-2">{unit}</span>
      </div>
      <p className="mt-0.5 mb-0 min-h-[34px] text-small text-text-3 tabular-nums">{sub}</p>
      <div className="mt-3">{action}</div>
      <div className="mt-[18px] font-semibold">{lead}</div>
      <ul className="m-0 mt-2.5 flex list-none flex-col gap-[9px] p-0 text-[12.5px] text-text-2">{children}</ul>
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

const MAX_SEATS = 500;

/** "Start a team" (Mx-Plans): the team's name and how many people, then Stripe Checkout. */
function TeamDialog({ interval, onClose, onContinue }: { interval: BillingInterval; onClose: () => void; onContinue: (seats: number, name: string) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [seats, setSeats] = useState(3);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const seatsId = useId();
  const each = interval === 'year' ? TEAMS_PRICES.year / 12 : TEAMS_PRICES.month;
  const total = interval === 'year' ? `${dollars(TEAMS_PRICES.year * seats)} a year` : `${dollars(TEAMS_PRICES.month * seats)} a month`;
  const valid = name.trim().length > 0 && seats >= 1 && seats <= MAX_SEATS;
  const go = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const ok = await onContinue(seats, name.trim().slice(0, 60));
    setBusy(false);
    if (ok) onClose();
  };
  const step = (delta: number) => setSeats((n) => Math.min(MAX_SEATS, Math.max(1, n + delta)));
  return (
    <SmallDialog
      open
      onClose={onClose}
      width={400}
      title="Start a team"
      icon={<Users size={18} strokeWidth={1.75} aria-hidden className="mt-px shrink-0 text-accent-text" />}
      closeButton
      footer={
        <>
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          <button type="button" disabled={!valid || busy} onClick={() => void go()} className={PRIMARY}>
            {busy && <LoaderCircle size={14} aria-hidden className="tf-spin" />}
            Continue
          </button>
        </>
      }
    >
      <form
        className="mt-4 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <label htmlFor={nameId} className="text-text-2">
          Team name
        </label>
        <input
          id={nameId}
          data-autofocus
          value={name}
          maxLength={60}
          placeholder="Truewidgets"
          onChange={(e) => setName(e.target.value)}
          className="h-9 min-w-0 rounded-control border border-border-strong bg-surface px-2.5 text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-soft)]"
        />
        <label htmlFor={seatsId} className="text-text-2">
          People
        </label>
        <div className="flex items-center gap-1.5">
          <button type="button" aria-label="One fewer" onClick={() => step(-1)} className="inline-flex size-9 items-center justify-center rounded-control border border-border-strong bg-surface text-text-2 hover:bg-hover">
            <Minus size={14} strokeWidth={2} aria-hidden />
          </button>
          <input
            id={seatsId}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_SEATS}
            value={seats}
            onChange={(e) => setSeats(Math.min(MAX_SEATS, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
            className="h-9 w-16 rounded-control border border-border-strong bg-surface px-2 text-center text-text tabular-nums outline-none focus:border-accent"
          />
          <button type="button" aria-label="One more" onClick={() => step(1)} className="inline-flex size-9 items-center justify-center rounded-control border border-border-strong bg-surface text-text-2 hover:bg-hover">
            <Plus size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </form>
      <p role="status" className="mt-4 mb-0 border-t border-border pt-3 text-small text-text-2 tabular-nums">
        {seats} {seats === 1 ? 'person' : 'people'} · {dollars(each)} a person a month, billed {interval === 'year' ? 'yearly' : 'monthly'} ({total}). Everyone gets
        Pro AI. You can add people later.
      </p>
    </SmallDialog>
  );
}

/**
 * The plans page (Mx-Plans, Stripe-Plans, `#/pro`): Free, Pro (or $99 once, for life), Pro AI and
 * Teams side by side with a Monthly / Yearly switch. "Get Pro", the lifetime link, "Get Pro AI" and
 * "Start a team" open Stripe Checkout in a tab (`checkout-open`) and the page waits for it; the
 * trial starts with an emailed code; once paying, plan changes go through Stripe's billing page.
 */
export function PlansPage({ onBack }: { onBack: () => void }) {
  const plan = usePlan();
  const checkout = useCheckout();
  const signInAs = useNeedsSignIn();
  const [interval, setBilling] = useState<BillingInterval>('year');
  const [busy, setBusy] = useState<string | null>(null);
  const [showSent, setShowSent] = useState(false);
  const [team, setTeam] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const configured = proConfigured();

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const now = Date.now();
  const paid = paidTier(plan);
  const lifetime = isLifetime(plan);
  const onTeam = !!plan.team;
  const trialing = !paid && !lifetime && !onTeam && isTrialing(plan, now);
  const offerTrial = !paid && !trialing && !trialUsed(plan);
  const yearly = interval === 'year';
  const anyPaid = !!paid || lifetime || onTeam;

  const run = async (key: string, task: () => Promise<string | null | void>) => {
    setBusy(key);
    const problem = await task();
    setBusy(null);
    if (problem) toast(problem, { tone: 'error' });
    return !problem;
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
  const reserve = anyPaid ? 'min-h-[70px]' : undefined;

  const priceOf = (p: Record<BillingInterval, number>, each = '') =>
    yearly
      ? { price: dollars(p.year / 12), sub: `${dollars(p.year)}${each} billed yearly · or ${dollars(p.month)} monthly` }
      : { price: dollars(p.month), sub: `Billed monthly · or ${dollars(p.year)}${each} a year` };

  const waiting = (key: CheckoutPlan[]) =>
    checkout && key.includes(checkout.tier) ? (
      <button type="button" aria-busy="true" disabled className={BUTTONS.busy}>
        <LoaderCircle size={16} strokeWidth={2} aria-hidden className="tf-spin" />
        Waiting for Stripe…
      </button>
    ) : null;

  const yourPlan = (withBilling: boolean) => (
    <div className={reserve}>
      <button type="button" disabled className={BUTTONS.off}>
        Your plan
      </button>
      {withBilling && manage}
    </div>
  );

  const actionFor = (tier: PaidTier): ReactNode => {
    const wait = waiting(tier === 'pro' ? ['pro', 'pro-lifetime'] : ['pro-ai']);
    if (wait) return wait;
    if (tier === 'pro' && lifetime && paid !== 'pro-ai') return yourPlan(false);
    if (paid === tier && !onTeam) return yourPlan(true);
    const label = tier === 'pro-ai' ? 'Pro AI' : 'Pro';
    if (paid || onTeam) {
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
        <div className={reserve}>
          <button type="button" disabled={disabled || lifetime} onClick={() => void run(tier, () => openCheckout(tier, interval))} className={BUTTONS.soft}>
            {spinner(tier)}
            {trialing ? 'Switch to Pro' : 'Get Pro'}
          </button>
        </div>
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
    return (
      <div className={reserve}>
        {offerTrial && !lifetime ? (
          <button type="button" disabled={disabled} onClick={() => void run(tier, () => startTrialFlow(plan))} className={BUTTONS.primary}>
            {spinner(tier)}
            Start {TRIAL_DAYS}-day free trial
          </button>
        ) : (
          <button type="button" disabled={disabled} onClick={() => void run(tier, () => openCheckout(tier, interval))} className={BUTTONS.primary}>
            {spinner(tier)}
            Get Pro AI
          </button>
        )}
      </div>
    );
  };

  const teamsAction = (): ReactNode => {
    const wait = waiting(['teams']);
    if (wait) return wait;
    if (onTeam) return yourPlan(plan.team?.role === 'owner');
    return (
      <div className={reserve}>
        <button type="button" disabled={disabled} onClick={() => setTeam(true)} className={BUTTONS.soft}>
          {spinner('teams')}
          Start a team
        </button>
      </div>
    );
  };

  const pro = priceOf(PRICES.pro);
  const proAi = priceOf(PRICES['pro-ai']);
  const teams = priceOf(TEAMS_PRICES, ' a person');
  const lifetimeLink = !anyPaid && !trialing && (
    <>
      <br />
      or{' '}
      <button
        type="button"
        disabled={disabled}
        onClick={() => void run('pro-lifetime', () => openCheckout('pro-lifetime', interval))}
        className="font-semibold text-accent-text hover:underline disabled:opacity-50 disabled:hover:no-underline"
      >
        {dollars(LIFETIME_PRICE)} once, for life
      </button>
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[1304px] px-8 pt-6 pb-10 max-[720px]:px-4">
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
        <p className="mt-2 mb-[18px] text-text-2">Free stays useful. Pro removes the limits. Pro AI sorts and finds for you. Teams share folders.</p>
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

      {signInAs && !anyPaid ? <SignInBanner email={signInAs} /> : checkout && <WaitingBanner />}

      <div className="grid grid-cols-4 items-stretch gap-3.5 max-[1180px]:grid-cols-2 max-[640px]:mx-auto max-[640px]:max-w-[480px] max-[640px]:grid-cols-1">
        <PlanCard
          id="free"
          name="Free"
          tagline="Everything you need to fold and find tabs"
          price="$0"
          unit="forever"
          sub=""
          current={!anyPaid && !trialing}
          action={
            <div className={reserve}>
              <button type="button" disabled className={BUTTONS.off}>
                {!anyPaid && !trialing ? 'Your plan' : trialing ? 'Free' : 'Included in your plan'}
              </button>
            </div>
          }
          lead="Always free"
        >
          <Feature>Fold tabs and free memory</Feature>
          <Feature>
            <B>500</B> folded tabs, <B>3</B> folders
          </Feature>
          <Feature>3 snoozed tabs, 1 auto-fold rule</Feature>
          <Feature>Chrome sync to your other computers</Feature>
          <Feature>Ctrl+K, duplicates, import from other tab managers</Feature>
        </PlanCard>

        <PlanCard
          id="pro"
          name="Pro"
          tagline="No limits, on every computer"
          price={pro.price}
          unit="/ month"
          sub={
            <>
              {lifetime && !paid ? `Paid once, ${dollars(LIFETIME_PRICE)}: yours for life` : pro.sub}
              {lifetimeLink}
            </>
          }
          current={paid === 'pro' || (lifetime && !paid)}
          action={actionFor('pro')}
          lead="Everything in Free, plus"
        >
          <Feature>
            <B>Unlimited</B> tabs, folders, snoozes and rules
          </Feature>
          <Feature>
            <B>Live folders</B>: a folder that saves itself as you work
          </Feature>
          <Feature>
            <B>Share a folder</B> as a link
          </Feature>
          <Feature>Every tab on every computer, no Chrome sign-in</Feature>
          <Feature>Daily backup, 30 days · Markdown, CSV, JSON</Feature>
        </PlanCard>

        <PlanCard
          id="pro-ai"
          name="Pro AI"
          icon={<Sparkles size={17} strokeWidth={1.75} aria-hidden className="text-accent-text" />}
          badge={
            trialing ? (
              <Chip>Your trial · {daysLeftLabel(trialDaysLeft(plan, now))}</Chip>
            ) : offerTrial && !anyPaid ? (
              <Chip>{TRIAL_DAYS}-day trial · no card</Chip>
            ) : undefined
          }
          tagline="Your tabs sorted and found for you"
          price={proAi.price}
          unit="/ month"
          sub={proAi.sub}
          current={(paid === 'pro-ai' && !onTeam) || trialing}
          action={actionFor('pro-ai')}
          lead="Everything in Pro, plus"
          highlight
        >
          <Feature>
            <B>Organise with AI</B> into folders
          </Feature>
          <Feature>
            <B>Ask your tabs</B>: find them by what they’re about
          </Feature>
          <Feature>A weekly tidy-up</Feature>
          <Feature>Smart names · Copy as context for AI</Feature>
          <Feature shield>Only titles and sites are sent</Feature>
        </PlanCard>

        <PlanCard
          id="teams"
          name="Teams"
          icon={<Users size={17} strokeWidth={1.75} aria-hidden className="text-accent-text" />}
          tagline="The same folders for everyone"
          price={teams.price}
          unit="/ person / month"
          sub={teams.sub}
          current={onTeam}
          action={teamsAction()}
          lead="Everything in Pro AI, plus"
        >
          <Feature>
            <B>Team folders</B> everyone can add to
          </Feature>
          <Feature>Who added what, and when</Feature>
          <Feature>Invite by email, one bill</Feature>
          <Feature>Owner controls: members, sharing</Feature>
        </PlanCard>
      </div>

      <p className="mt-[18px] mb-0 text-small text-text-3">
        Prices in USD; tax added at checkout where it applies. Cancel anytime in Settings. The lifetime price covers Pro (no AI, which costs Tabfold every
        month). Payments by Stripe.
      </p>
      <div className="mt-2 flex flex-wrap gap-5 text-small font-semibold">
        {!anyPaid && (
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
            Your folded tabs and folders (titles, addresses and keywords) sync through your Tabfold account, with a daily backup kept 30 days. Incognito
            tabs stay on this computer. A folder you share shows its pages’ titles and addresses to anyone with the link, until you stop sharing.
          </dd>
          <dt className="font-semibold text-text">Pro AI</dt>
          <dd className="m-0">
            When you organise, ask your tabs, get the weekly tidy-up or copy context, the titles and sites of up to 300 tabs go to Tabfold’s server and its
            AI (Claude, by Anthropic). Never page content, never Incognito tabs.
          </dd>
          <dt className="font-semibold text-text">Teams</dt>
          <dd className="m-0">Team folders are shared with the people in your team, who can see and add to them.</dd>
          <dt className="font-semibold text-text">Account</dt>
          <dd className="m-0">Your email is your Tabfold account. Sign-in codes are emailed through Resend.</dd>
          <dt className="font-semibold text-text">Payments</dt>
          <dd className="m-0">Stripe takes your payment on its own page and keeps your card details. Tabfold never sees your card.</dd>
        </dl>
      )}
      {team && (
        <TeamDialog
          interval={interval}
          onClose={() => setTeam(false)}
          onContinue={(seats, teamName) => run('teams', () => openCheckout('teams', interval, { seats, teamName }))}
        />
      )}
    </div>
  );
}
