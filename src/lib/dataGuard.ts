import { db, type TabfoldDB } from './db';
import { dataGuard, snapshotMirror, type DataGuard, type SnapshotMirror } from './state';

/**
 * Detects a wiped database. A small count of what was saved lives in chrome.storage.local, outside
 * IndexedDB. It only goes down to zero through Tabfold's own deletes (`resetDataGuard`), so finding
 * the database empty while the guard remembers sessions means the data was erased from outside.
 */

export async function countAll(database: TabfoldDB = db): Promise<{ sessions: number; tabs: number }> {
  const [sessions, tabs] = await Promise.all([database.sessions.count(), database.tabs.count()]);
  return { sessions, tabs };
}

/** Record the current counts. Never lowers the guard to zero on its own (that is what a wipe looks like). */
export async function refreshDataGuard(database: TabfoldDB = db): Promise<void> {
  const counts = await countAll(database);
  if (counts.sessions > 0) await dataGuard.set({ ...counts, at: Date.now() });
}

/** Call after Tabfold itself deletes everything (Clear all data, emptying the last of Trash). */
export async function resetDataGuard(database: TabfoldDB = db): Promise<void> {
  const counts = await countAll(database);
  await dataGuard.set({ ...counts, at: Date.now() });
}

export interface WipeCheck {
  wiped: boolean;
  guard?: DataGuard;
  mirror?: SnapshotMirror;
}

export async function checkWiped(database: TabfoldDB = db): Promise<WipeCheck> {
  const [counts, guard, mirror] = await Promise.all([countAll(database), dataGuard.get(), snapshotMirror.get()]);
  return { wiped: counts.sessions === 0 && (guard?.sessions ?? 0) > 0, guard, mirror };
}

/** The user saw the wipe screen and moved on: stop showing it. */
export async function acknowledgeWipe(): Promise<void> {
  await dataGuard.set({ sessions: 0, tabs: 0, at: Date.now() });
}
