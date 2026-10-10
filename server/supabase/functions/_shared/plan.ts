/**
 * The plan rules for the server: a copy of `src/lib/pro/tiers.ts` (and the types and limits it
 * needs from `src/lib/pro/types.ts`), because an Edge Function can't import the extension's code.
 * `tests/server/plan.test.ts` checks that both give the same plan for the same ExtensionPay user,
 * so change them together.
 */

export type Tier = 'free' | 'pro' | 'pro-ai';
export type BillingInterval = 'month' | 'year';

export interface PlanState {
  tier: Tier;
  trial: { startedAt: number; endsAt: number } | null;
  email: string | null;
  interval: BillingInterval | null;
  status: 'active' | 'past_due' | 'canceled' | null;
  cancelAt: number | null;
  checkedAt: number;
}

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

export const TRIAL_DAYS = 7;
export const AI_RUNS_PER_MONTH = 300;
export const AI_MAX_TABS = 300;
export const AI_MAX_TITLE = 200;

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
    trial:
      trialRunning && !(paidActive && tierOfNickname(user.plan?.nickname) === 'pro-ai')
        ? { startedAt: trialStartedAt!, endsAt: trialEndsAt! }
        : null,
    email: user.email ?? null,
    interval: paidActive ? interval : null,
    status: user.subscriptionStatus ?? (user.paid ? 'active' : null),
    cancelAt: time(user.subscriptionCancelAt),
    checkedAt: now,
  };
}

export const hasPro = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro' || plan.tier === 'pro-ai';
export const hasProAi = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro-ai';
