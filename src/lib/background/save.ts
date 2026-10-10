import { browser, type Browser } from 'wxt/browser';
import { planCapture, wouldCloseEverything, type CapturePlan } from '../capture';
import { isQuotaError } from '../db';
import { estimateBytes } from '../format';
import { CommandError, type Command, type PreflightResult, type SaveOutcome } from '../messages';
import { deleteSessionsForever, removeTabs, saveCapture } from '../repo';
import { getSettings } from '../settings';
import { getDeviceId, lastAction, UNDO_WINDOW_MS, windowNames, type LastAction } from '../state';
import { db } from '../db';
import type { TabRecord } from '../types';
import {
  currentNormalWindowId,
  getGroups,
  getNormalWindows,
  ownOrigin,
  sleep,
  windowExists,
} from './browserState';
import { singleFlight } from './singleFlight';
import { takeSnapshot } from './snapshots';
import { restoreWindows } from './restore';
import type { RestoreWindow } from './restorePlan';

type SaveCommand = Extract<Command, { type: 'save' }>;
type PreflightCommand = Extract<Command, { type: 'preflight-save' }>;

const saveOnce = singleFlight<SaveOutcome>(800);

async function buildPlan(
  windows: Browser.windows.Window[],
  command: Pick<SaveCommand, 'scope' | 'windowId' | 'tabIds' | 'audible' | 'keywordsByTabId'>,
): Promise<CapturePlan> {
  const [settings, groups, names] = await Promise.all([getSettings(), getGroups(), windowNames.get()]);
  const windowId = command.windowId ?? (await currentNormalWindowId());
  return planCapture(windows, groups, {
    scope: command.scope,
    windowId,
    tabIds: command.tabIds,
    keepPinnedOpen: settings.keepPinnedOpen,
    skipBlank: settings.skipBlankPages,
    includeAllWindows: settings.includeAllWindows,
    audible: command.audible ?? 'keep',
    ownOrigin: ownOrigin(),
    windowNames: names,
    keywordsByTabId: command.keywordsByTabId,
  });
}

export async function preflightSave(command: PreflightCommand): Promise<PreflightResult> {
  const windows = await getNormalWindows();
  const plan = await buildPlan(windows, { ...command, audible: 'close' });
  const saving = new Set(plan.windows.flatMap((w) => w.tabs.map((t) => t.sourceTabId)));
  const audible = windows.flatMap((w) => w.tabs ?? []).filter((t) => t.audible && saving.has(t.id)).length;
  // Contract stub: richer details (long addresses, duplicates) are filled in by the background work.
  return {
    tabs: saving.size,
    windows: plan.windows.length,
    audible,
    pinnedKept: plan.kept.pinned,
    closeTabs: plan.closeTabIds.length,
    freedBytes: 0,
    audibleTabs: [],
    longUrls: [],
    duplicates: [],
    nothingToSave: plan.windows.length === 0,
  };
}

/**
 * Close tabs only after their save is confirmed. Never lets Chrome quit by closing its last tab,
 * and reports tabs that refused to close (for example a "Leave site?" prompt).
 */
async function closeTabsSafely(tabIds: number[]): Promise<{ closed: number; failed: Browser.tabs.Tab[] }> {
  if (tabIds.length === 0) return { closed: 0, failed: [] };
  // Re-read windows right before closing: a window may have been opened or dragged meanwhile.
  const windows = await getNormalWindows();
  if (wouldCloseEverything(windows, tabIds)) {
    const target = windows.find((w) => w.focused && !w.incognito) ?? windows.find((w) => !w.incognito);
    if (target?.id !== undefined) await browser.tabs.create({ windowId: target.id, active: true });
  }
  for (let i = 0; i < tabIds.length; i += 50) {
    const batch = tabIds.slice(i, i + 50);
    try {
      await browser.tabs.remove(batch);
    } catch {
      for (const id of batch) await browser.tabs.remove(id).catch(() => undefined);
    }
  }
  await sleep(600);
  const wanted = new Set(tabIds);
  const failed = (await browser.tabs.query({})).filter((t) => t.id !== undefined && wanted.has(t.id));
  return { closed: tabIds.length - failed.length, failed };
}

function sourceFor(command: SaveCommand): 'save-all' | 'save-window' | 'save-tabs' {
  return command.scope === 'all' ? 'save-all' : command.scope === 'window' ? 'save-window' : 'save-tabs';
}

/** Requests that would save the same tabs share one run (see singleFlight). */
function saveKey(command: SaveCommand): string {
  return JSON.stringify([
    command.scope,
    command.scope === 'all' ? null : (command.windowId ?? null),
    [...(command.tabIds ?? [])].sort((a, b) => a - b),
    command.targetSessionId ?? null,
    command.close,
  ]);
}

