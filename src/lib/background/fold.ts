import { browser } from 'wxt/browser';
import { refreshDataGuard } from '../dataGuard';
import { isQuotaError } from '../db';
import { estimateBytes } from '../format';
import { CommandError, type FoldOutcome, type MemoryReading, type WorkerEvent } from '../messages';
import { saveCapture } from '../repo';
import { getSettings } from '../settings';
import { activeFold, getDeviceId, type ActiveFold } from '../state';
import { broadcast, getNormalWindows, sleep } from './browserState';
import {
  buildPlan,
  capturedTabs,
  closeTabsSafely,
  plannedTabs,
  recordUndo,
  refusedRef,
  saveQueue,
  stillOpen,
  tabsById,
} from './save';
import { takeSnapshot } from './snapshots';

/**
 * Fold: save every tab in every normal window, then close it. Pinned tabs (per the setting) and
 * tabs playing sound stay open; tabs already folded are closed but not saved twice. Progress is
 * kept in `activeFold` and broadcast as `fold-progress`: saving, then closing in batches of 10,
 * then (when some tabs show Chrome's "Leave site?" dialog) waiting up to about 20 s for answers.
 */

const BATCH_SIZE = 10;
/** Tabs still open after closing are checked this often, this many times (about 20 s). */
const WAIT_STEP_MS = 500;
const WAIT_CHECKS = 40;
/** Free memory is read again this long after the tabs closed, once Chrome has let go of it. */
const MEMORY_SETTLE_MS = 2000;

const STORAGE_FULL = 'Chrome is out of storage space. Free up some disk space, then try again.';

interface MemoryInfo {
  available: number;
  capacity: number;
}

/** The computer's free and total memory (chrome.system.memory), or null when it can't be read. */
export async function readMemory(): Promise<MemoryInfo | null> {
  const api = (browser as unknown as { system?: { memory?: { getInfo?: () => Promise<{ capacity: number; availableCapacity: number }> } } })
    .system?.memory;
  if (typeof api?.getInfo !== 'function') return null;
  try {
    const info = await api.getInfo();
    if (!Number.isFinite(info?.availableCapacity) || !Number.isFinite(info?.capacity)) return null;
    return { available: info.availableCapacity, capacity: info.capacity };
  } catch {
    return null;
  }
}

function memoryReading(before: MemoryInfo | null, after: MemoryInfo | null): MemoryReading {
  return {
    freeBefore: before?.available ?? null,
    freeAfter: after?.available ?? null,
    capacity: (after ?? before)?.capacity ?? null,
  };
}

/**
 * One fold at a time: a second request while one runs gets the running one's outcome. Folds and
 * saves share a queue, so they never race to close the same tabs.
 */
export function handleFold(): Promise<FoldOutcome> {
  return saveQueue('fold', runFold, 0) as Promise<FoldOutcome>;
}

