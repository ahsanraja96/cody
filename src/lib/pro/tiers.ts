import type { PlanState } from './types';

/** What a plan includes. The server works the plan out (`GET /me`); these only read it. */

export const hasPro = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro' || plan.tier === 'pro-ai';
export const hasProAi = (plan: Pick<PlanState, 'tier'>) => plan.tier === 'pro-ai';
