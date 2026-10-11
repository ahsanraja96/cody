import { browser, type Browser } from 'wxt/browser';
import { refreshDataGuard } from '../dataGuard';
import { db, isQuotaError } from '../db';
import { estimateBytes } from '../format';
import { CommandError, type FoldOutcome, type MemoryReading, type SaveOutcome, type WorkerEvent } from '../messages';
import { findSavedCopies, saveCapture, type SaveResult } from '../repo';
import { getSettings } from '../settings';
import { activeFold, getDeviceId, type ActiveFold, type LastAction } from '../state';
import type { TabRecord } from '../types';
import { broadcast, getNormalWindows, incognitoAllowed, ownOrigin, sleep } from './browserState';
import { afterFold } from './pro';
import { ensureRoomFor } from './room';
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
 * tabs playing sound stay open; tabs already folded are closed but not saved twice; Tabfold's own
 * pages close without being saved (except the one that started the fold). Incognito windows are
 * folded only with "Fold Incognito windows too" on and "Allow in Incognito" granted. Progress is
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
export interface FoldOptions {
  /** The Tabfold page that asked: it stays open. */
  keepTabId?: number;
  /** Only this window. */
  windowId?: number;
  /** Leave that window open with a new tab (the window you're in). */
  keepWindowOpen?: boolean;
  /**
   * Only these open tabs (snoozing a tab, "Move this tab to a folder", a rule's tabs). They fold as
   * picked: pinned or playing ones too, wherever they are.
   */
  tabIds?: number[];
  /** The saved tabs go in this folder (and a copy already folded moves there). */
  intoFolderId?: string;
  /** A person (default), or an auto-fold rule. */
  source?: 'person' | 'rule';
  /**
   * No progress for the popup (`activeFold`, `fold-progress`): an auto-fold rule, or snoozing a tab.
   * Undo still works (lastAction). Rules are always quiet.
   */
  quiet?: boolean;
}

/** A fold's outcome and, for callers in the worker, the saved tabs it wrote and the copies already folded it skipped. */
export interface FoldRun {
  outcome: FoldOutcome;
  /** Saved tab ids this fold wrote. */
  savedTabIds: string[];
  /** Tabs already folded (skipped as duplicates): their copies in the list. */
  existingCopies: TabRecord[];
}

function foldKey(options: FoldOptions): string {
  if (!options.tabIds) return `fold:${options.windowId ?? 'all'}`;
  return `fold:tabs:${[...options.tabIds].sort((a, b) => a - b).join(',')}:${options.intoFolderId ?? ''}`;
}

/** Fold, for callers in the worker that need the saved tabs (snooze). */
export function foldTabs(options: FoldOptions = {}): Promise<FoldRun> {
  // Folds and saves share one queue; the queue is typed for the saves' outcome.
  return saveQueue(foldKey(options), () => runFold(options) as unknown as Promise<SaveOutcome>, 0) as unknown as Promise<FoldRun>;
}

export async function handleFold(options: FoldOptions = {}): Promise<FoldOutcome> {
  return (await foldTabs(options)).outcome;
}

/**
 * Tabs a fold leaves open that the popup should explain: tabs in app and pop-up windows (never
 * folded), and Incognito tabs while folding Incognito is off. Chrome only shows Tabfold Incognito
 * windows with "Allow in Incognito" on, so without it they can't be counted.
 */
async function leftOut(windows: Browser.windows.Window[], includeIncognito: boolean): Promise<{ apps: number; incognito: number }> {
  const others = await browser.windows.getAll({ populate: true, windowTypes: ['popup', 'app'] }).catch(() => []);
  const origin = ownOrigin();
  return {
    // Tabfold's own small window (keywords) isn't a tab left open.
    apps: others
      .filter((w) => w.type !== 'normal')
      .flatMap((w) => w.tabs ?? [])
      .filter((t) => !(t.url || t.pendingUrl || '').startsWith(origin)).length,
    incognito: includeIncognito ? 0 : windows.filter((w) => w.incognito).reduce((n, w) => n + (w.tabs?.length ?? 0), 0),
  };
}

/**
 * A folder's tabs: the ones this fold wrote go in, and copies already folded move there too (so
 * "Move this tab to a folder" lands it there even when it was folded before). Returns what Undo
 * needs to move those copies back.
 */
async function putInFolder(folderId: string, savedTabIds: string[], copies: TabRecord[]): Promise<NonNullable<LastAction['patches']>> {
  const folder = await db.folders.get(folderId);
  // A folder deleted meanwhile: the tabs stay by kind of site.
  if (!folder || folder.deletedAt) return [];
  const moving = copies.filter((t) => t.folderId !== folderId);
  await db.transaction('rw', db.tabs, async () => {
    if (savedTabIds.length) await db.tabs.where('id').anyOf(savedTabIds).modify({ folderId });
    for (const tab of moving) await db.tabs.update(tab.id, { folderId });
  });
  return moving.map((t) => ({ id: t.id, before: { folderId: t.folderId, snoozeUntil: t.snoozeUntil, snoozedOn: t.snoozedOn } }));
}

