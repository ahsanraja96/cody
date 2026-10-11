import { CommandError, send } from '@/lib/messages';
import { AI_RUNS_PER_MONTH, PRICES, TEAMS_PRICES, type AiRuns, type BillingInterval, type CheckoutPlan, type PlanState, type Tier } from '@/lib/pro/types';

/**
 * Small helpers the Pro screens share: plan wording, which plan is paid for, trial days left, what
 * to say when a Pro request fails (`ProErrorCode`, carried on `CommandError.code`), and the
 * commands that open Stripe's pages.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function isTrialing(plan: PlanState, now = Date.now()): boolean {
  return !!plan.trial && plan.trial.endsAt > now;
}

/** The tier of a live subscription (active or past due), or null. A trial isn't paid. */
export function paidTier(plan: PlanState): Exclude<Tier, 'free'> | null {
  if (plan.tier === 'free') return null;
  return plan.status === 'active' || plan.status === 'past_due' ? plan.tier : null;
}

/** Whole days left in the trial, at least 1 while it runs. */
export function trialDaysLeft(plan: PlanState, now = Date.now()): number {
  if (!plan.trial) return 0;
  return Math.max(1, Math.ceil((plan.trial.endsAt - now) / DAY_MS));
}

export function daysLeftLabel(days: number): string {
  return days === 1 ? '1 day left' : `${days} days left`;
}

/** This email has had the Pro AI trial (so "Start 7-day free trial" isn't offered again). Unknown until signed in. */
export function trialUsed(plan: PlanState): boolean {
  return plan.trialUsed;
}

/** Pro for life: a one-time payment, no renewal. */
export function isLifetime(plan: PlanState): boolean {
  return plan.lifetime === true;
}

/** "Team · Truewidgets · 3 people", for a Teams plan. */
export function teamLine(plan: PlanState): string | null {
  const team = plan.team;
  if (!team) return null;
  return `Team · ${team.name} · ${team.seats} ${team.seats === 1 ? 'person' : 'people'}`;
}

/** "Pro", "Pro AI", "Pro AI trial" for the plan chip; null on Free. */
export function planChipLabel(plan: PlanState, now = Date.now()): string | null {
  if (plan.tier === 'free') return plan.lifetime ? 'Pro' : plan.team ? 'Pro AI' : null;
  if (plan.tier === 'pro-ai' && isTrialing(plan, now) && !paidTier(plan)) return 'Pro AI trial';
  return plan.tier === 'pro-ai' ? 'Pro AI' : 'Pro';
}

export function tierName(tier: Exclude<Tier, 'free'>): string {
  return tier === 'pro-ai' ? 'Pro AI' : 'Pro';
}

export function intervalName(interval: BillingInterval | null): string {
  return interval === 'year' ? 'yearly' : interval === 'month' ? 'monthly' : '';
}

/** "Save up to 22%": the best yearly saving across the paid plans. */
export function bestYearlySaving(): number {
  return Math.max(...[...Object.values(PRICES), TEAMS_PRICES].map((p) => Math.floor((1 - p.year / (p.month * 12)) * 100)));
}

