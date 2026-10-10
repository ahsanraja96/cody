import { browser } from 'wxt/browser';
import { defaultSyncState, SYNC_STATE_KEY } from './localState';
import { pack, SYNC_PREFIX, toSyncTime } from './records';

/**
 * "Clear all data": remove Tabfold's tabs from Chrome sync too. A small record of when it happened
 * stays, so no computer shares tabs folded before it again (they keep their own copies, but the
 * cleared list doesn't come back here from them). Never throws: the local clear has already happened.
 */
export async function clearSyncedData(now = Date.now()): Promise<void> {
  const floor = toSyncTime(now);
  // This computer first, so it never pushes the old copy back.
  await browser.storage.local.set({ [SYNC_STATE_KEY]: { ...defaultSyncState(), floor } }).catch(() => undefined);
  try {
    const current = await browser.storage.sync.get(null);
    const { items } = pack([], [], { floor });
    // The new meta record first (it names no chunks), then the old chunks go.
    await browser.storage.sync.set(items);
    const stale = Object.keys(current).filter((key) => key.startsWith(SYNC_PREFIX) && !(key in items));
    if (stale.length) await browser.storage.sync.remove(stale);
  } catch (error) {
    console.warn('[tabfold] could not clear Chrome sync', error);
  }
}
