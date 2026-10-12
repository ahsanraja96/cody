import { browser, type Browser } from 'wxt/browser';
import { db } from '../db';
import { refreshDataGuard } from '../dataGuard';
import { markOpened } from '../folders';
import type { Command, RestoreFailure, RestoreMode, RestoreOutcome, ScreenArea, WorkerEvent } from '../messages';
import { getSessionGraph, saveCapture, trashSessions } from '../repo';
import { getSettings } from '../settings';
import { activeRestore, getDeviceId, recoveryOffer, type ActiveRestore } from '../state';
import { classifyUrl } from '../urls';
import { formatDateTime } from '../format';
import {
  broadcast,
  currentNormalWindowId,
  getNormalWindows,
  incognitoAllowed,
  ownOrigin,
  setAttentionBadge,
  sleep,
  windowExists,
} from './browserState';
import {
  chunk,
  describeOpenCopy,
  fitBounds,
  fromCaptured,
  groupKey,
  refuseToOpen,
  safeGroupColor,
  type RestoreTab,
  type RestoreWindow,
} from './restorePlan';
import { rememberGroupFolders } from './foldBack';
import { takeSnapshot } from './snapshots';
import { countCameBack } from './weeklyNumbers';
import { nameReopenedWindow } from './windowNames';

/** Tabs are opened in batches so restoring hundreds never spikes memory or CPU. */
const BATCH_SIZE = 10;

const cancelled = new Set<string>();

export function cancelRestore(restoreId: string): boolean {
  cancelled.add(restoreId);
  return true;
}

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

/** How long a background tab may take to load before it is put to sleep anyway (if its page exists). */
const LOAD_TIMEOUT_MS = 12_000;

/**
 * Lazy restore: let a background tab load once, muted, so it has its real address, title and icon,
 * then put it to sleep. A tab discarded before its page commits has no address and no title: it
 * looks like a blank tab in the tab strip and can wake up to an empty page. Tabs open in batches of
 * 10, so at most 10 load at a time.
 */
export async function sleepWhenLoaded(tabId: number, timeoutMs = LOAD_TIMEOUT_MS): Promise<number> {
  const end = Date.now() + timeoutMs;
  let tab = await browser.tabs.get(tabId).catch(() => undefined);
  while (tab && tab.status !== 'complete' && Date.now() < end) {
    await sleep(200);
    tab = await browser.tabs.get(tabId).catch(() => undefined);
  }
  let id = tabId;
  // Closed, or the user switched to it meanwhile: leave it as it is.
  if (tab && !tab.active && !tab.discarded) {
    const committed = !!tab.url && tab.url !== 'about:blank';
    // Never put a tab to sleep before its page exists: it would wake up blank.
    if (committed) id = await discardQuietly(tabId);
  }
  await browser.tabs.update(id, { muted: false }).catch(() => undefined);
  return id;
}

interface RestoreOptions {
  mode: RestoreMode;
  lazy: boolean;
  currentWindowId?: number;
  screen?: ScreenArea;
  restoreId?: string;
  /** Per window: reopen into this existing browser window instead of a new one (used by undo). */
  targetWindowIds?: Array<number | undefined>;
  /** Open new windows without focusing them, and focus the first one at the end. */
  background?: boolean;
  /** Show this restore to pages (activeRestore and restore-progress events). Undo doesn't. */
  progress?: { sessionId: string | null; snapshotId?: number; name: string };
}

interface RestoreResult {
  opened: number;
  failed: RestoreFailure[];
  cancelled: boolean;
  /** Tab groups made (1.0: "Open all" from a folder remembers its group). */
  groups: Array<{ groupId: number; windowId: number; name: string; incognito: boolean }>;
  /** Tabs opened from Incognito folds (they never count in the weekly numbers). */
  openedIncognito: number;
}

