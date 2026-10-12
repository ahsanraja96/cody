import { tabLookedAt } from '../state';

/**
 * When the person last looked at each open tab (tabs.onActivated), for "Close the copies": it keeps
 * the copy looked at last, not one that merely opened in the background since. Kept in session
 * storage, one change at a time; closed tabs are forgotten.
 */

let cache: Record<string, number> | undefined;
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(task: (seen: Record<string, number>) => Promise<T>): Promise<T> {
  const run = chain.then(async () => task((cache ??= await tabLookedAt.get())));
  chain = run.catch(() => undefined);
  return run;
}

/** A browser session can't hold that many open tabs; keep the newest. */
const MAX_TABS = 2000;

async function save(seen: Record<string, number>): Promise<void> {
  const entries = Object.entries(seen);
  const kept = entries.length > MAX_TABS ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_TABS)) : seen;
  cache = kept;
  await tabLookedAt.set(kept);
}

/** tabs.onActivated: the person is looking at this tab now. Never throws. */
export function noteTabLookedAt(tabId: number, now = Date.now()): Promise<void> {
  return serial(async (seen) => {
    seen[String(tabId)] = now;
    await save(seen);
  }).catch(() => undefined);
}

/** tabs.onRemoved: forget a closed tab. */
export function forgetTabLookedAt(tabId: number): Promise<void> {
  return serial(async (seen) => {
    if (!(String(tabId) in seen)) return;
    delete seen[String(tabId)];
    await save(seen);
  }).catch(() => undefined);
}

/** tabs.onReplaced: Chrome swapped a tab for another (put to sleep, prerendered); the time follows. */
export function replaceTabLookedAt(addedTabId: number, removedTabId: number): Promise<void> {
  return serial(async (seen) => {
    const at = seen[String(removedTabId)];
    if (at === undefined) return;
    delete seen[String(removedTabId)];
    seen[String(addedTabId)] = at;
    await save(seen);
  }).catch(() => undefined);
}

/** Tab id → when it was last looked at. */
export function tabsLookedAt(): Promise<Record<string, number>> {
  return serial(async (seen) => ({ ...seen }));
}

/** For tests: forget what's cached (as a fresh worker would). */
export function resetLookedAtRuntime(): void {
  cache = undefined;
  chain = Promise.resolve();
}