async function runFold(): Promise<FoldOutcome> {
  const foldId = crypto.randomUUID();
  const settings = await getSettings();
  const windows = await getNormalWindows();
  // Every normal window, whatever the old "current window only" setting says.
  const plan = await buildPlan(windows, { scope: 'all', audible: 'keep' }, { ...settings, includeAllWindows: true });
  const total = plan.closeTabIds.length;

  let progress: ActiveFold = { foldId, phase: 'saving', total, closed: 0, waiting: [], startedAt: Date.now() };
  const report = async (patch: Partial<ActiveFold>) => {
    progress = { ...progress, ...patch };
    await activeFold.set(progress).catch(() => undefined);
    const event: WorkerEvent = { type: 'fold-progress', fold: progress };
    broadcast(event);
  };

  const outcome: FoldOutcome = {
    foldId,
    sessionId: null,
    sessionName: '',
    savedTabs: 0,
    closedTabs: 0,
    skippedDuplicates: 0,
    keptOpen: plan.kept,
    stayedOpen: { pinned: plan.kept.pinned, audible: plan.kept.audible },
    failedToClose: [],
    freedBytes: 0,
    intoUnsorted: false,
    actionId: null,
    truncatedTabs: 0,
    newTabsLeftOpen: 0,
    memory: memoryReading(null, null),
  };
  if (plan.windows.length === 0) {
    // Only pinned, playing, blank or Tabfold pages: nothing to fold, nothing closes.
    await report({ phase: 'done', finishedAt: Date.now(), outcome });
    return outcome;
  }

  await report({});
  const before = await readMemory();
  await takeSnapshot('before-bulk-close').catch((error) => console.warn('[tabfold] safety snapshot failed', error));

  const now = Date.now();
  let result;
  try {
    result = await saveCapture(
      plan.windows,
      { source: 'save-all', deviceId: await getDeviceId(), now },
      // Every fold gets its own session (never "Unsorted"): "Recent folds" lists each one.
      { dedupe: true },
    );
  } catch (error) {
    const quota = isQuotaError(error);
    await report({ phase: 'failed', finishedAt: Date.now(), error: quota ? STORAGE_FULL : 'Something went wrong. Nothing was closed.' });
    if (quota) throw new CommandError('Browser storage is full. Nothing was closed. Free up disk space, then try again.', 'quota');
    throw error;
  }
  await refreshDataGuard().catch(() => undefined);

  await report({ phase: 'closing' });
  const byId = tabsById(windows);
  const closing = await closeTabsSafely(plan.closeTabIds, plannedTabs(plan, windows), {
    batchSize: BATCH_SIZE,
    onBatch: (closed) => report({ closed }),
  });

  // Tabs still open a moment later are showing "Leave site?": wait for the person to answer.
  let open = closing.failed;
  if (open.length) {
    await report({ phase: 'waiting', closed: total - open.length, waiting: open.map((t) => refusedRef(t, byId)) });
    for (let check = 0; check < WAIT_CHECKS && open.length; check += 1) {
      await sleep(WAIT_STEP_MS);
      const still = await stillOpen(open.map((t) => t.id!));
      if (still.length !== open.length) {
        open = still;
        await report({ closed: total - open.length, waiting: open.map((t) => refusedRef(t, byId)) });
      }
    }
  }
  const notClosed = new Set(open.map((t) => t.id!));
  const closedTabs = total - notClosed.size;

  if (before && closedTabs > 0) await sleep(MEMORY_SETTLE_MS);
  const after = before ? await readMemory() : null;

  const skipped = new Set(result.skippedTabs.map((s) => s.tab));
  const written = capturedTabs(plan).filter((t) => !skipped.has(t));
  const freedBytes = estimateBytes(plan.closeTabIds.filter((id) => byId.has(id) && !byId.get(id)!.discarded && !notClosed.has(id)).length);
  const actionId = await recordUndo({ result, plan, now, close: true, closedTabs, freedBytes, stillOpen: notClosed, incognito: false });

  const done: FoldOutcome = {
    ...outcome,
    sessionId: result.sessionId || null,
    sessionName: result.sessionName,
    savedTabs: result.savedTabIds.length,
    closedTabs,
    skippedDuplicates: result.skippedDuplicates,
    failedToClose: open.map((t) => refusedRef(t, byId)),
    freedBytes,
    intoUnsorted: result.intoUnsorted,
    actionId,
    truncatedTabs: written.filter((t) => t.urlTruncated).length,
    newTabsLeftOpen: closing.newTabsLeftOpen,
    memory: memoryReading(before, after),
  };
  await report({ phase: 'done', closed: closedTabs, waiting: [], finishedAt: Date.now(), outcome: done });
  return done;
}

/** A fold runs within one worker life; a fresh worker means any fold recorded as running is over. */
export async function forgetUnfinishedFold(): Promise<void> {
  const current = await activeFold.get();
  if (current && current.phase !== 'done' && current.phase !== 'failed') await activeFold.set(null);
}