export async function restoreWindows(windows: RestoreWindow[], options: RestoreOptions): Promise<RestoreResult> {
  const origin = ownOrigin();
  const restoreId = options.restoreId ?? crypto.randomUUID();
  const total = windows.reduce((n, w) => n + w.tabs.length, 0);
  const failed: RestoreFailure[] = [];
  const madeGroups: RestoreResult['groups'] = [];
  let opened = 0;
  let openedIncognito = 0;
  let done = 0;
  let fileAccess = true;
  try {
    fileAccess = await browser.extension.isAllowedFileSchemeAccess();
  } catch {
    fileAccess = false;
  }

  // Into the current window or one new window, everything lands in a single window.
  const windowCount = options.mode === 'original' ? windows.length : 1;
  const startedAt = Date.now();
  const report = async (windowIndex: number) => {
    if (!options.progress) return;
    const index = Math.min(options.mode === 'original' ? windowIndex : 0, Math.max(0, windowCount - 1));
    const state: ActiveRestore = {
      restoreId,
      sessionId: options.progress.sessionId,
      ...(options.progress.snapshotId !== undefined ? { snapshotId: options.progress.snapshotId } : {}),
      name: options.progress.name,
      done,
      total,
      windowIndex: index,
      windowCount,
      startedAt,
    };
    await activeRestore.set(state).catch(() => undefined);
    const event: WorkerEvent = {
      type: 'restore-progress',
      restoreId,
      done,
      total,
      windowIndex: index,
      windowCount,
      sessionId: options.progress.sessionId,
    };
    broadcast(event);
  };
  await report(0);

  // "Into the current window" and "into one new window" share one window per mode: tabs folded
  // from Incognito go to an Incognito window, the rest to a normal one, never the other way round.
  const shared = new Map<boolean, number | undefined>();
  const sharedWindow = async (incognito: boolean): Promise<number | undefined> => {
    if (options.mode === 'current' && !shared.has(incognito)) {
      const given = options.currentWindowId;
      shared.set(incognito, (await windowExists(given, incognito)) ? given : await currentNormalWindowId(incognito));
    }
    return shared.get(incognito);
  };
  let incognitoAccess: boolean | undefined;
  let firstCreated: number | undefined;

  for (const [windowIndex, plan] of windows.entries()) {
    if (cancelled.has(restoreId)) break;
    const incognito = plan.incognito === true;
    if (incognito) {
      // Without "Allow in Incognito", Chrome won't let Tabfold open an Incognito window, and these
      // tabs never open in a normal one instead.
      incognitoAccess ??= await incognitoAllowed();
      if (!incognitoAccess) {
        for (const tab of plan.tabs) failed.push({ url: tab.url, title: tab.title, reason: 'incognito' });
        done += plan.tabs.length;
        continue;
      }
    }
    const tabs = plan.tabs.filter((tab) => {
      const reason: RestoreFailure['reason'] = refuseToOpen(tab.url, origin)
        ? 'blocked'
        : classifyUrl(tab.url) === 'file' && !fileAccess
          ? 'file-access'
          : undefined;
      if (reason) {
        failed.push({ url: tab.url, title: tab.title, reason });
        done += 1;
      }
      return !reason;
    });
    if (tabs.length === 0) continue;

    let windowId: number | undefined;
    let placeholderTabId: number | undefined;
    let activateFirst = false;
    /** A window made for this one (not one already open): it gets the saved window's name back. */
    let madeWindow = false;
    const target = options.targetWindowIds?.[windowIndex];
    const sharedWindowId = await sharedWindow(incognito);
    // windowExists only accepts a window of the same mode: normal tabs never land in Incognito.
    if (await windowExists(target, incognito)) {
      windowId = target;
    } else if ((options.mode === 'current' || options.mode === 'new-window') && sharedWindowId !== undefined) {
      windowId = sharedWindowId;
    } else {
      const bounds = fitBounds(plan.bounds, options.screen);
      const focused = !options.background && (plan.focused || windowIndex === 0);
      let created: Browser.windows.Window | undefined;
      try {
        created = await browser.windows.create({ focused, incognito, ...(bounds ?? {}) });
      } catch {
        // Chrome refuses bounds it thinks are off-screen (its idea of the screens can differ from
        // the page's). Open at the default size instead of failing the restore.
        created = await browser.windows.create({ focused, incognito }).catch(() => undefined);
      }
      windowId = created?.id;
      firstCreated ??= windowId;
      placeholderTabId = created?.tabs?.[0]?.id;
      activateFirst = true;
      madeWindow = options.mode === 'original' || windows.length === 1;
      if (windowId !== undefined && (plan.state === 'maximized' || plan.state === 'fullscreen')) {
        await browser.windows.update(windowId, { state: plan.state }).catch(() => undefined);
      }
      if (options.mode === 'new-window') shared.set(incognito, windowId);
    }
    if (windowId === undefined) {
      for (const tab of tabs) failed.push({ url: tab.url, title: tab.title, reason: 'error' });
      done += tabs.length;
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
            if (id !== undefined && options.lazy && !active) {
              // Muted while it loads once in the background, so restoring never blasts audio.
              await browser.tabs.update(id, { muted: true }).catch(() => undefined);
              id = await sleepWhenLoaded(id);
            }
            return { tab, id };
          } catch {
            failed.push({ url: tab.url, title: tab.title, reason: 'error' });
            return { tab, id: undefined };
          }
        }),
      );
      isFirst = false;
      for (const { tab, id } of results) {
        done += 1;
        if (id === undefined) continue;
        opened += 1;
        if (incognito) openedIncognito += 1;
        const key = groupKey(tab);
        if (key && !tab.pinned) {
          const entry = groups.get(key) ?? { tab, ids: [] };
          entry.ids.push(id);
          groups.set(key, entry);
        }
      }
      await report(windowIndex);
    }

    for (const { tab, ids } of groups.values()) {
      try {
        const groupId = await browser.tabs.group({ tabIds: ids as [number, ...number[]], createProperties: { windowId } });
        await browser.tabGroups.update(groupId, {
          title: tab.groupName ?? '',
          color: safeGroupColor(tab.groupColor),
          collapsed: tab.groupCollapsed,
        });
        madeGroups.push({ groupId, windowId, name: tab.groupName ?? '', incognito });
      } catch {
        // Groups are a nicety; the tabs themselves are open.
      }
    }
    if (placeholderTabId !== undefined) await browser.tabs.remove(placeholderTabId).catch(() => undefined);
    // A fold of a named window reopens as a window with that name (1.0).
    if (madeWindow && plan.name) await nameReopenedWindow(windowId, plan.name).catch(() => undefined);
  }

  if (options.background && firstCreated !== undefined) {
    await browser.windows.update(firstCreated, { focused: true }).catch(() => undefined);
  }
  const wasCancelled = cancelled.delete(restoreId);
  return { opened, failed, cancelled: wasCancelled, groups: madeGroups, openedIncognito };
}

