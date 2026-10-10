import Dexie from 'dexie';
import { browser } from 'wxt/browser';
import { checkWiped } from '../dataGuard';
import { db, DB_NAME, getSearchVersion, type TabfoldDB } from '../db';
import { applySyncChanges, listFoldedTabs } from '../repo';
import { getSettings } from '../settings';
import { getDeviceId, syncStatus, type SyncStatus } from '../state';
import { localSyncState, type SyncStateStore } from './localState';
import { planSync } from './merge';
import { diffItems, META_KEY, SYNC_PREFIX, unpack } from './records';

/**
 * Chrome sync of folded tabs, run by the service worker. The newest folded tabs go into
 * chrome.storage.sync a few seconds after each local change, and what other computers shared
 * comes in when Chrome delivers it (storage.onChanged) and at startup. Chrome doesn't tell
 * extensions whether the person is signed in, so "synced" means written to chrome.storage.sync.
 * Sync never deletes anything here except tabs the person removed on another computer.
 */

/** The `tf.` keys in chrome.storage.sync. */
export interface SyncArea {
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export const chromeSyncArea: SyncArea = {
  async getAll() {
    const all = await browser.storage.sync.get(null);
    return Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith(SYNC_PREFIX)));
  },
  set: (items) => browser.storage.sync.set(items),
  remove: (keys) => browser.storage.sync.remove(keys),
};

export interface SyncDeps {
  database: TabfoldDB;
  area: SyncArea;
  store: SyncStateStore;
  deviceId: () => Promise<string>;
  enabled: () => Promise<boolean>;
  /** The database looks erased from outside (see dataGuard): don't sync until that's dealt with. */
  isWiped: () => Promise<boolean>;
  now: () => number;
}

export function defaultSyncDeps(): SyncDeps {
  return {
    database: db,
    area: chromeSyncArea,
    store: localSyncState,
    deviceId: getDeviceId,
    enabled: async () => (await getSettings()).syncWithChrome,
    isWiped: async () => (await checkWiped(db)).wiped,
    now: () => Date.now(),
  };
}

export type SkipReason = 'off' | 'unchanged' | 'backoff' | 'wiped' | 'partial' | 'rate' | 'raced';

export interface SyncRunResult {
  status: SyncStatus;
  /** Wrote to chrome.storage.sync. */
  wrote: boolean;
  /** Changed the list on this computer. */
  applied: boolean;
  skipped?: SkipReason;
  /** When to try again after an error or a partial copy (ms since epoch). */
  retryAt?: number;
}

/** Writes per minute and per hour Tabfold allows itself (Chrome allows 120 and 1,800). */
const MAX_WRITES_PER_MINUTE = 20;
const MAX_WRITES_PER_HOUR = 600;
const PARTIAL_RETRY_MS = 10_000;
const RACE_RETRY_MS = 2_000;
const MAX_PARTIAL_RUNS = 3;

function offStatus(now: number): SyncStatus {
  return { state: 'off', syncedTabs: 0, localOnly: 0, at: now };
}

interface Failure {
  message: string;
  minDelayMs: number;
  shrink: boolean;
}

function classify(error: unknown): Failure {
  const text = String((error as { message?: string })?.message ?? error);
  if (/QUOTA_BYTES|MAX_ITEMS/i.test(text)) {
    return { message: 'Chrome sync is full. Trying again soon.', minDelayMs: 60_000, shrink: true };
  }
  if (/MAX_WRITE_OPERATIONS_PER_HOUR/i.test(text)) {
    return { message: 'Chrome sync is busy. Trying again later.', minDelayMs: 15 * 60_000, shrink: false };
  }
  if (/MAX_WRITE_OPERATIONS/i.test(text)) {
    return { message: 'Chrome sync is busy. Trying again in a minute.', minDelayMs: 60_000, shrink: false };
  }
  return { message: 'Couldn’t reach Chrome sync. Trying again later.', minDelayMs: 0, shrink: false };
}

