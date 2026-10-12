import type { WeekStats, WeeklyStats } from './state';

const DAY = 24 * 60 * 60 * 1000;

/** The week a moment is in: its Monday's local date ("2026-10-05"). */
export function weekKey(at: number): string {
  const d = new Date(at);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

/** The week before the one `now` is in. */
export function lastWeekKey(now: number): string {
  const d = new Date(now);
  const thisMonday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return weekKey(thisMonday.getTime() - 3 * DAY);
}

export const EMPTY_WEEK: WeekStats = { folded: 0, freedBytes: 0, cameBack: 0 };

/** Add to this week's numbers; keeps the last 8 weeks. Pure: the worker stores the result. */
export function addToWeek(stats: WeeklyStats, at: number, add: Partial<WeekStats>): WeeklyStats {
  const key = weekKey(at);
  const week = stats[key] ?? EMPTY_WEEK;
  const next: WeeklyStats = {
    ...stats,
    [key]: {
      folded: week.folded + (add.folded ?? 0),
      freedBytes: week.freedBytes + (add.freedBytes ?? 0),
      cameBack: week.cameBack + (add.cameBack ?? 0),
    },
  };
  const keep = Object.keys(next).sort().slice(-8);
  return Object.fromEntries(keep.map((k) => [k, next[k]!]));
}

/**
 * Last week's summary to show this week, or null: nothing was folded last week, the person put
 * it away (×) this week, or the setting is off.
 */
export function summaryToShow(
  stats: WeeklyStats,
  now: number,
  seenWeek: string | undefined,
  enabled: boolean,
): (WeekStats & { week: string }) | null {
  if (!enabled) return null;
  if (seenWeek === weekKey(now)) return null;
  const week = lastWeekKey(now);
  const numbers = stats[week];
  if (!numbers || numbers.folded <= 0) return null;
  return { ...numbers, week };
}
