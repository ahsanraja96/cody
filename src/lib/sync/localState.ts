import { browser } from 'wxt/browser';

/**
 * What this computer remembers about Chrome sync, in chrome.storage.local (never synced).
 */
export interface SyncLocalState {
  /** Shared tabs present here after the last run (sync id -> urlKey), to notice removals. */
  known: Record<string, string>;
  /** Tombstones this computer wrote (sync id -> time), so putting a tab back takes them back. */
  mine: Record<string, number>;
  /** Latest "Clear all data" time seen (ms): tabs folded before it are no longer shared. */
  floor: number;
  /** The "From your other computers" fold. */
  inboxId: string | null;
  /** Content hash in Chrome sync after the last run, and the search version then. */
  lastHash: string | null;
  lastVersion: number | null;
  /** Fingerprint of the folders and site kinds here after the last run (0.6). */
  lastFolders?: string | null;
  /** Below 1 after Chrome refused a write as too big. */
  budgetFactor: number;
  /** Failed runs in a row, and when to try again. */
  failures: number;
  retryAt: number;
  /** Times of recent writes, to stay well under Chrome's write limits. */
  writes: number[];
  /** Runs in a row that found Chrome sync's copy only partly arrived. */
  partialRuns: number;
  /**
   * Changed when this state is forgotten on purpose (a team's copy after "Clear everything" or
   * leaving the team), so a run that started before doesn't write what it planned then.
   */
  epoch?: number;
}

export const SYNC_STATE_KEY = 'syncState';

export function defaultSyncState(): SyncLocalState {
  return {
    known: {},
    mine: {},
    floor: 0,
    inboxId: null,
    lastHash: null,
    lastVersion: null,
    budgetFactor: 1,
    failures: 0,
    retryAt: 0,
    writes: [],
    partialRuns: 0,
  };
}

export interface SyncStateStore {
  get(): Promise<SyncLocalState>;
  set(state: SyncLocalState): Promise<void>;
}

export const localSyncState: SyncStateStore = {
  async get() {
    const stored = (await browser.storage.local.get(SYNC_STATE_KEY))[SYNC_STATE_KEY] as Partial<SyncLocalState> | undefined;
    return { ...defaultSyncState(), ...(stored ?? {}) };
  },
  async set(state) {
    await browser.storage.local.set({ [SYNC_STATE_KEY]: state });
  },
};
