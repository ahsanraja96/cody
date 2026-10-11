import { browser } from 'wxt/browser';
import { checkWiped } from '../dataGuard';
import { db } from '../db';
import { api, ProError, type ApiRequest } from '../pro/api';
import { proConfigured } from '../pro/config';
import { refreshPlan } from '../pro/plan';
import { CLOUD_SYNC_STATE_KEY, planState } from '../pro/state';
import { hasPro } from '../pro/tiers';
import { getDeviceId } from '../state';
import type { SyncArea, SyncDeps, SyncFailure } from './engine';
import { defaultSyncState, type SyncLocalState, type SyncStateStore } from './localState';
import { CLOUD_LIMITS, pack, SYNC_PREFIX, toSyncTime } from './records';

/**
 * Sync with the Tabfold account (Pro): the same engine and format as Chrome sync, kept on the
 * Tabfold server (`GET /sync`, `POST /sync`, server/API.md) with room for every folded tab. A write
 * names the version it was based on; the server refuses it (409) when another computer wrote
 * first, and the engine reads and merges again shortly. While it runs, Chrome sync pauses.
 */

export { CLOUD_SYNC_STATE_KEY };

/** What this computer remembers about the Tabfold account's copy (never synced; forgotten on sign-out). */
export const cloudSyncState: SyncStateStore = {
  async get() {
    const stored = (await browser.storage.local.get(CLOUD_SYNC_STATE_KEY))[CLOUD_SYNC_STATE_KEY] as Partial<SyncLocalState> | undefined;
    return { ...defaultSyncState(), ...(stored ?? {}) };
  },
  async set(state) {
    await browser.storage.local.set({ [CLOUD_SYNC_STATE_KEY]: state });
  },
};

/** The Tabfold account syncs while this build has Pro and the plan includes it. */
export async function cloudSyncActive(): Promise<boolean> {
  return proConfigured() && hasPro(await planState.get());
}

/** How a failed request to the Tabfold account reads in the sync status. */
export function describeCloudError(error: unknown): SyncFailure {
  if (error instanceof ProError) {
    if (error.status === 409) return { message: 'Syncing…', minDelayMs: 0, shrink: false, raced: true };
    if (error.status === 413) {
      return { message: 'Your Tabfold account is full. Trying again with fewer tabs.', minDelayMs: 60_000, shrink: true };
    }
    switch (error.code) {
      case 'offline':
        return { message: 'Can’t reach your Tabfold account. Trying again soon.', minDelayMs: 0, shrink: false };
      case 'not-signed-in':
      case 'needs-pro':
      case 'needs-pro-ai':
      case 'not-configured':
        return { message: error.message, minDelayMs: 15 * 60_000, shrink: false };
      default:
        break;
    }
  }
  return { message: 'Couldn’t sync with your Tabfold account. Trying again later.', minDelayMs: 0, shrink: false };
}

export interface CloudSyncArea extends SyncArea {
  /** The version read last (0 before the first write). */
  readonly version: number;
}

/**
 * The account's `tf.` items on the server. `getAll` remembers the version; a write is based on it.
 * `onPlanMismatch` runs when the server says the plan doesn't include sync (the cached plan is out
 * of date).
 */
export function cloudSyncArea(request: ApiRequest = api, onPlanMismatch?: () => void): CloudSyncArea {
  let version = 0;
  const call = async <T>(path: string, init?: Parameters<ApiRequest>[1]): Promise<T> => {
    try {
      return await request<T>(path, init);
    } catch (error) {
      if (error instanceof ProError && (error.status === 401 || error.status === 402)) onPlanMismatch?.();
      throw error;
    }
  };
  const write = async (set: Record<string, unknown>, remove: string[]) => {
    if (Object.keys(set).length === 0 && remove.length === 0) return;
    const result = await call<{ version?: unknown }>('/sync', { method: 'POST', body: { set, remove, baseVersion: version } });
    if (typeof result?.version === 'number') version = result.version;
  };
  return {
    label: 'your Tabfold account',
    checksVersion: true,
    get version() {
      return version;
    },
    async getAll() {
      const result = await call<{ items?: unknown; version?: unknown }>('/sync');
      version = typeof result?.version === 'number' ? result.version : 0;
      const items = result?.items && typeof result.items === 'object' ? (result.items as Record<string, unknown>) : {};
      return Object.fromEntries(Object.entries(items).filter(([key]) => key.startsWith(SYNC_PREFIX)));
    },
    write,
    set: (items) => write(items, []),
    remove: (keys) => write({}, keys),
    describeError: describeCloudError,
  };
}

export function cloudSyncDeps(): SyncDeps {
  return {
    database: db,
    area: cloudSyncArea(api, () => {
      refreshPlan({ force: true }).catch(() => undefined);
    }),
    store: cloudSyncState,
    deviceId: getDeviceId,
    enabled: cloudSyncActive,
    isWiped: async () => (await checkWiped(db)).wiped,
    now: () => Date.now(),
    limits: CLOUD_LIMITS,
  };
}

/**
 * "Clear all data": empty the Tabfold account's copy too, leaving only the time of the clear, so no
 * computer shares tabs folded before it again. Never throws: the local clear has already happened.
 * (Daily backups on the server are deleted after 30 days.)
 */
export async function clearCloudSyncedData(now = Date.now(), request: ApiRequest = api): Promise<void> {
  const floor = toSyncTime(now);
  // This computer first, so it never pushes the old copy back.
  await cloudSyncState.set({ ...defaultSyncState(), floor }).catch(() => undefined);
  if (!(await cloudSyncActive().catch(() => false))) return;
  const { items } = pack([], [], { floor, limits: CLOUD_LIMITS });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const area = cloudSyncArea(request);
      const current = await area.getAll();
      await area.write!(items, Object.keys(current).filter((key) => !(key in items)));
      return;
    } catch (error) {
      // Another computer wrote in between: read again and clear again.
      if (error instanceof ProError && error.status === 409) continue;
      console.warn('[tabfold] could not clear the Tabfold account', (error as Error)?.message ?? error);
      return;
    }
  }
}
