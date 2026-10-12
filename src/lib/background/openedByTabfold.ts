import { openedByTabfold } from '../state';

/**
 * Open tabs Tabfold opened itself (Undo, Open all, Reopen, snoozed tabs waking, a live folder, the
 * copies put back), until the person looks at one (activates it). "A window has more than N tabs"
 * neither counts nor folds them meanwhile, so an Undo stays undone and opening a big folder into a
 * capped window doesn't fold it away again. Kept in session storage (tab ids end with the browser
 * session), one change at a time.
 */

let cache: Set<number> | undefined;
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(task: (ids: Set<number>) => Promise<T>): Promise<T> {
  const run = chain.then(async () => task((cache ??= new Set(await openedByTabfold.get()))));
  chain = run.catch(() => undefined);
  return run;
}

async function save(ids: Set<number>): Promise<void> {
  // A browser session can't hold that many; keep the newest.
  const list = [...ids].slice(-2000);
  cache = new Set(list);
  await openedByTabfold.set(list);
}

/** Tabfold just opened these tabs. Never throws. */
export function noteOpenedByTabfold(tabIds: Iterable<number | undefined>): Promise<void> {
  const ids = [...tabIds].filter((id): id is number => typeof id === 'number' && id >= 0);
  if (ids.length === 0) return Promise.resolve();
  return serial(async (current) => {
    for (const id of ids) current.add(id);
    await save(current);
  }).catch(() => undefined);
}

/** tabs.onActivated: the person looked at it (or it closed, `tabs.onRemoved`): it's like any other tab now. */
export function forgetOpenedByTabfold(tabId: number): Promise<void> {
  return serial(async (current) => {
    if (!current.delete(tabId)) return;
    await save(current);
  }).catch(() => undefined);
}

/** tabs.onReplaced: Chrome swapped a tab for another (put to sleep, prerendered): the mark follows. */
export function replaceOpenedByTabfold(addedTabId: number, removedTabId: number): Promise<void> {
  return serial(async (current) => {
    if (!current.delete(removedTabId)) return;
    current.add(addedTabId);
    await save(current);
  }).catch(() => undefined);
}

/** The tabs Tabfold opened that the person hasn't looked at yet. */
export function openedByTabfoldNow(): Promise<Set<number>> {
  return serial(async (current) => new Set(current));
}

/** For tests: forget what's cached (as a fresh worker would). */
export function resetOpenedByTabfoldRuntime(): void {
  cache = undefined;
  chain = Promise.resolve();
}