/** "$4", "$7", "$4.50": a whole-dollar price stays whole. */
export function dollars(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** "12 Oct 2027" style, in the person's locale. */
export function longDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "1 Nov" style, in the person's locale. */
export function shortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function runsLine(runs: AiRuns | undefined): string {
  const limit = runs?.limit ?? AI_RUNS_PER_MONTH;
  return `${(runs?.used ?? 0).toLocaleString()} of ${limit.toLocaleString()}`;
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof CommandError ? error.code : undefined;
}

function detail(error: unknown, name: string): number | undefined {
  return error instanceof CommandError ? error.details?.[name] : undefined;
}

/** What to tell people when a Pro request fails, by `ProErrorCode`; otherwise the worker's message. */
export function proErrorText(error: unknown): string {
  switch (errorCode(error)) {
    case 'offline':
      return 'You’re offline. Connect to the internet, then try again.';
    case 'server':
      return 'Tabfold’s server didn’t answer. Try again in a moment.';
    case 'ai-failed':
      return 'The AI couldn’t sort your tabs this time. That run wasn’t counted.';
    case 'not-signed-in':
      return 'Sign in to Tabfold Pro first: “Already paid? Sign in” on the plans page.';
    case 'not-configured':
      return 'Pro isn’t switched on in this build yet.';
    case 'needs-pro':
      return 'This needs Tabfold Pro.';
    case 'needs-pro-ai':
      return 'This needs Pro AI.';
    case 'runs-used-up':
      return `You’ve used this month’s ${AI_RUNS_PER_MONTH} AI runs.`;
    case 'rate-limited':
      return `Too many tries. Try again in ${minutesText(detail(error, 'retryAfter'))}.`;
    default:
      return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.';
  }
}

/** "1 minute", "25 minutes" from seconds to wait (a minute when the server didn't say). */
function minutesText(seconds: number | undefined): string {
  const minutes = Math.max(1, Math.ceil((seconds ?? 60) / 60));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * What the Team section says when a team request fails: the server's own words (a team at 100
 * people, too many invitations today, "Only the team’s owner can do this."), except when Tabfold
 * couldn't ask it at all.
 */
export function teamErrorText(error: unknown): string {
  switch (errorCode(error)) {
    case 'offline':
    case 'not-signed-in':
    case 'not-configured':
      return proErrorText(error);
    default:
      return error instanceof Error && error.message ? error.message : proErrorText(error);
  }
}

/** "3 people · $8 a person a month, billed yearly. Everyone gets Pro AI." (Mx-Share, Inviting people). */
export function teamSeatsLine(seats: number, interval: BillingInterval | null): string {
  const people = `${seats} ${seats === 1 ? 'person' : 'people'}`;
  if (!interval) return `${people} · Everyone gets Pro AI.`;
  const perMonth = interval === 'year' ? TEAMS_PRICES.year / 12 : TEAMS_PRICES.month;
  return `${people} · ${dollars(perMonth)} a person a month, billed ${interval === 'year' ? 'yearly' : 'monthly'}. Everyone gets Pro AI.`;
}

/** What the sign-in dialog says when sending or checking a code fails (Stripe-Signin board). */
export function signinErrorText(error: unknown): string {
  switch (errorCode(error)) {
    case 'wrong-code': {
      const left = detail(error, 'triesLeft');
      if (left === 0) return 'That code has expired or was tried too many times. Ask for a new one.';
      return left === undefined ? 'That code doesn’t match.' : `That code doesn’t match. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
    }
    case 'code-expired':
      return 'That code has expired or was tried too many times. Ask for a new one.';
    case 'send-failed':
      return 'Couldn’t send the code. Check your connection and try again.';
    case 'offline':
      return 'You’re offline. Connect to the internet, then try again.';
    case 'invalid-email':
      return 'That doesn’t look like an email address.';
    case 'rate-limited':
      return `Too many codes. Try again in ${minutesText(detail(error, 'retryAfter'))}.`;
    default:
      return proErrorText(error);
  }
}

/** Run a command that opens a Stripe page. Resolves to why it didn't open, or null. */
async function opening(run: () => Promise<{ opened: boolean; reason?: string }>): Promise<string | null> {
  try {
    const { opened, reason } = await run();
    return opened ? null : (reason ?? 'The page didn’t open. Try again.');
  } catch (error) {
    return proErrorText(error);
  }
}

/**
 * Open Stripe Checkout for a plan in a new tab (the worker watches it): a subscription, Pro for
 * life (one payment; the interval is ignored), or a Teams plan with its seats and name.
 */
export function openCheckout(tier: CheckoutPlan, interval: BillingInterval, team: { seats?: number; teamName?: string } = {}): Promise<string | null> {
  return opening(() => send({ type: 'checkout-open', tier, interval, ...(tier === 'teams' ? team : {}) }));
}

/** Open Stripe's billing page in a new tab; `payment-method` opens on the card form. */
export function openBilling(flow?: 'payment-method'): Promise<string | null> {
  return opening(() => send({ type: 'billing-open', ...(flow ? { flow } : {}) }));
}

/** "Go to the Stripe tab". */
export async function focusCheckout(): Promise<void> {
  await send({ type: 'checkout-focus' }).catch(() => undefined);
}

/** A rough check before asking the server (which checks properly). */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** The plans page in the full list. */
export const PLANS_HASH = '#/pro';
