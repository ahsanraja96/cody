import Dexie, { type EntityTable } from 'dexie';
import type { FolderRecord, MetaRecord, SessionRecord, SnapshotRecord, TabRecord, WindowRecord } from './types';

export const DB_NAME = 'tabfold';

/**
 * One row per session, window and tab, so reads and writes stay small and indexed even with
 * 50,000+ saved tabs. Schema changes must add a new `this.version(n)` with an upgrade function;
 * IndexedDB runs upgrades in a single versionchange transaction, so a failed migration rolls back
 * and the old data stays intact.
 */
export class TabfoldDB extends Dexie {
  sessions!: EntityTable<SessionRecord, 'id'>;
  windows!: EntityTable<WindowRecord, 'id'>;
  tabs!: EntityTable<TabRecord, 'id'>;
  snapshots!: EntityTable<SnapshotRecord, 'id'>;
  meta!: EntityTable<MetaRecord, 'key'>;
  folders!: EntityTable<FolderRecord, 'id'>;

  constructor(name = DB_NAME) {
    super(name);
    this.version(1).stores({
      sessions: 'id, updatedAt, deletedAt, [deletedAt+updatedAt], pinned, kind, *tags',
      windows: 'id, sessionId',
      tabs: 'id, sessionId, windowId, url, *keywords',
      snapshots: '++id, createdAt, reason',
      meta: 'key',
    });
    // 0.6: folders, and tabs indexed by folder and snooze time. Moving old AI projects into folders
    // needs chrome.storage (the project colours), so it runs after opening (migrateProjectsToFolders).
    this.version(2).stores({
      tabs: 'id, sessionId, windowId, url, *keywords, folderId, snoozeUntil',
      folders: 'id, deletedAt, order',
    });
  }
}

export const db = new TabfoldDB();

/** Bumped inside every write that changes what search can find; the search worker rebuilds when it moves. */
export const SEARCH_VERSION_KEY = 'searchVersion';

export async function bumpSearchVersion(database: TabfoldDB = db): Promise<void> {
  const current = await database.meta.get(SEARCH_VERSION_KEY);
  const next = typeof current?.value === 'number' ? current.value + 1 : 1;
  await database.meta.put({ key: SEARCH_VERSION_KEY, value: next });
}

export async function getSearchVersion(database: TabfoldDB = db): Promise<number> {
  const row = await database.meta.get(SEARCH_VERSION_KEY);
  return typeof row?.value === 'number' ? row.value : 0;
}

export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name ?? '';
  const inner = (error as { inner?: { name?: string } }).inner?.name ?? '';
  return name === 'QuotaExceededError' || inner === 'QuotaExceededError';
}
