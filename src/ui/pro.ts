import { CommandError, send, type Command } from '@/lib/messages';
import { AI_RUNS_PER_MONTH, PRICES, type AiRuns, type BillingInterval, type PlanState, type Tier } from '@/lib/pro/types';

/**
 * Small helpers the Pro screens share: plan wording, which plan is paid for, trial days left, and
 * what to say when a Pro request fails (`ProErrorCode`, carried on `CommandError.code`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Optional fields the worker may add to the cached plan (not in the contract yet): whether this
 * person has already had the Pro AI trial, so the plans page stops offering it.
 */
export type PlanWithExtras = PlanState & { trialUsed?: boolean; trialStartedAt?: number | null };

export function isTrialing(plan: PlanState, now = Date.now()): boolean {
  return !!plan.trial && plan.trial.endsAt > now;
}

/** The tier this person pays for (a running trial isn't paid), or null. */
export function paidTier(plan: PlanState): Exclude<Tier, 'free'> | null {
  if (plan.tier === 'free') return null;
  if (plan.status !== 'active' && plan.status !== 'past_due') return null;
  // A paid Pro plan during the Pro AI trial: the tier says pro-ai, the payment is for Pro.
  if (plan.trial) return plan.interval ? 'pro' : null;
  return plan.tier;
}

/** Whole days left in the trial, at least 1 while it runs. */
export function trialDaysLeft(plan: PlanState, now = Date.now()): number {
  if (!plan.trial) return 0;
  return Math.max(1, Math.ceil((plan.trial.endsAt - now) / DAY_MS));
}

export function daysLeftLabel(days: number): string {
  return days === 1 ? '1 day left' : `${days} days left`;
}

/** Has the Pro AI trial already been used (so "Start 7-day free trial" isn't offered again)? */
export function trialUsed(plan: PlanState, endedWasTrial: boolean): boolean {
  const extra = plan as PlanWithExtras;
  return !!plan.trial || extra.trialUsed === true || !!extra.trialStartedAt || endedWasTrial;
}

/** "Pro", "Pro AI", "Pro AI trial" for the plan chip; null on Free. */
export function planChipLabel(plan: PlanState, now = Date.now()): string | null {
  if (plan.tier === 'free') return null;
  if (plan.tier === 'pro-ai' && isTrialing(plan, now) && paidTier(plan) !== 'pro-ai') return 'Pro AI trial';
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
  return Math.max(...Object.values(PRICES).map((p) => Math.floor((1 - p.year / (p.month * 12)) * 100)));
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
    default:
      return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.';
  }
}

type PlanOpen = Omit<Extract<Command, { type: 'plan-open' }>, 'type'>;

/** Open ExtensionPay (checkout, trial, sign-in or the subscription page). Resolves to why it didn't open, or null. */
export async function openPlanPage(options: PlanOpen): Promise<string | null> {
  try {
    const { opened, reason } = await send({ type: 'plan-open', ...options });
    return opened ? null : (reason ?? 'The payment page didn’t open. Try again.');
  } catch (error) {
    return proErrorText(error);
  }
}

/** The plans page in the full list. */
export const PLANS_HASH = '#/pro';