/** 30 s, 1 min, 2 min… up to 30 min. */
export function backoffMs(failures: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
}

/** One sync run: merge what came in, apply it here, write the shared copy if it changed. */
export async function syncOnce(
  deps: SyncDeps,
  options: { force?: boolean; previous?: SyncStatus; onStatus?: (status: SyncStatus) => Promise<void> | void } = {},
): Promise<SyncRunResult> {
  const now = deps.now();
  const previous = options.previous;
  if (!(await deps.enabled())) return { status: offStatus(now), wrote: false, applied: false, skipped: 'off' };

  let state = await deps.store.get();
  const startFloor = state.floor;
  const counts = { syncedTabs: previous?.syncedTabs ?? 0, localOnly: previous?.localOnly ?? 0 };
  if (!options.force && state.retryAt > now) {
    return {
      status: previous ?? { state: 'error', ...counts, at: now, error: 'Trying again soon.' },
      wrote: false,
      applied: false,
      skipped: 'backoff',
      retryAt: state.retryAt,
    };
  }

  const fail = async (error: unknown, message?: string): Promise<SyncRunResult> => {
    const failure = classify(error);
    const failures = state.failures + 1;
    const retryAt = now + Math.max(failure.minDelayMs, backoffMs(failures));
    state = {
      ...state,
      failures,
      retryAt,
      lastHash: null,
      budgetFactor: failure.shrink ? Math.max(0.5, state.budgetFactor * 0.85) : state.budgetFactor,
    };
    await deps.store.set(state).catch(() => undefined);
    console.warn('[tabfold] sync failed', error);
    return {
      status: { state: 'error', ...counts, at: now, error: message ?? failure.message },
      wrote: false,
      applied: false,
      retryAt,
    };
  };

  let items: Record<string, unknown>;
  try {
    items = await deps.area.getAll();
  } catch (error) {
    return fail(error);
  }
  const remote = unpack(items);
  const version = await getSearchVersion(deps.database);

  // Nothing changed here or in Chrome sync since the last run (this includes the echo of our own write).
  if (
    !options.force &&
    previous?.state === 'synced' &&
    state.failures === 0 &&
    state.partialRuns === 0 &&
    (remote.meta?.h ?? null) === state.lastHash &&
    version === state.lastVersion
  ) {
    return { status: previous, wrote: false, applied: false, skipped: 'unchanged' };
  }

  if (await deps.isWiped()) {
    // Never treat an erased list as "the person removed everything": forget what was shared.
    await deps.store.set({ ...state, known: {}, lastHash: null, lastVersion: null });
    return {
      status: { state: 'error', ...counts, at: now, error: 'Paused while the list on this computer is recovered.' },
      wrote: false,
      applied: false,
      skipped: 'wiped',
    };
  }

  const deviceId = await deps.deviceId();
  // Tabs folded from Incognito stay on this computer: they never go to Chrome sync.
  const local = (await listFoldedTabs(deps.database)).filter((tab) => !tab.incognito).map((tab) => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    savedAt: tab.savedAt,
    keywords: tab.keywords,
  }));
  const plan = planSync({
    local,
    remote,
    known: state.known,
    mine: state.mine,
    floor: state.floor,
    now,
    budgetFactor: state.budgetFactor,
  });

  const changesHere = plan.remove.length + plan.update.length + plan.adopt.length + plan.insert.length > 0;
  const diff = diffItems(items, plan.packed.items);
  const needsWrite = Object.keys(diff.set).length > 0 || diff.remove.length > 0;
  if (changesHere || needsWrite) await options.onStatus?.({ state: 'syncing', ...counts, at: now });

  // "Clear all data" on a Tabfold page, or another write to Chrome sync, while this run was
  // working: its plan is out of date. Start again shortly instead of applying or writing it.
  const raced = async () => {
    const [latestState, latestItems] = await Promise.all([deps.store.get(), deps.area.getAll()]);
    return latestState.floor !== state.floor || JSON.stringify(latestItems[META_KEY]) !== JSON.stringify(items[META_KEY]);
  };
  const retrySoon = (): SyncRunResult => ({
    status: { state: 'syncing', ...counts, at: now },
    wrote: false,
    applied: false,
    skipped: 'raced',
    retryAt: now + RACE_RETRY_MS,
  });
  if ((changesHere || needsWrite) && (await raced())) return retrySoon();

  let inboxId = state.inboxId;
  if (changesHere) {
    try {
      ({ inboxId } = await applySyncChanges(
        {
          remove: plan.remove,
          update: plan.update,
          adopt: plan.adopt.map(({ localId, record }) => ({ localId, tab: record })),
          insert: plan.insert,
        },
        { inboxId, deviceId, now },
        deps.database,
      ));
    } catch (error) {
      return fail(error, 'Couldn’t update your list from Chrome sync. Trying again later.');
    }
  }

  const recentWrites = state.writes.filter((at) => at > now - 60 * 60_000);
  let wrote = false;
  if (needsWrite) {
    // Chrome delivers a copy key by key: wait a little for the rest before writing over it.
    if (!remote.complete && remote.meta && state.partialRuns < MAX_PARTIAL_RUNS && !options.force) {
      // `known` stays as it was: removals made here are found again, and written, next time.
      state = { ...state, partialRuns: state.partialRuns + 1, inboxId, lastHash: null };
      await deps.store.set(state);
      return {
        status: { state: 'syncing', ...counts, at: now },
        wrote: false,
        applied: changesHere,
        skipped: 'partial',
        retryAt: now + PARTIAL_RETRY_MS,
      };
    }
    const lastMinute = recentWrites.filter((at) => at > now - 60_000).length;
    if (lastMinute >= MAX_WRITES_PER_MINUTE || recentWrites.length >= MAX_WRITES_PER_HOUR) {
      const retryAt = now + (lastMinute >= MAX_WRITES_PER_MINUTE ? 60_000 : 15 * 60_000);
      state = { ...state, retryAt, inboxId, lastHash: null };
      await deps.store.set(state);
      return { status: { state: 'syncing', ...counts, at: now }, wrote: false, applied: changesHere, skipped: 'rate', retryAt };
    }
    if (changesHere && (await raced())) {
      await deps.store.set({ ...state, inboxId, lastHash: null });
      return { ...retrySoon(), applied: true };
    }
    try {
      // New chunks and the meta record first; leftover chunks after, so readers never see a gap.
      if (Object.keys(diff.set).length) await deps.area.set(diff.set);
      if (diff.remove.length) await deps.area.remove(diff.remove);
      wrote = true;
    } catch (error) {
      state = { ...state, inboxId };
      return fail(error);
    }
  }

  // "Clear all data" reset this computer's state while the run finished: keep the reset.
  if ((await deps.store.get()).floor !== startFloor) return { ...retrySoon(), wrote, applied: changesHere };
  state = {
    ...state,
    known: plan.known,
    mine: plan.mine,
    floor: plan.floor,
    inboxId,
    lastHash: plan.packed.hash,
    lastVersion: await getSearchVersion(deps.database),
    failures: 0,
    retryAt: 0,
    partialRuns: 0,
    writes: wrote ? [...recentWrites, now].slice(-MAX_WRITES_PER_HOUR) : recentWrites,
  };
  await deps.store.set(state);
  return {
    status: { state: 'synced', syncedTabs: plan.counts.synced, localOnly: plan.counts.localOnly, at: now },
    wrote,
    applied: changesHere,
  };
}

