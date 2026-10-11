import type { PlanState } from './types';

/** What a plan includes. The server works the plan out (`GET /me`); these only read it. */

export const hasPro = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro' || plan.tier === 'pro-ai';
export const hasProAi = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro-ai';

/**
 * The Free limits apply to this plan (src/lib/limits.ts FREE_LIMITS)? False on Pro, Pro AI, a
 * Teams plan or Pro for life: the paid plans. The same rule as `hasFreeLimits` in src/ui/hooks.ts.
 */
export const hasFreeLimits = (plan: Pick<PlanState, 'tier' | 'lifetime' | 'team'>) =>
  plan.tier === 'free' && !plan.lifetime && !plan.team;
