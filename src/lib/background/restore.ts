import { browser, type Browser } from 'wxt/browser';
import { db } from '../db';
import type { Command, RestoreFailure, RestoreMode, RestoreOutcome, ScreenArea } from '../messages';
import { getSessionGraph, saveCapture, trashSessions } from '../repo';
import { getSettings } from '../settings';
import { getDeviceId, recoveryOffer } from '../state';
import { classifyUrl } from '../urls';
import { formatDateTime } from '../format';
import {
  broadcast,
  currentNormalWindowId,
  getNormalWindows,
  ownOrigin,
  setAttentionBadge,
  sleep,
  windowExists,
} from './browserState';
import {
  chunk,
  findOpenCopy,
  fitBounds,
  fromCaptured,
  groupKey,
  refuseToOpen,
  safeGroupColor,
  type RestoreTab,
  type RestoreWindow,
} from './restorePlan';
import { takeSnapshot } from './snapshots';

/** Tabs are opened in batches so restoring hundreds never spikes memory or CPU. */
const BATCH_SIZE = 10;

const cancelled = new Set<string>();

export function cancelRestore(restoreId: string): boolean {
  cancelled.add(restoreId);
  return true;
}

/** Turn a freshly created background tab into a discarded one so it loads only when clicked. */
async function discardQuietly(tabId: number): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const tab = await browser.tabs.discard(tabId);
      return tab?.id ?? tabId;
    } catch {
      await sleep(250);
    }
  }
  return tabId;
}

interface RestoreOptions {
  mode: RestoreMode;
  lazy: boolean;
  currentWindowId?: number;
  screen?: ScreenArea;
  restoreId?: string;
  /** Per window: reopen into this existing browser window instead of a new one (used by undo). */
  targetWindowIds?: Array<number | undefined>;
}

interface RestoreResult {
  opened: number;
  failed: RestoreFailure[];
  cancelled: boolean;
}

export async function restoreWindows(windows: RestoreWindow[], options: RestoreOptions): Promise<RestoreResult> {
  const origin = ownOrigin();
  const restoreId = options.restoreId ?? crypto.randomUUID();
  const total = windows.reduce((n, w) => n + w.tabs.length, 0);
  const failed: RestoreFailure[] = [];
  let opened = 0;
  let done = 0;
  let fileAccess = true;
  try {
    fileAccess = await browser.extension.isAllowedFileSchemeAccess();
  } catch {
    fileAccess = false;
  }

  let sharedWindowId: number | undefined;
  if (options.mode === 'current') {
    const current = options.currentWindowId ?? (await currentNormalWindowId());
    if (await windowExists(current)) sharedWindowId = current;
  }

  for (const [windowIndex, plan] of windows.entries()) {
    if (cancelled.has(restoreId)) break;
    const tabs = plan.tabs.filter((tab) => {
      const blocked = refuseToOpen(tab.url, origin) || (classifyUrl(tab.url) === 'file' && !fileAccess);
      if (blocked) {
        failed.push({ url: tab.url, title: tab.title });
        done += 1;
      }
      return !blocked;
    });
    if (tabs.length === 0) continue;

    let windowId: number | undefined;
    let placeholderTabId: number | undefined;
    let activateFirst = false;
    const target = options.targetWindowIds?.[windowIndex];
    if (await windowExists(target)) {
      windowId = target;
    } else if ((options.mode === 'current' || options.mode === 'new-window') && sharedWindowId !== undefined) {
      windowId = sharedWindowId;
    } else {
      const bounds = fitBounds(plan.bounds, options.screen);
      const focused = plan.focused || windowIndex === 0;
      let created: Browser.windows.Window | undefined;
      try {
        created = await browser.windows.create({ focused, ...(bounds ?? {}) });
      } catch {
        // Chrome refuses bounds it thinks are off-screen (its idea of the screens can differ from
        // the page's). Open at the default size instead of failing the restore.
        created = await browser.windows.create({ focused }).catch(() => undefined);
      }
      windowId = created?.id;
      placeholderTabId = created?.tabs?.[0]?.id;
      activateFirst = true;
      if (windowId !== undefined && (plan.state === 'maximized' || plan.state === 'fullscreen')) {
        await browser.windows.update(windowId, { state: plan.state }).catch(() => undefined);
      }
      if (options.mode === 'new-window') sharedWindowId = windowId;
    }
    if (windowId === undefined) {
      for (const tab of tabs) failed.push({ url: tab.url, title: tab.title });
      continue;
    }

    const groups = new Map<string, { tab: RestoreTab; ids: number[] }>();
    let isFirst = true;
    for (const batch of chunk(tabs, BATCH_SIZE)) {
      if (cancelled.has(restoreId)) break;
      const results = await Promise.all(
        batch.map(async (tab, offset) => {
          const active = activateFirst && isFirst && offset === 0;
          try {
            const created = await browser.tabs.create({ windowId, url: tab.url, active, pinned: tab.pinned });
            let id = created.id;
            if (id !== undefined && options.lazy && !active) id = await discardQuietly(id);
            return { tab, id };
          } catch {
            failed.push({ url: tab.url, title: tab.title });
            return { tab, id: undefined };
          }
        }),
      );
      isFirst = false;
      for (const { tab, id } of results) {
        done += 1;
        if (id === undefined) continue;
        opened += 1;
        const key = groupKey(tab);
        if (key && !tab.pinned) {
          const entry = groups.get(key) ?? { tab, ids: [] };
          entry.ids.push(id);
          groups.set(key, entry);
        }
      }
      broadcast({ type: 'restore-progress', restoreId, done, total });
    }

    for (const { tab, ids } of groups.values()) {
      try {
        const groupId = await browser.tabs.group({ tabIds: ids as [number, ...number[]], createProperties: { windowId } });
        await browser.tabGroups.update(groupId, {
          title: tab.groupName ?? '',
          color: safeGroupColor(tab.groupColor),
          collapsed: tab.groupCollapsed,
        });
      } catch {
        // Groups are a nicety; the tabs themselves are open.
      }
    }
    if (placeholderTabId !== undefined) await browser.tabs.remove(placeholderTabId).catch(() => undefined);
  }

  const wasCancelled = cancelled.delete(restoreId);
  return { opened, failed, cancelled: wasCancelled };
}

