/**
 * The plan rules (server/API.md, "The plan" and "Plans: Pro for life and Teams"). The server works
 * out the plan from the account, its Stripe subscriptions, a Pro for life purchase and its team;
 * the extension only shows what `GET /me` answers. `PlanState` is the same shape as the
 * extension's (`src/lib/pro/types.ts`), so change them together.
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
  /** Pro for life (a one-time payment): at least Pro, with no renewal. Only set when true. */
  lifetime?: boolean;
  /** The team this account is in, while the team's subscription is live. Only set then. */
  team?: TeamInfo | null;
}

export interface TeamInfo {
  id: string;
  name: string;
  role: TeamRole;
  /** Paid seats (members, the owner included): the subscription's quantity. */
  seats: number;
}

export type TeamRole = 'owner' | 'member';

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
  /** The first item's quantity: a Teams plan's seats (1 for the other plans). */
  quantity?: number;
  /** The first item's id (`si_…`), for changing a Teams plan's seats. */
  itemId?: string | null;
  /** When it ended (Stripe's `ended_at`), once it has. */
  endedAt?: number | null;
}

/** A one-time purchase (Pro for life), as the server keeps it. */
export interface Purchase {
  /** The Checkout Session it was paid through (`cs_…`). */
  id: string;
  /** The price's lookup key: `pro-lifetime`. */
  lookupKey: string;
  customerId: string | null;
  paymentIntentId: string | null;
  createdAt: number;
}

/** The team an account is in, with the team's subscription (stored on the owner's account). */
export interface TeamInput {
  id: string;
  name: string;
  role: TeamRole;
  seats: number;
  subscription: Subscription | null;
}

export interface PlanInput {
  /** The signed-in account; null when this computer isn't signed in. */
  account: { email: string; trialStartedAt: number | null } | null;
  subscriptions: Subscription[];
  /** One-time purchases (Pro for life). */
  purchases?: Purchase[];
  /** The team the account is in, if any. */
  team?: TeamInput | null;
}

export const TRIAL_DAYS = 7;
export const AI_RUNS_PER_MONTH = 300;
export const AI_MAX_TABS = 300;
export const AI_MAX_TITLE = 200;

/** The four subscription prices (server/scripts/stripe-setup.mjs creates them). */
export const LOOKUP_KEYS = {
  pro: { month: 'pro-monthly', year: 'pro-yearly' },
  'pro-ai': { month: 'pro-ai-monthly', year: 'pro-ai-yearly' },
} as const satisfies Record<Exclude<Tier, 'free'>, Record<BillingInterval, string>>;

/** Pro for life: one payment of $99. */
export const LIFETIME_LOOKUP_KEY = 'pro-lifetime';
/** Teams: per person (the subscription's quantity is the seats). */
export const TEAMS_LOOKUP_KEYS = { month: 'teams-monthly', year: 'teams-yearly' } as const satisfies Record<BillingInterval, string>;

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRIAL_MS = TRIAL_DAYS * DAY_MS;

/** Stripe statuses that still give the plan. */
const LIVE = new Set(['active', 'trialing', 'past_due']);

/** Whether a subscription still gives its plan (active, trialing or past due). */
export const isLive = (subscription: Pick<Subscription, 'status'> | null | undefined): boolean =>
  !!subscription && LIVE.has(subscription.status);

/** Whether the purchases include Pro for life. */
export const hasLifetime = (purchases: Purchase[] | undefined): boolean =>
  !!purchases?.some((purchase) => purchase.lookupKey === LIFETIME_LOOKUP_KEY);

/**
 * A subscription price's tier: `pro-ai-*` → pro-ai, other `pro-*` → pro; anything else (Teams, Pro
 * for life, other prices) isn't a personal subscription (null).
 */
export function tierOfLookupKey(lookupKey: string | null | undefined): Exclude<Tier, 'free'> | null {
  if (!lookupKey || lookupKey === LIFETIME_LOOKUP_KEY) return null;
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

/** A subscription's billing fields, as the plan shows them. */
function billingOf(sub: Subscription): Pick<PlanState, 'interval' | 'status' | 'cancelAt' | 'renewsAt'> {
  const cancelAt = sub.cancelAt ?? (sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null);
  const renewsAt = sub.status === 'trialing' ? (sub.trialEnd ?? sub.currentPeriodEnd) : sub.currentPeriodEnd;
  return {
    interval: sub.interval,
    status: sub.status === 'past_due' ? 'past_due' : 'active',
    cancelAt,
    renewsAt: cancelAt !== null ? null : renewsAt,
  };
}

const RANK: Record<Tier, number> = { free: 0, pro: 1, 'pro-ai': 2 };
const atLeast = (tier: Tier, floor: Tier): Tier => (RANK[tier] >= RANK[floor] ? tier : floor);

/**
 * The plan, from the best of: a live team (Pro AI), the account's own live subscription, the
 * server trial, and Pro for life (at least Pro). The billing fields describe the subscription the
 * person pays: the team's for its owner, else their own.
 */
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

  const plan: PlanState = { ...base };
  const lifetime = hasLifetime(input.purchases);
  if (lifetime) plan.lifetime = true;

  const team = input.team && isLive(input.team.subscription) ? input.team : null;
  const own = bestSubscription(input.subscriptions);
  if (own) {
    Object.assign(plan, billingOf(own));
    plan.tier = tierOfLookupKey(own.lookupKey)!;
  }
  if (team) {
    plan.tier = 'pro-ai';
    plan.team = { id: team.id, name: team.name, role: team.role, seats: team.seats };
    if (team.role === 'owner') Object.assign(plan, billingOf(team.subscription!));
  }
  if (!own && !team && trialStartedAt !== null && now < trialStartedAt + TRIAL_MS) {
    plan.tier = 'pro-ai';
    plan.trial = { startedAt: trialStartedAt, endsAt: trialStartedAt + TRIAL_MS };
  }
  if (lifetime) plan.tier = atLeast(plan.tier, 'pro');
  return plan;
}

export const hasPro = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro' || plan.tier === 'pro-ai';
export const hasProAi = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro-ai';