// ---------------------------------------------------------------------------------------------
// Running it in the service worker

/** After a local change; after something arrived from Chrome sync; after the worker starts. */
const LOCAL_DEBOUNCE_MS = 5_000;
const REMOTE_DEBOUNCE_MS = 2_000;
const STARTUP_DELAY_MS = 3_000;
/** Changes that keep coming push a run back, but never more than this after the first. */
const MAX_WAIT_MS = 20_000;

let timer: ReturnType<typeof setTimeout> | undefined;
let firstAt = 0;
let running: Promise<SyncRunResult | null> | null = null;
let again = false;

function sameStatus(a: SyncStatus | undefined, b: SyncStatus): boolean {
  return !!a && a.state === b.state && a.syncedTabs === b.syncedTabs && a.localOnly === b.localOnly && a.error === b.error;
}

async function writeStatus(status: SyncStatus): Promise<void> {
  const current = await syncStatus.get().catch(() => undefined);
  if (!sameStatus(current, status)) await syncStatus.set(status).catch(() => undefined);
}

export function scheduleSync(delayMs = LOCAL_DEBOUNCE_MS): void {
  const now = Date.now();
  let due = now + delayMs;
  if (timer) {
    clearTimeout(timer);
    due = Math.min(due, firstAt + MAX_WAIT_MS);
  } else {
    firstAt = now;
  }
  timer = setTimeout(
    () => {
      timer = undefined;
      runSync().catch((error) => console.error('[tabfold] sync failed', error));
    },
    Math.max(0, due - now),
  );
}

