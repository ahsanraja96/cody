import { weeklyStats, type WeekStats } from '../state';
import { addToWeek } from '../weekly';

/**
 * The weekly summary's numbers (1.0, `weeklyStats`): tabs folded and the memory they gave back,
 * and folded tabs that came back. Never Incognito (callers count only normal tabs). Changes are
 * written one at a time, so two folds finishing together both count. Never throws.
 */

let chain: Promise<unknown> = Promise.resolve();

export function addToWeeklyNumbers(add: Partial<WeekStats>, at = Date.now()): Promise<void> {
  const folded = add.folded ?? 0;
  const freedBytes = add.freedBytes ?? 0;
  const cameBack = add.cameBack ?? 0;
  if (!folded && !freedBytes && !cameBack) return Promise.resolve();
  const run = chain.then(async () => {
    const next = addToWeek(await weeklyStats.get(), at, { folded, freedBytes, cameBack });
    // Undo can take a fold back off: never below zero.
    for (const week of Object.values(next)) {
      week.folded = Math.max(0, week.folded);
      week.freedBytes = Math.max(0, week.freedBytes);
      week.cameBack = Math.max(0, week.cameBack);
    }
    await weeklyStats.set(next);
  });
  chain = run.catch(() => undefined);
  return run.catch((error) => console.warn('[tabfold] weekly numbers not kept', (error as Error)?.name ?? error));
}

/** Tabs folded (saved plus copies already folded, as the toast counts) and the memory freed. */
export function countFold(folded: number, freedBytes: number, at = Date.now()): Promise<void> {
  return addToWeeklyNumbers({ folded, freedBytes }, at);
}

/** Folded tabs opened again from Tabfold, or snoozed tabs that woke. */
export function countCameBack(tabs: number, at = Date.now()): Promise<void> {
  return addToWeeklyNumbers({ cameBack: tabs }, at);
}
