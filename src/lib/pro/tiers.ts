import { TRIAL_DAYS, type BillingInterval, type PlanState, type Tier } from './types';

/**
 * The plan rules, shared by the extension and the server (server/ imports this file): which tier
 * an ExtensionPay user has. Pure, so both sides agree and it is easy to test.
 */

/** The user object ExtensionPay's API returns (`GET /extension/<id>/api/v2/user`), as JSON. */
export interface ExtPayUser {
  paid: boolean;
  paidAt?: string | null;
  installedAt?: string | null;
  trialStartedAt?: string | null;
  email?: string | null;
  plan?: {
    unitAmountCents?: number;
    currency?: string;
    nickname?: string | null;
    interval?: 'month' | 'year' | 'once' | null;
    intervalCount?: number | null;
  } | null;
  subscriptionStatus?: 'active' | 'past_due' | 'canceled' | null;
  subscriptionCancelAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** "pro-ai-yearly" → pro-ai; "pro-monthly" → pro. Unknown paid plans count as Pro. */
export function tierOfNickname(nickname: string | null | undefined): Exclude<Tier, 'free'> {
  return /(^|[-_ ])ai([-_ ]|$)/i.test(nickname ?? '') ? 'pro-ai' : 'pro';
}

export function planFromUser(user: ExtPayUser, now: number): PlanState {
  const trialStartedAt = time(user.trialStartedAt);
  const trialEndsAt = trialStartedAt !== null ? trialStartedAt + TRIAL_DAYS * DAY_MS : null;
  const paidActive = user.paid === true && (user.subscriptionStatus ?? 'active') !== 'canceled';
  const interval: BillingInterval | null =
    user.plan?.interval === 'month' || user.plan?.interval === 'year' ? user.plan.interval : null;
  let tier: Tier = 'free';
  if (paidActive) tier = tierOfNickname(user.plan?.nickname);
  const trialRunning = trialStartedAt !== null && trialEndsAt !== null && now < trialEndsAt;
  // A trial gives Pro AI; a paid Pro plan during a trial still gets the trial's AI.
  if (trialRunning && tier !== 'pro-ai') tier = 'pro-ai';
  return {
    tier,
    trial: trialRunning && !(paidActive && tierOfNickname(user.plan?.nickname) === 'pro-ai') ? { startedAt: trialStartedAt!, endsAt: trialEndsAt! } : null,
    email: user.email ?? null,
    interval: paidActive ? interval : null,
    status: user.subscriptionStatus ?? (user.paid ? 'active' : null),
    cancelAt: time(user.subscriptionCancelAt),
    checkedAt: now,
  };
}

export const hasPro = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro' || plan.tier === 'pro-ai';
export const hasProAi = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro-ai';
