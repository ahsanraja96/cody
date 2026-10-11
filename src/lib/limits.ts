/**
 * Plan limits. The Free cap is on sessions and tags, never on tabs: nothing already saved is ever
 * locked. When a Free user has 50 named sessions, new saves go into one "Unsorted" session.
 */
export type Plan = 'free' | 'pro' | 'pro-ai';

export interface PlanLimits {
  namedSessions: number;
  tags: number;
  crashSnapshots: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { namedSessions: 50, tags: 5, crashSnapshots: 1 },
  pro: { namedSessions: Number.POSITIVE_INFINITY, tags: Number.POSITIVE_INFINITY, crashSnapshots: 20 },
  'pro-ai': { namedSessions: Number.POSITIVE_INFINITY, tags: Number.POSITIVE_INFINITY, crashSnapshots: 20 },
};

/** v1 ships Free only; Pro arrives with sync and payments. */
export const CURRENT_PLAN: Plan = 'free';

export const UNSORTED_NAME = 'Unsorted';

export function limitsFor(plan: Plan = CURRENT_PLAN): PlanLimits {
  return PLAN_LIMITS[plan];
}

export function sessionLimitReached(namedSessionCount: number, plan: Plan = CURRENT_PLAN): boolean {
  return namedSessionCount >= limitsFor(plan).namedSessions;
}

/**
 * Can this session's tags become `nextTags`? Allowed when the total in use stays within the plan,
 * and always allowed when every tag is one already in use (a downgraded user with more tags than
 * Free allows can still reuse and remove them; only new tags need Pro).
 */
export function tagsAllowed(
  otherTags: Iterable<string>,
  nextTags: Iterable<string>,
  plan: Plan = CURRENT_PLAN,
  currentTags: Iterable<string> = [],
): boolean {
  const others = [...otherTags];
  const next = [...nextTags];
  const after = new Set([...others, ...next]);
  if (after.size <= limitsFor(plan).tags) return true;
  const known = new Set([...others, ...currentTags]);
  return next.every((tag) => known.has(tag));
}

export function planLabel(plan: Plan = CURRENT_PLAN): string {
  return plan === 'free' ? 'Free' : plan === 'pro' ? 'Pro' : 'Pro AI';
}

/**
 * Free plan limits from 0.6 (Fo-* and Mx-* boards). Paid plans (Pro, Pro AI, Teams, Pro for life)
 * have none. Nothing is ever deleted or hidden at a limit: Fold, new folders, snoozes and rules wait
 * for room (or an upgrade). A plan that ends keeps everything it had.
 */
export const FREE_LIMITS = {
  /** Folded tabs (live, not snoozed counts too). At this many, Fold pauses: "Your free list is full". */
  tabs: 500,
  /** From this many the count turns amber and the popup says how many spaces are left. */
  nearTabs: 450,
  /** Live folders. */
  folders: 3,
  /** Snoozed tabs at a time. */
  snoozes: 3,
  /** Auto-fold rules switched on (and only the "not looked at for N days" kind). */
  rules: 1,
} as const;

export type FreeLimit = keyof typeof FREE_LIMITS;

/** Room left under a Free limit; Infinity on a paid plan. */
export function roomLeft(limit: Exclude<FreeLimit, 'nearTabs'>, used: number, unlimited: boolean): number {
  return unlimited ? Number.POSITIVE_INFINITY : Math.max(0, FREE_LIMITS[limit] - used);
}