function emptyOutcome(restoreId: string): RestoreOutcome {
  return { restoreId, opened: 0, failed: [], cancelled: false, needsFileAccess: 0, trashed: false };
}

function needsFileAccess(failed: RestoreFailure[]): number {
  return failed.filter((f) => f.reason === 'file-access').length;
}

/**
 * Run a restore that pages can follow: activeRestore is kept up to date while it runs and cleared
 * when it ends (finished, cancelled or failed), then restore-done carries the outcome.
 */
async function tracked(restoreId: string, run: () => Promise<RestoreOutcome>): Promise<RestoreOutcome> {
  let outcome: RestoreOutcome | undefined;
  try {
    outcome = await run();
    return outcome;
  } finally {
    const current = await activeRestore.get().catch(() => undefined);
    if (current?.restoreId === restoreId) await activeRestore.set(null).catch(() => undefined);
    cancelled.delete(restoreId);
    if (outcome) {
      const event: WorkerEvent = { type: 'restore-done', restoreId, outcome };
      broadcast(event);
    }
  }
}

type RestoreCommand = Extract<Command, { type: 'restore' }>;

export async function handleRestore(command: RestoreCommand): Promise<RestoreOutcome> {
  const restoreId = crypto.randomUUID();
  const graph = await getSessionGraph(command.sessionId);
  if (!graph) return emptyOutcome(restoreId);
  const windows = command.windowRecordId ? graph.windows.filter((w) => w.id === command.windowRecordId) : graph.windows;

  if (!command.force && command.mode === 'original') {
    const urls = windows.filter((w) => !w.incognito).flatMap((w) => w.tabs.map((t) => t.url));
    // An Incognito copy doesn't count: "Switch to it" only uses normal windows.
    const copy = describeOpenCopy(urls, (await getNormalWindows()).filter((w) => !w.incognito));
    if (copy) return { ...emptyOutcome(restoreId), alreadyOpenWindowId: copy.windowIds[0], alreadyOpen: copy };
  }

  return tracked(restoreId, async () => {
    await takeSnapshot('before-restore').catch(() => undefined);
    const settings = await getSettings();
    const result = await restoreWindows(
      windows.map((w) => ({
        name: w.name,
        bounds: w.bounds,
        state: w.state,
        focused: w.wasFocused,
        tabs: w.tabs,
        ...(w.incognito ? { incognito: true } : {}),
      })),
      {
        mode: command.mode,
        lazy: settings.lazyRestore,
        currentWindowId: command.currentWindowId,
        screen: command.screen,
        restoreId,
        background: command.background,
        progress: { sessionId: graph.session.id, name: graph.session.name },
      },
    );

    // Folded tabs that came back (the weekly summary).
    void countCameBack(result.opened - result.openedIncognito);
    let trashed = false;
    const wholeSession = !command.windowRecordId;
    if (wholeSession && settings.afterRestore === 'trash' && !result.cancelled && result.failed.length === 0) {
      await trashSessions([graph.session.id]);
      trashed = true;
    }
    return { restoreId, opened: result.opened, failed: result.failed, cancelled: result.cancelled, needsFileAccess: needsFileAccess(result.failed), trashed };
  });
}

type SnapshotRestoreCommand = Extract<Command, { type: 'restore-snapshot' }>;