export function handleSave(command: SaveCommand): Promise<SaveOutcome> {
  return saveOnce(saveKey(command), async () => {
    const settings = await getSettings();
    const windows = await getNormalWindows();
    const plan = await buildPlan(windows, command);
    const empty: SaveOutcome = {
      sessionId: null,
      sessionName: '',
      savedTabs: 0,
      closedTabs: 0,
      skippedDuplicates: 0,
      keptOpen: plan.kept,
      failedToClose: [],
      freedBytes: 0,
      intoUnsorted: false,
      actionId: null,
      truncatedTabs: 0,
      newTabsLeftOpen: 0,
    };
    if (plan.windows.length === 0) return empty;

    if (command.close && command.scope !== 'tabs') {
      await takeSnapshot('before-bulk-close').catch((error) => console.warn('[tabfold] safety snapshot failed', error));
    }

    const now = Date.now();
    let result;
    try {
      result = await saveCapture(
        plan.windows,
        { name: command.name, source: sourceFor(command), deviceId: await getDeviceId(), now },
        { targetSessionId: command.targetSessionId ?? null, dedupe: settings.duplicates === 'skip' },
      );
    } catch (error) {
      if (isQuotaError(error)) {
        throw new CommandError('Browser storage is full. Nothing was closed. Free up disk space, then try again.', 'quota');
      }
      throw error;
    }

    let closedTabs = 0;
    let failedToClose: SaveOutcome['failedToClose'] = [];
    let freedBytes = 0;
    if (command.close) {
      const loaded = new Set(
        windows.flatMap((w) => w.tabs ?? []).filter((t) => !t.discarded && t.id !== undefined).map((t) => t.id!),
      );
      const outcome = await closeTabsSafely(plan.closeTabIds);
      closedTabs = outcome.closed;
      const failedIds = new Set(outcome.failed.map((t) => t.id));
      freedBytes = estimateBytes(plan.closeTabIds.filter((id) => loaded.has(id) && !failedIds.has(id)).length);
      failedToClose = outcome.failed.map((t) => ({
        tabId: t.id ?? -1,
        windowId: t.windowId ?? -1,
        title: t.title ?? '',
        url: t.url || t.pendingUrl || '',
      }));
    }

    let actionId: string | null = null;
    if (result.savedTabIds.length > 0) {
      actionId = crypto.randomUUID();
      const action: LastAction = {
        id: actionId,
        kind: 'save',
        at: now,
        expiresAt: Date.now() + UNDO_WINDOW_MS,
        sessionId: result.sessionId,
        sessionName: result.sessionName,
        savedTabs: result.savedTabIds.length,
        closedTabs,
        freedBytes,
        keptOpen: plan.kept,
        intoUnsorted: result.intoUnsorted,
        savedTabIds: result.savedTabIds,
        createdSession: result.createdSession,
        windowSources: Object.fromEntries(result.windowSources),
        closed: command.close,
      };
      await lastAction.set(action);
    }

    return {
      sessionId: result.sessionId,
      sessionName: result.sessionName,
      savedTabs: result.savedTabIds.length,
      closedTabs,
      skippedDuplicates: result.skippedDuplicates,
      keptOpen: plan.kept,
      failedToClose,
      freedBytes,
      intoUnsorted: result.intoUnsorted,
      actionId,
      truncatedTabs: plan.windows.flatMap((w) => w.tabs).filter((t) => t.urlTruncated).length,
      newTabsLeftOpen: 0,
    };
  });
}

/** Undo the last save: reopen what it closed, then remove what it wrote. */
export async function handleUndo(actionId: string): Promise<{ undone: boolean; reason?: string }> {
  const action = await lastAction.get();
  if (!action || action.id !== actionId) return { undone: false, reason: 'Nothing to undo.' };
  if (action.undone) return { undone: false, reason: 'Already undone.' };
  // A little grace beyond the visible 10 seconds for slow clicks.
  if (Date.now() > action.expiresAt + 2000) return { undone: false, reason: 'Undo is no longer available.' };
  await lastAction.set({ ...action, undone: true });

  const rows = (await db.tabs.bulkGet(action.savedTabIds)).filter((t): t is TabRecord => !!t);
  if (action.closed && rows.length) {
    const byWindow = new Map<string, TabRecord[]>();
    for (const row of rows) byWindow.set(row.windowId, [...(byWindow.get(row.windowId) ?? []), row]);
    const plans: RestoreWindow[] = [];
    const targets: Array<number | undefined> = [];
    for (const [windowId, tabs] of byWindow) {
      const record = await db.windows.get(windowId);
      const source = action.windowSources[windowId];
      targets.push((await windowExists(source)) ? source : undefined);
      plans.push({
        name: record?.name ?? '',
        bounds: record?.bounds ?? null,
        state: record?.state ?? null,
        focused: record?.wasFocused ?? false,
        tabs: tabs.sort((a, b) => a.order - b.order),
      });
    }
    // Undo puts tabs back as they were a moment ago: loaded, with their titles (not lazily).
    await restoreWindows(plans, { mode: 'original', lazy: false, targetWindowIds: targets });
  }
  if (action.createdSession) await deleteSessionsForever([action.sessionId]);
  else await removeTabs(action.savedTabIds);
  return { undone: true };
}