/** The copies already in the list of the tabs a fold skipped as duplicates (in the same mode). */
async function copiesOf(result: SaveResult): Promise<TabRecord[]> {
  if (result.skippedTabs.length === 0) return [];
  const normal = result.skippedTabs.filter((s) => !s.incognito).map((s) => s.tab.url);
  const incognito = result.skippedTabs.filter((s) => s.incognito).map((s) => s.tab.url);
  const found = [
    ...(normal.length ? (await findSavedCopies(normal, undefined, db, false)).values() : []),
    ...(incognito.length ? (await findSavedCopies(incognito, undefined, db, true)).values() : []),
  ];
  return [...new Map(found.map((c) => [c.tab.id, c.tab])).values()];
}

async function runFold(options: FoldOptions): Promise<FoldRun> {
  const { keepTabId, windowId, keepWindowOpen, tabIds, intoFolderId } = options;
  const quiet = options.quiet === true || options.source === 'rule';
  const foldId = crypto.randomUUID();
  const settings = await getSettings();
  const windows = await getNormalWindows();
  const includeIncognito = settings.foldIncognito && (await incognitoAllowed());
  const picked = tabIds !== undefined;
  const one = !picked && windowId !== undefined;
  // Picked tabs, one window, or every normal window whatever the old "current window only" setting says.
  const plan = await buildPlan(
    windows,
    picked
      ? { scope: 'tabs', tabIds, audible: 'close', includeIncognito }
      : { scope: one ? 'window' : 'all', windowId, audible: 'keep', includeIncognito },
    { ...settings, includeAllWindows: true },
    keepTabId !== undefined ? [keepTabId] : [],
  );
  // Other windows staying open is the point of folding one window or some tabs: only "all" reports them.
  const left = one || picked ? { apps: 0, incognito: 0 } : await leftOut(windows, includeIncognito);
  const total = plan.closeTabIds.length;

  let progress: ActiveFold = {
    foldId,
    phase: 'saving',
    total,
    closed: 0,
    waiting: [],
    startedAt: Date.now(),
    ...(one ? { windowId } : {}),
  };
  const report = async (patch: Partial<ActiveFold>) => {
    progress = { ...progress, ...patch };
    if (quiet) return;
    await activeFold.set(progress).catch(() => undefined);
    const event: WorkerEvent = { type: 'fold-progress', fold: progress };
    broadcast(event);
  };

  const outcome: FoldOutcome = {
    foldId,
    ...(one ? { windowId } : {}),
    sessionId: null,
    sessionName: '',
    savedTabs: 0,
    closedTabs: 0,
    skippedDuplicates: 0,
    keptOpen: plan.kept,
    stayedOpen: { pinned: plan.kept.pinned, audible: plan.kept.audible, ...left },
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
    return { outcome, savedTabIds: [], existingCopies: [] };
  }

  // The free list's limit: the whole fold fits, or nothing is saved or closed. Tabs already folded
  // close without being saved again, so they don't count.
  try {
    await ensureRoomFor(plan.windows, true);
  } catch (error) {
    if (error instanceof CommandError) {
      await report({
        phase: 'failed',
        finishedAt: Date.now(),
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.details ? { details: error.details } : {}),
      });
    }
    throw error;
  }

  await report({});
  const before = await readMemory();
  // A tab or two picked by a person (snoozing a tab, moving it to a folder) close like "Fold this
  // tab": no safety snapshot.
  if (!picked || options.source === 'rule' || plan.closeTabIds.length > 2) {
    await takeSnapshot('before-bulk-close').catch((error) => console.warn('[tabfold] safety snapshot failed', error));
  }

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
  const existingCopies = await copiesOf(result);
  const patches = intoFolderId ? await putInFolder(intoFolderId, result.savedTabIds, existingCopies) : [];

  await report({ phase: 'closing' });
  const byId = tabsById(windows);
  const closing = await closeTabsSafely(plan.closeTabIds, plannedTabs(plan, windows), {
    batchSize: BATCH_SIZE,
    ...(one && keepWindowOpen ? { keepWindowOpen: windowId } : {}),
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
  const actionId = await recordUndo({ result, plan, now, close: true, closedTabs, freedBytes, stillOpen: notClosed, patches });

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
  // The memory milestone, and a smart name for Pro AI. Never holds up or fails the fold.
  afterFold(done).catch(() => undefined);
  return { outcome: done, savedTabIds: result.savedTabIds, existingCopies };
}

/** A fold runs within one worker life; a fresh worker means any fold recorded as running is over. */
export async function forgetUnfinishedFold(): Promise<void> {
  const current = await activeFold.get();
  if (current && current.phase !== 'done' && current.phase !== 'failed') await activeFold.set(null);
}
