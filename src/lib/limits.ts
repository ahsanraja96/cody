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

/** Can this set of tags be applied, given the tags already in use across all sessions? */
export function tagsAllowed(
  existingTags: Iterable<string>,
  nextTags: Iterable<string>,
  plan: Plan = CURRENT_PLAN,
): boolean {
  const all = new Set(existingTags);
  for (const tag of nextTags) all.add(tag);
  return all.size <= limitsFor(plan).tags;
}

export function planLabel(plan: Plan = CURRENT_PLAN): string {
  return plan === 'free' ? 'Free' : plan === 'pro' ? 'Pro' : 'Pro AI';
}
