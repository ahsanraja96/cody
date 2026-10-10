import { browser } from 'wxt/browser';
import { captureHash, planCapture } from '../capture';
import { refreshDataGuard } from '../dataGuard';
import { db } from '../db';
import { formatDateTime } from '../format';
import { addSnapshot, latestSnapshot, pruneSnapshots, saveCapture } from '../repo';
import { getDeviceId, recoveryOffer, snapshotMirror, windowNames, type SnapshotMirror } from '../state';
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

/** The mirror in chrome.storage is capped so extension storage stays small. */
export const MIRROR_MAX_TABS = 2000;

/** A copy of a snapshot for chrome.storage: at most 2,000 tabs, without inline (data:) favicons. */
export function mirrorOf(windows: CapturedWindow[], createdAt: number): SnapshotMirror {
  let left = MIRROR_MAX_TABS;
  const kept: CapturedWindow[] = [];
  for (const window of windows) {
    if (left <= 0) break;
    const tabs = window.tabs
      .slice(0, left)
      .map((tab) => (tab.favIconUrl.startsWith('data:') ? { ...tab, favIconUrl: '' } : tab));
    left -= tabs.length;
    if (tabs.length) kept.push({ ...window, tabs });
  }
  return { createdAt, tabCount: kept.reduce((n, w) => n + w.tabs.length, 0), windowCount: kept.length, windows: kept };
}

async function writeMirror(windows: CapturedWindow[], createdAt: number): Promise<void> {
  await snapshotMirror.set(mirrorOf(windows, createdAt)).catch((error) => console.warn('[tabfold] snapshot mirror failed', error));
}

/** Once per worker life, make sure an unchanged timer snapshot has its mirror (e.g. right after an update). */
let mirrorChecked = false;

export async function takeSnapshot(reason: SnapshotReason): Promise<number | null> {
  const windows = await captureOpenWindows();
  // Nothing open (for example while the browser is shutting down): keep the previous snapshot.
  if (windows.length === 0) return null;
  const hash = captureHash(windows);
  if (reason === 'timer') {
    const last = await latestSnapshot('timer');
    if (last?.hash === hash && last.id !== undefined) {
      if (!mirrorChecked) {
        mirrorChecked = true;
        if (!(await snapshotMirror.get())) await writeMirror(last.windows, last.createdAt);
      }
      return last.id;
    }
  }
  const createdAt = Date.now();
  const id = await addSnapshot({
    createdAt,
    reason,
    hash,
    windows,
    tabCount: windows.reduce((n, w) => n + w.tabs.length, 0),
    windowCount: windows.length,
  });
  // The rolling and shutdown snapshots are also kept outside IndexedDB, to recover from a wipe.
  if (reason === 'timer' || reason === 'shutdown') {
    await writeMirror(windows, createdAt);
    mirrorChecked = true;
  }
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
    await writeMirror(last.windows, last.createdAt);
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

/**
 * After the database was wiped: save the copy of the last snapshot kept in chrome.storage as a
 * session (nothing opens until the user restores it).
 */
export async function recoverFromMirror(): Promise<{ sessionId: string | null }> {
  const mirror = await snapshotMirror.get();
  if (!mirror || !mirror.windows.some((w) => w.tabs.length > 0)) return { sessionId: null };
  const result = await saveCapture(
    mirror.windows,
    {
      name: `Recovered · ${formatDateTime(mirror.createdAt)}`,
      source: 'snapshot',
      deviceId: await getDeviceId(),
      now: Date.now(),
    },
    { dedupe: false },
  );
  await refreshDataGuard().catch(() => undefined);
  return { sessionId: result.savedTabIds.length ? result.sessionId : null };
}
