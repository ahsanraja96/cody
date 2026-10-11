import { modeKey } from '../capture';
import { db } from '../db';
import { countFoldedTabs as countAllFolded, listFullError as folderListFullError, newFolderId, throwIfNoRoom } from '../folders';
import { CommandError } from '../messages';
import { proConfigured } from '../pro/config';
import { ProError } from '../pro/api';
import { refreshPlan } from '../pro/plan';
import { planState } from '../pro/state';
import { hasFreeLimits } from '../pro/tiers';
import type { PlanState } from '../pro/types';
import { findSavedCopies } from '../repo';
import type { CapturedWindow } from '../types';

/**
 * The Free plan's limits on the worker side (Fold, save, snooze; FREE_LIMITS in src/lib/limits.ts),
 * and the "paid plan" check for live folders and sharing. Nothing is ever deleted or hidden at a
 * limit: an action that doesn't fit is refused before anything closes.
 */

/** The Free limits apply to this plan: false on Pro, Pro AI, Teams or Pro for life (`hasFreeLimits`). */
export function freeLimitsApply(plan: Pick<PlanState, 'tier' | 'lifetime' | 'team'>): boolean {
  return hasFreeLimits(plan);
}

/** The plan as last read from the server: do the Free limits apply? */
export async function freeLimitsNow(): Promise<boolean> {
  return hasFreeLimits(await planState.get());
}

/**
 * A paid feature (live folders, sharing): the plan includes it, reading the plan again first when
 * the cached one says it doesn't. Otherwise `needs-pro` (the pages offer the plans).
 */
export async function requirePaid(): Promise<PlanState> {
  let plan = await planState.get();
  if (!freeLimitsApply(plan)) return plan;
  if (!proConfigured()) throw new ProError('needs-pro');
  plan = await refreshPlan({ force: true });
  if (freeLimitsApply(plan)) throw new ProError('needs-pro');
  return plan;
}

/** Folded tabs now: every live fold's tabs, snoozed ones included (src/lib/folders.ts). */
export const countFoldedTabs = (): Promise<number> => countAllFolded();

/**
 * How many tabs saving these windows would add to the list. With `dedupe`, tabs already folded (in
 * the same mode: Incognito and normal copies are different tabs) and repeats within the windows
 * don't count, exactly as saveCapture skips them.
 */
export async function tabsToAdd(windows: CapturedWindow[], dedupe: boolean): Promise<number> {
  const tabs = windows.flatMap((w) => w.tabs.map((t) => ({ url: t.url, incognito: w.incognito === true })));
  if (!dedupe) return tabs.length;
  const [normal, incognito] = await Promise.all([
    findSavedCopies(tabs.filter((t) => !t.incognito).map((t) => t.url), undefined, db, false),
    tabs.some((t) => t.incognito) ? findSavedCopies(tabs.filter((t) => t.incognito).map((t) => t.url), undefined, db, true) : new Map(),
  ]);
  const existing = new Set([
    ...[...normal.values()].map((c) => modeKey(c.tab.url, false)),
    ...[...incognito.values()].map((c) => modeKey(c.tab.url, true)),
  ]);
  const adding = new Set<string>();
  for (const tab of tabs) {
    const key = modeKey(tab.url, tab.incognito);
    if (!existing.has(key)) adding.add(key);
  }
  return adding.size;
}

/** "Your free list is full (500 tabs)…", or "This fold needs room for 23 tabs; …room for 18." */
export function listFullError(room: number, needed: number, what = 'This fold'): CommandError {
  return folderListFullError(room, needed, what);
}

/**
 * On Free, refuse (`list-full`) when `needed` more tabs don't fit in the list. Never half: callers
 * check before saving or closing anything (`throwIfNoRoom`, src/lib/folders.ts).
 */
export async function ensureRoom(needed: number, what = 'This fold'): Promise<void> {
  await throwIfNoRoom(needed, undefined, what);
}

/** `ensureRoom` for saving these windows (counted as `tabsToAdd` does); nothing is read on a paid plan. */
export async function ensureRoomFor(windows: CapturedWindow[], dedupe: boolean, what?: string): Promise<void> {
  if (windows.length === 0 || !(await freeLimitsNow())) return;
  await ensureRoom(await tabsToAdd(windows, dedupe), what);
}

/** The limit codes a page shows a card for; the worker broadcasts `limit-hit` when no page asked. */
export function limitCode(error: unknown): 'list-full' | 'snooze-limit' | 'folder-limit' | null {
  if (!(error instanceof CommandError)) return null;
  return error.code === 'list-full' || error.code === 'snooze-limit' || error.code === 'folder-limit' ? error.code : null;
}

/** A new folder's id: 12 characters [0-9a-z], the same on every computer (src/lib/folders.ts). */
export { newFolderId };