export async function handleRestoreSnapshot(command: SnapshotRestoreCommand): Promise<RestoreOutcome> {
  const restoreId = crypto.randomUUID();
  const snapshot = await db.snapshots.get(command.snapshotId);
  if (!snapshot) return emptyOutcome(restoreId);
  return tracked(restoreId, async () => {
    const settings = await getSettings();
    const result = await restoreWindows(fromCaptured(snapshot.windows), {
      mode: command.mode,
      lazy: settings.lazyRestore,
      currentWindowId: command.currentWindowId,
      screen: command.screen,
      restoreId,
      progress: { sessionId: null, snapshotId: command.snapshotId, name: `Snapshot · ${formatDateTime(snapshot.createdAt)}` },
    });
    const offer = await recoveryOffer.get();
    if (offer?.snapshotId === command.snapshotId) {
      await recoveryOffer.set(null);
      await setAttentionBadge(false);
    }
    return { restoreId, opened: result.opened, failed: result.failed, cancelled: result.cancelled, needsFileAccess: needsFileAccess(result.failed), trashed: false };
  });
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
  await refreshDataGuard().catch(() => undefined);
  return { sessionId: result.savedTabIds.length ? result.sessionId : null };
}

type OpenTabsCommand = Extract<Command, { type: 'open-tabs' }>;

/**
 * "Open all": open folded tabs in the current (or given) normal window, in the background and
 * lazily like a restore (each loads once, muted, then sleeps). With `asGroup` they become one
 * Chrome tab group with that name and colour. The tabs stay in the list.
 */
export async function handleOpenTabs(command: OpenTabsCommand): Promise<{ opened: number; reason?: string }> {
  const rows = (await db.tabs.bulkGet(command.tabRecordIds)).filter((t): t is NonNullable<typeof t> => !!t);
  if (rows.length === 0) return { opened: 0 };
  const settings = await getSettings();
  const group = command.asGroup;
  const toTab = (row: (typeof rows)[number]): RestoreTab => ({
    url: row.url,
    title: row.title,
    pinned: false,
    groupName: group ? group.name : null,
    groupColor: group ? safeGroupColor(group.color) : null,
    groupCollapsed: false,
  });
  // Tabs folded from Incognito open in an Incognito window (as their own group), the rest here.
  const plans: RestoreWindow[] = [false, true]
    .map((incognito) => ({
      name: '',
      bounds: null,
      state: null,
      focused: false,
      tabs: rows.filter((row) => !!row.incognito === incognito).map(toTab),
      ...(incognito ? { incognito: true } : {}),
    }))
    .filter((plan) => plan.tabs.length > 0);
  const result = await restoreWindows(plans, {
    mode: 'current',
    lazy: settings.lazyRestore,
    currentWindowId: command.windowId,
  });
  if (result.opened) await markOpened(rows.map((row) => row.id)).catch(() => undefined);
  // Opened from a folder as a group (1.0): folding that group puts its tabs back into the folder.
  if (group && command.folderId && result.groups.length) {
    await rememberGroupFolders(result.groups.map((g) => g.groupId), command.folderId).catch(() => undefined);
  }
  void countCameBack(result.opened - result.openedIncognito);
  return { opened: result.opened, ...(result.failed.some((f) => f.reason === 'incognito') ? { reason: INCOGNITO_OFF } : {}) };
}

/** Why a tab folded from Incognito can't reopen. */
export const INCOGNITO_OFF =
  'Tabs folded from Incognito open only in Incognito. Turn on “Allow in Incognito” for Tabfold in Chrome’s extension settings.';

export async function handleOpenSavedTab(
  tabRecordId: string,
  active: boolean,
  windowId?: number,
): Promise<{ opened: boolean; reason?: string }> {
  const tab = await db.tabs.get(tabRecordId);
  if (!tab) return { opened: false, reason: 'This tab is no longer saved.' };
  if (refuseToOpen(tab.url, ownOrigin())) return { opened: false, reason: 'Chrome does not allow opening this address.' };
  // Folded from Incognito: back into an Incognito window (or a new one), never a normal one.
  const incognito = tab.incognito === true;
  if (incognito && !(await incognitoAllowed())) return { opened: false, reason: INCOGNITO_OFF };
  const target = (await windowExists(windowId, incognito)) ? windowId : await currentNormalWindowId(incognito);
  try {
    if (target === undefined && incognito) {
      await browser.windows.create({ incognito: true, url: tab.url, focused: active });
      return { opened: true };
    }
    const created = await browser.tabs.create({ url: tab.url, active, windowId: target });
    if (active && created.windowId !== undefined) await browser.windows.update(created.windowId, { focused: true });
    await markOpened([tab.id]).catch(() => undefined);
    if (!incognito) void countCameBack(1);
    return { opened: true };
  } catch {
    return { opened: false, reason: 'Chrome refused to open this address. Copy it and paste it into the address bar.' };
  }
}
