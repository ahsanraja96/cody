import type { MilestoneState, PlanState } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Not in the first 3 days, at most once a week, never for 30 days after "Not now". */
export const MILESTONE_RULES = { quietDays: 3, everyDays: 7, notNowDays: 30, minFreedBytes: 1024 ** 3 };

export function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Should the popup show "You've freed X GB with Tabfold this month" after a fold? Only for Free,
 * after a fold that freed something, outside the quiet and dismissed periods, with at least 1 GB
 * freed this month. Pure: the popup decides, `milestone-dismiss` and the worker keep the state.
 */
export function milestoneDue(state: MilestoneState | undefined, plan: Pick<PlanState, 'tier'>, now: number): { freedBytes: number } | null {
  if (!state || plan.tier !== 'free') return null;
  if (state.month !== monthKey(now)) return null;
  if (now - state.firstSeenAt < MILESTONE_RULES.quietDays * DAY_MS) return null;
  if (now < state.dismissedUntil) return null;
  if (now - state.lastShownAt < MILESTONE_RULES.everyDays * DAY_MS) return null;
  if (state.freedBytes < MILESTONE_RULES.minFreedBytes) return null;
  return { freedBytes: state.freedBytes };
}

/** Add a fold's freed memory to this month's total (a new month starts again at 0). */
export function addFreed(state: MilestoneState | undefined, bytes: number, now: number): MilestoneState {
  const month = monthKey(now);
  const base: MilestoneState = state ?? { firstSeenAt: now, month, freedBytes: 0, lastShownAt: 0, dismissedUntil: 0 };
  const total = base.month === month ? base.freedBytes : 0;
  return { ...base, month, freedBytes: total + Math.max(0, bytes) };
}

export function dismissMilestone(state: MilestoneState, now: number): MilestoneState {
  return { ...state, dismissedUntil: now + MILESTONE_RULES.notNowDays * DAY_MS, lastShownAt: now };
}
