import { browser } from 'wxt/browser';
import { captureHash, planCapture } from '../capture';
import { db } from '../db';
import { addSnapshot, latestSnapshot, pruneSnapshots } from '../repo';
import { recoveryOffer, windowNames } from '../state';
import type { CapturedWindow, SnapshotReason } from '../types';
import { getGroups, getNormalWindows, ownOrigin, setAttentionBadge } from './browserState';

/**
 * Background snapshots of what is open, for crash recovery. A rolling "timer" snapshot follows
 * changes (debounced) and a 5-minute alarm. At browser start the last one becomes the "shutdown"
 * snapshot, and if Chrome did not bring those tabs back, the popup offers to restore them.
 */

const DEBOUNCE_MS = 4000;
let timer: ReturnType<typeof setTimeout> | undefined;

function stripSources(windows: CapturedWindow[]): CapturedWindow[] {
  return windows.map(({ sourceWindowId: _w, ...window }) => ({
    ...window,
    tabs: window.tabs.map(({ sourceTabId: _t, ...tab }) => tab),
  }));
}

export async function captureOpenWindows(): Promise<CapturedWindow[]> {
  const [windows, groups, names] = await Promise.all([getNormalWindows(), getGroups(), windowNames.get()]);
  const plan = planCapture(windows, groups, {
    scope: 'all',
    keepPinnedOpen: false,
    skipBlank: true,
    includeAllWindows: true,
    audible: 'close',
    ownOrigin: ownOrigin(),
    windowNames: names,
  });
  return stripSources(plan.windows);
}

export async function takeSnapshot(reason: SnapshotReason): Promise<number | null> {
  const windows = await captureOpenWindows();
  // Nothing open (for example while the browser is shutting down): keep the previous snapshot.
  if (windows.length === 0) return null;
  const hash = captureHash(windows);
  if (reason === 'timer') {
    const last = await latestSnapshot('timer');
    if (last?.hash === hash && last.id !== undefined) return last.id;
  }
  const id = await addSnapshot({
    createdAt: Date.now(),
    reason,
    hash,
    windows,
    tabCount: windows.reduce((n, w) => n + w.tabs.length, 0),
    windowCount: windows.length,
  });
  await pruneSnapshots();
  return id;
}

export function scheduleSnapshot(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    takeSnapshot('timer').catch((error) => console.error('[tabfold] snapshot failed', error));
  }, DEBOUNCE_MS);
}

/**
 * Called once at browser start, within milliseconds and so before the first debounced snapshot:
 * the last rolling snapshot becomes the "shutdown" one, which later snapshots never replace.
 */
export async function promoteShutdownSnapshot(): Promise<void> {
  // A recovery offer the user hasn't answered yet points at the current shutdown snapshot; keep it.
  if (await recoveryOffer.get()) return;
  const last = await latestSnapshot('timer');
  if (last?.id !== undefined) {
    await db.snapshots.update(last.id, { reason: 'shutdown' });
    await pruneSnapshots();
  }
}

/** If the tabs from the last session are not open again, offer to restore them. */
export async function checkRecovery(): Promise<void> {
  const shutdown = await latestSnapshot('shutdown');
  if (!shutdown || shutdown.id === undefined || shutdown.tabCount < 2) return;
  const open = await browser.tabs.query({ windowType: 'normal' });
  const openUrls = new Set(open.map((t) => t.url || t.pendingUrl || ''));
  const saved = shutdown.windows.flatMap((w) => w.tabs.map((t) => t.url));
  const overlap = saved.filter((url) => openUrls.has(url)).length / saved.length;
  if (overlap >= 0.5) return;
  await recoveryOffer.set({
    snapshotId: shutdown.id,
    createdAt: shutdown.createdAt,
    tabCount: shutdown.tabCount,
    windowCount: shutdown.windowCount,
  });
  await setAttentionBadge(true);
}

export async function dismissRecovery(): Promise<void> {
  await recoveryOffer.set(null);
  await setAttentionBadge(false);
}