/** Run a sync now in this worker (one at a time). `force` ignores the back-off and the unchanged check. */
export async function runSync(options: { force?: boolean } = {}): Promise<SyncRunResult | null> {
  if (running) {
    if (!options.force) {
      again = true;
      return running;
    }
    await running.catch(() => null);
  }
  const run = (async () => {
    const previous = await syncStatus.get().catch(() => undefined);
    const result = await syncOnce(defaultSyncDeps(), { force: options.force, previous, onStatus: writeStatus });
    await writeStatus(result.status);
    if (result.retryAt && result.retryAt - Date.now() < 10 * 60_000) scheduleSync(Math.max(1_000, result.retryAt - Date.now()));
    return result;
  })();
  running = run;
  try {
    return await run;
  } finally {
    if (running === run) running = null;
    if (again) {
      again = false;
      scheduleSync(1_000);
    }
  }
}

/** The `sync-now` command: push (and pull) at once. */
export async function syncNow(): Promise<{ ok: boolean }> {
  const result = await runSync({ force: true });
  return { ok: !!result && result.status.state !== 'error' && result.status.state !== 'off' };
}

function touchesFolds(parts: Record<string, unknown>): boolean {
  return Object.keys(parts).some(
    (key) => key.startsWith(`idb://${DB_NAME}/tabs/`) || key.startsWith(`idb://${DB_NAME}/sessions/`),
  );
}

/** Register listeners (once, at the worker's top level) and run once shortly after start. */
export function setupSync(): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && Object.keys(changes).some((key) => key.startsWith(SYNC_PREFIX))) {
      scheduleSync(REMOTE_DEBOUNCE_MS);
    } else if (area === 'local' && 'settings' in changes) {
      const change = changes.settings as { oldValue?: { syncWithChrome?: boolean }; newValue?: { syncWithChrome?: boolean } };
      if ((change.oldValue?.syncWithChrome ?? true) !== (change.newValue?.syncWithChrome ?? true)) scheduleSync(0);
    }
  });
  // Folded tabs changed, here or on a Tabfold page (Dexie tells every page and the worker).
  Dexie.on('storagemutated', (parts) => {
    if (touchesFolds(parts as Record<string, unknown>)) scheduleSync(LOCAL_DEBOUNCE_MS);
  });
  scheduleSync(STARTUP_DELAY_MS);
}

/** From the worker's 1-minute alarm: catches changes made while the worker was asleep. Cheap when nothing changed. */
export function syncTick(): Promise<unknown> {
  return runSync();
}

