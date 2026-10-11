/**
 * The plan rules (server/API.md, "The plan"). The server works out the plan from the account and
 * its Stripe subscriptions; the extension only shows what `GET /me` answers. `PlanState` is the
 * same shape as the extension's (`src/lib/pro/types.ts`), so change them together.
 */

export type Tier = 'free' | 'pro' | 'pro-ai';
export type BillingInterval = 'month' | 'year';

export interface PlanState {
  tier: Tier;
  /** The server's 7-day Pro AI trial, while it runs and there's no live subscription. */
  trial: { startedAt: number; endsAt: number } | null;
  /** This email has had its trial (one per email). */
  trialUsed: boolean;
  /** The signed-in account's email; null when this computer isn't signed in. */
  email: string | null;
  /** A live subscription's billing period. */
  interval: BillingInterval | null;
  /** A live subscription's state: 'active' (Stripe's active or trialing) or 'past_due'; else null. */
  status: 'active' | 'past_due' | 'canceled' | null;
  /** Cancelled but still on until then (ms). */
  cancelAt: number | null;
  /** Next charge (ms): the period end, or when billing starts after a trial. Null when cancelled. */
  renewsAt: number | null;
  /** When the server worked this out (ms). */
  checkedAt: number;
}

/** A Stripe subscription as the server keeps it (times in ms). */
export interface Subscription {
  id: string;
  customerId: string;
  /** Stripe's status: active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired, paused. */
  status: string;
  /** The price's lookup key, e.g. `pro-ai-yearly`. */
  lookupKey: string | null;
  interval: BillingInterval | null;
  currentPeriodEnd: number | null;
  cancelAt: number | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: number | null;
  /** When Stripe created it. */
  createdAt: number;
}

export interface PlanInput {
  /** The signed-in account; null when this computer isn't signed in. */
  account: { email: string; trialStartedAt: number | null } | null;
  subscriptions: Subscription[];
}

export const TRIAL_DAYS = 7;
export const AI_RUNS_PER_MONTH = 300;
export const AI_MAX_TABS = 300;
export const AI_MAX_TITLE = 200;

/** The four Stripe prices (server/scripts/stripe-setup.mjs creates them). */
export const LOOKUP_KEYS = {
  pro: { month: 'pro-monthly', year: 'pro-yearly' },
  'pro-ai': { month: 'pro-ai-monthly', year: 'pro-ai-yearly' },
} as const satisfies Record<Exclude<Tier, 'free'>, Record<BillingInterval, string>>;

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRIAL_MS = TRIAL_DAYS * DAY_MS;

/** Stripe statuses that still give the plan. */
const LIVE = new Set(['active', 'trialing', 'past_due']);

/** `pro-ai-*` → pro-ai, other `pro-*` → pro; anything else isn't a Tabfold price (null). */
export function tierOfLookupKey(lookupKey: string | null | undefined): Exclude<Tier, 'free'> | null {
  if (!lookupKey) return null;
  if (lookupKey.startsWith('pro-ai-')) return 'pro-ai';
  if (lookupKey.startsWith('pro-')) return 'pro';
  return null;
}

/** The live subscription that sets the plan: Pro AI over Pro, then the latest. */
export function bestSubscription(subscriptions: Subscription[]): Subscription | null {
  let best: Subscription | null = null;
  for (const sub of subscriptions) {
    const tier = tierOfLookupKey(sub.lookupKey);
    if (!tier || !LIVE.has(sub.status)) continue;
    if (!best) {
      best = sub;
      continue;
    }
    const bestTier = tierOfLookupKey(best.lookupKey);
    if (tier !== bestTier) {
      if (tier === 'pro-ai') best = sub;
    } else if (sub.createdAt > best.createdAt) {
      best = sub;
    }
  }
  return best;
}

export function planFor(input: PlanInput, now: number): PlanState {
  const account = input.account;
  const trialStartedAt = account?.trialStartedAt ?? null;
  const base: PlanState = {
    tier: 'free',
    trial: null,
    trialUsed: trialStartedAt !== null,
    email: account?.email ?? null,
    interval: null,
    status: null,
    cancelAt: null,
    renewsAt: null,
    checkedAt: now,
  };
  if (!account) return base;

  const sub = bestSubscription(input.subscriptions);
  if (sub) {
    const cancelAt = sub.cancelAt ?? (sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null);
    const renewsAt = sub.status === 'trialing' ? (sub.trialEnd ?? sub.currentPeriodEnd) : sub.currentPeriodEnd;
    return {
      ...base,
      tier: tierOfLookupKey(sub.lookupKey)!,
      interval: sub.interval,
      status: sub.status === 'past_due' ? 'past_due' : 'active',
      cancelAt,
      renewsAt: cancelAt !== null ? null : renewsAt,
    };
  }

  if (trialStartedAt !== null && now < trialStartedAt + TRIAL_MS) {
    return { ...base, tier: 'pro-ai', trial: { startedAt: trialStartedAt, endsAt: trialStartedAt + TRIAL_MS } };
  }
  return base;
}

export const hasPro = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro' || plan.tier === 'pro-ai';
export const hasProAi = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro-ai';