type RestoreCommand = Extract<Command, { type: 'restore' }>;

export async function handleRestore(command: RestoreCommand): Promise<RestoreOutcome> {
  const restoreId = crypto.randomUUID();
  const graph = await getSessionGraph(command.sessionId);
  if (!graph) return { restoreId, opened: 0, failed: [], cancelled: false, trashed: false };
  const windows = command.windowRecordId ? graph.windows.filter((w) => w.id === command.windowRecordId) : graph.windows;

  if (!command.force && command.mode === 'original') {
    const urls = windows.flatMap((w) => w.tabs.map((t) => t.url));
    const openCopy = findOpenCopy(urls, await getNormalWindows());
    if (openCopy !== undefined) {
      return { restoreId, opened: 0, failed: [], cancelled: false, alreadyOpenWindowId: openCopy, trashed: false };
    }
  }

  await takeSnapshot('before-restore').catch(() => undefined);
  const settings = await getSettings();
  const result = await restoreWindows(
    windows.map((w) => ({ name: w.name, bounds: w.bounds, state: w.state, focused: w.wasFocused, tabs: w.tabs })),
    {
      mode: command.mode,
      lazy: settings.lazyRestore,
      currentWindowId: command.currentWindowId,
      screen: command.screen,
      restoreId,
    },
  );

  let trashed = false;
  const wholeSession = !command.windowRecordId;
  if (wholeSession && settings.afterRestore === 'trash' && !result.cancelled && result.failed.length === 0) {
    await trashSessions([graph.session.id]);
    trashed = true;
  }
  return { restoreId, ...result, trashed };
}

type SnapshotRestoreCommand = Extract<Command, { type: 'restore-snapshot' }>;

export async function handleRestoreSnapshot(command: SnapshotRestoreCommand): Promise<RestoreOutcome> {
  const restoreId = crypto.randomUUID();
  const snapshot = await db.snapshots.get(command.snapshotId);
  if (!snapshot) return { restoreId, opened: 0, failed: [], cancelled: false, trashed: false };
  const settings = await getSettings();
  const result = await restoreWindows(fromCaptured(snapshot.windows), {
    mode: command.mode,
    lazy: settings.lazyRestore,
    currentWindowId: command.currentWindowId,
    screen: command.screen,
    restoreId,
  });
  const offer = await recoveryOffer.get();
  if (offer?.snapshotId === command.snapshotId) {
    await recoveryOffer.set(null);
    await setAttentionBadge(false);
  }
  return { restoreId, ...result, trashed: false };
}

export async function handleSnapshotToSession(snapshotId: number): Promise<{ sessionId: string | null }> {
  const snapshot = await db.snapshots.get(snapshotId);
  if (!snapshot) return { sessionId: null };
  const result = await saveCapture(
    snapshot.windows,
    {
      name: `Snapshot · ${formatDateTime(snapshot.createdAt)}`,
      source: 'snapshot',
      deviceId: await getDeviceId(),
      now: Date.now(),
    },
    { dedupe: false },
  );
  return { sessionId: result.sessionId };
}

export async function handleOpenSavedTab(
  tabRecordId: string,
  active: boolean,
  windowId?: number,
): Promise<{ opened: boolean; reason?: string }> {
  const tab = await db.tabs.get(tabRecordId);
  if (!tab) return { opened: false, reason: 'This tab is no longer saved.' };
  if (refuseToOpen(tab.url, ownOrigin())) return { opened: false, reason: 'Chrome does not allow opening this address.' };
  const target = (await windowExists(windowId)) ? windowId : await currentNormalWindowId();
  try {
    const created = await browser.tabs.create({ url: tab.url, active, windowId: target });
    if (active && created.windowId !== undefined) await browser.windows.update(created.windowId, { focused: true });
    return { opened: true };
  } catch {
    return { opened: false, reason: 'Chrome refused to open this address. Copy it and paste it into the address bar.' };
  }
}
