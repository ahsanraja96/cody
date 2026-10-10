import { browser, type Browser } from 'wxt/browser';
import { isPlaceholderTitle, planCapture, rawTabUrl, wouldCloseEverything, type CapturePlan } from '../capture';
import { db, isQuotaError } from '../db';
import { refreshDataGuard } from '../dataGuard';
import { estimateBytes } from '../format';
import {
  CommandError,
  type Command,
  type DuplicateTab,
  type PreflightResult,
  type SaveOutcome,
  type TabRef,
} from '../messages';
import { deleteSessionsForever, findSavedCopies, removeTabs, saveCapture } from '../repo';
import { getSettings, type Settings } from '../settings';
import { getDeviceId, lastAction, UNDO_WINDOW_MS, windowNames, type LastAction } from '../state';
import type { CapturedTab, TabRecord } from '../types';
import { capUrl, dedupeKey, displayHost, MAX_URL_LENGTH } from '../urls';
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
import type { RestoreTab, RestoreWindow } from './restorePlan';
import { rememberPendingTitles } from './titles';

type SaveCommand = Extract<Command, { type: 'save' }>;
type PreflightCommand = Extract<Command, { type: 'preflight-save' }>;
type BrowserTab = Browser.tabs.Tab;

const saveOnce = singleFlight<SaveOutcome>(800);

async function buildPlan(
  windows: Browser.windows.Window[],
  command: Pick<SaveCommand, 'scope' | 'windowId' | 'tabIds' | 'audible' | 'keywordsByTabId' | 'includeIncognito'>,
  settings: Settings,
): Promise<CapturePlan> {
  const [groups, names] = await Promise.all([getGroups(), windowNames.get()]);
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
    includeIncognito: command.includeIncognito,
  });
}

function tabsById(windows: Browser.windows.Window[]): Map<number, BrowserTab> {
  const map = new Map<number, BrowserTab>();
  for (const tab of windows.flatMap((w) => w.tabs ?? [])) if (tab.id !== undefined) map.set(tab.id, tab);
  return map;
}

/** An open tab as pages see it. Addresses are capped like saved ones, so a huge data: URL stays out of messages. */
function toRef(tab: BrowserTab): TabRef {
  const url = capUrl(rawTabUrl(tab)).url;
  return { tabId: tab.id ?? -1, windowId: tab.windowId ?? -1, title: tab.title?.trim() || displayHost(url) || url, url };
}

function capturedTabs(plan: CapturePlan): CapturedTab[] {
  return plan.windows.flatMap((w) => w.tabs);
}

export async function preflightSave(command: PreflightCommand): Promise<PreflightResult> {
  const [windows, settings] = await Promise.all([getNormalWindows(), getSettings()]);
  const plan = await buildPlan(windows, { ...command, audible: 'close' }, settings);
  const byId = tabsById(windows);
  const saving = capturedTabs(plan).filter((t) => t.sourceTabId !== undefined && byId.has(t.sourceTabId));
  const browserTab = (t: CapturedTab) => byId.get(t.sourceTabId!)!;

  const copies = await findSavedCopies(
    saving.map((t) => t.url),
    command.targetSessionId,
  );
  const duplicates: DuplicateTab[] = [];
  for (const tab of saving) {
    const copy = copies.get(dedupeKey(tab.url));
    if (copy) duplicates.push({ ...toRef(browserTab(tab)), sessionId: copy.session.id, sessionName: copy.session.name });
  }

  const longUrls: PreflightResult['longUrls'] = [];
  for (const tab of saving) {
    const length = rawTabUrl(browserTab(tab)).length;
    if (length > MAX_URL_LENGTH) longUrls.push({ ...toRef(browserTab(tab)), length });
  }

  const audibleTabs = saving.map(browserTab).filter((t) => t.audible).map(toRef);
  const loadedClosing = plan.closeTabIds.filter((id) => {
    const tab = byId.get(id);
    return !!tab && !tab.discarded;
  }).length;

  return {
    tabs: saving.length,
    windows: plan.windows.length,
    audible: audibleTabs.length,
    pinnedKept: plan.kept.pinned,
    closeTabs: plan.closeTabIds.length,
    freedBytes: estimateBytes(loadedClosing),
    audibleTabs,
    longUrls,
    duplicates,
    nothingToSave: plan.windows.length === 0,
  };
}

interface CloseResult {
  closed: number;
  failed: BrowserTab[];
  /** Tabs that turned up in the saved windows after planning; they stay open. */
  newTabsLeftOpen: number;
}

/**
 * Close tabs only after their save is confirmed. Never lets Chrome quit by closing its last tab,
 * and reports tabs that refused to close (for example a "Leave site?" prompt).
 * `planned` holds, per saved browser window, every tab it had when the save was planned.
 */
async function closeTabsSafely(tabIds: number[], planned: Map<number, Set<number>>): Promise<CloseResult> {
  if (tabIds.length === 0) return { closed: 0, failed: [], newTabsLeftOpen: 0 };
  // Re-read windows right before closing: a window may have been opened or dragged meanwhile.
  const windows = await getNormalWindows();
  const closing = new Set(tabIds);
  let keeper: number | undefined;
  if (wouldCloseEverything(windows, tabIds)) {
    const target =
      windows.find((w) => w.focused && !w.incognito) ?? windows.find((w) => !w.incognito) ?? windows.find((w) => w.id !== undefined);
    if (target?.id !== undefined) keeper = (await browser.tabs.create({ windowId: target.id, active: true })).id;
  }
  const newTabsLeftOpen = windows
    .filter((w) => w.id !== undefined && planned.has(w.id))
    .flatMap((w) => (w.tabs ?? []).filter((t) => t.id !== undefined && t.id !== keeper && !closing.has(t.id) && !planned.get(w.id!)!.has(t.id)))
    .length;
  for (let i = 0; i < tabIds.length; i += 50) {
    const batch = tabIds.slice(i, i + 50);
    try {
      await browser.tabs.remove(batch);
    } catch {
      for (const id of batch) await browser.tabs.remove(id).catch(() => undefined);
    }
  }
  await sleep(600);
  const failed = (await browser.tabs.query({})).filter((t) => t.id !== undefined && closing.has(t.id));
  return { closed: tabIds.length - failed.length, failed, newTabsLeftOpen };
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
    command.duplicates ?? null,
    command.includeIncognito ?? false,
  ]);
}

/** Without an answer from the popup's "Ask" sheet, "ask" saves duplicates again: nothing is dropped silently. */
export function duplicatesMode(command: Pick<SaveCommand, 'duplicates'>, settings: Pick<Settings, 'duplicates'>): 'skip' | 'keep' {
  return command.duplicates ?? (settings.duplicates === 'skip' ? 'skip' : 'keep');
}


export function handleSave(command: SaveCommand): Promise<SaveOutcome> {
  return saveOnce(saveKey(command), async () => {
    const settings = await getSettings();
    const duplicates = duplicatesMode(command, settings);
    const windows = await getNormalWindows();
    const plan = await buildPlan(windows, command, settings);
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
    const incognitoIds = new Set(windows.filter((w) => w.incognito).map((w) => w.id));
    const savedFromIncognito = !!command.includeIncognito && plan.windows.some((w) => incognitoIds.has(w.sourceWindowId));

    if (command.close && command.scope !== 'tabs') {
      await takeSnapshot('before-bulk-close').catch((error) => console.warn('[tabfold] safety snapshot failed', error));
    }

    const now = Date.now();
    let result;
    try {
      result = await saveCapture(
        plan.windows,
        { name: command.name, source: sourceFor(command), deviceId: await getDeviceId(), now },
        { targetSessionId: command.targetSessionId ?? null, dedupe: duplicates === 'skip' },
      );
    } catch (error) {
      if (isQuotaError(error)) {
        throw new CommandError('Browser storage is full. Nothing was closed. Free up disk space, then try again.', 'quota');
      }
      throw error;
    }
    await refreshDataGuard().catch(() => undefined);

    const byId = tabsById(windows);
    const skipped = new Set(result.skippedTabs.map((s) => s.tab));
    const written = capturedTabs(plan).filter((t) => !skipped.has(t));

    if (!command.close) {
      // Kept open while still loading: fill the title in when Chrome reports it.
      const pending: Array<[number, string]> = [];
      for (const tab of written) {
        if (tab.sourceTabId === undefined) continue;
        const savedId = result.tabIdMap.get(tab.sourceTabId);
        const browserTab = byId.get(tab.sourceTabId);
        // Its title had not arrived (the host stands in), and no earlier save of the address had one either.
        if (savedId && browserTab && isPlaceholderTitle(browserTab.title, rawTabUrl(browserTab)) && tab.title === (displayHost(tab.url) || tab.url)) {
          pending.push([tab.sourceTabId, savedId]);
        }
      }
      await rememberPendingTitles(pending).catch(() => undefined);
    }

    let closedTabs = 0;
    let failedToClose: TabRef[] = [];
    let freedBytes = 0;
    let newTabsLeftOpen = 0;
    const stillOpen = new Set<number>();
    if (command.close) {
      const planned = new Map<number, Set<number>>();
      for (const window of plan.windows) {
        const source = windows.find((w) => w.id === window.sourceWindowId);
        if (source?.id !== undefined) planned.set(source.id, new Set((source.tabs ?? []).map((t) => t.id!).filter((id) => id !== undefined)));
      }
      const outcome = await closeTabsSafely(plan.closeTabIds, planned);
      closedTabs = outcome.closed;
      newTabsLeftOpen = outcome.newTabsLeftOpen;
      for (const tab of outcome.failed) stillOpen.add(tab.id!);
      freedBytes = estimateBytes(
        plan.closeTabIds.filter((id) => byId.has(id) && !byId.get(id)!.discarded && !stillOpen.has(id)).length,
      );
      failedToClose = outcome.failed.map((t) => {
        const before = byId.get(t.id!);
        return toRef({ ...t, title: t.title || before?.title, url: t.url || before?.url, windowId: t.windowId ?? before?.windowId });
      });
    }

    const reopenOnly: NonNullable<LastAction['reopenOnly']> = command.close
      ? result.skippedTabs
          .filter((s) => s.tab.sourceTabId === undefined || !stillOpen.has(s.tab.sourceTabId))
          .map((s) => ({ url: s.tab.url, title: s.tab.title, pinned: s.tab.pinned, sourceWindowId: s.sourceWindowId }))
      : [];

    let actionId: string | null = null;
    if (result.savedTabIds.length > 0 || reopenOnly.length > 0) {
      actionId = crypto.randomUUID();
      const notClosedTabIds = [...stillOpen].map((id) => result.tabIdMap.get(id)).filter((id): id is string => !!id);
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
        ...(reopenOnly.length ? { reopenOnly } : {}),
        ...(notClosedTabIds.length ? { notClosedTabIds } : {}),
        ...(savedFromIncognito ? { incognito: true } : {}),
      };
      await lastAction.set(action);
    }

    return {
      sessionId: result.sessionId || null,
      sessionName: result.sessionName,
      savedTabs: result.savedTabIds.length,
      closedTabs,
      skippedDuplicates: result.skippedDuplicates,
      keptOpen: plan.kept,
      failedToClose,
      freedBytes,
      intoUnsorted: result.intoUnsorted,
      actionId,
      truncatedTabs: written.filter((t) => t.urlTruncated).length,
      newTabsLeftOpen,
    };
  });
}

function reopenTab(item: NonNullable<LastAction['reopenOnly']>[number]): RestoreTab {
  return { url: item.url, title: item.title, pinned: item.pinned, groupName: null, groupColor: null, groupCollapsed: false };
}

/** Undo the last save: reopen what it closed (where it was, when that window is still open), then remove what it wrote. */
export async function handleUndo(actionId: string): Promise<{ undone: boolean; reason?: string }> {
  const action = await lastAction.get();
  if (!action || action.id !== actionId) return { undone: false, reason: 'Nothing to undo.' };
  if (action.undone) return { undone: false, reason: 'Already undone.' };
  // A little grace beyond the visible 10 seconds for slow clicks.
  if (Date.now() > action.expiresAt + 2000) return { undone: false, reason: 'Undo is no longer available.' };
  await lastAction.set({ ...action, undone: true });

  if (action.closed && action.incognito) {
    await reopenInIncognito(action);
  } else if (action.closed) {
    // Tabs that refused to close are still open: don't open a second copy.
    const stillOpen = new Set(action.notClosedTabIds ?? []);
    const rows = (await db.tabs.bulkGet(action.savedTabIds)).filter((t): t is TabRecord => !!t && !stillOpen.has(t.id));
    // Skipped duplicates go back to the window they came from, after the saved tabs of that window.
    const extraBySource = new Map<number | undefined, RestoreTab[]>();
    for (const item of action.reopenOnly ?? []) {
      extraBySource.set(item.sourceWindowId, [...(extraBySource.get(item.sourceWindowId) ?? []), reopenTab(item)]);
    }
    const byWindow = new Map<string, TabRecord[]>();
    for (const row of rows) byWindow.set(row.windowId, [...(byWindow.get(row.windowId) ?? []), row]);

    const plans: RestoreWindow[] = [];
    const targets: Array<number | undefined> = [];
    for (const [windowId, tabs] of byWindow) {
      const record = await db.windows.get(windowId);
      const source = action.windowSources[windowId];
      const extra = source !== undefined ? (extraBySource.get(source) ?? []) : [];
      if (source !== undefined) extraBySource.delete(source);
      targets.push((await windowExists(source)) ? source : undefined);
      plans.push({
        name: record?.name ?? '',
        bounds: record?.bounds ?? null,
        state: record?.state ?? null,
        focused: record?.wasFocused ?? false,
        tabs: [...tabs.sort((a, b) => a.order - b.order), ...extra],
      });
    }
    for (const [source, tabs] of extraBySource) {
      targets.push((await windowExists(source)) ? source : undefined);
      plans.push({ name: '', bounds: null, state: null, focused: false, tabs });
    }
    // Undo puts tabs back as they were a moment ago: loaded, with their titles (not lazily).
    if (plans.length) await restoreWindows(plans, { mode: 'original', lazy: false, targetWindowIds: targets });
  }
  if (action.createdSession) await deleteSessionsForever([action.sessionId]);
  else if (action.savedTabIds.length) await removeTabs(action.savedTabIds);
  return { undone: true };
}

/**
 * Undo of an Incognito save: put the tabs back in their Incognito window (or a new Incognito
 * window), never in a normal one, so they stay out of normal history.
 */
async function reopenInIncognito(action: LastAction): Promise<void> {
  const stillOpen = new Set(action.notClosedTabIds ?? []);
  const rows = (await db.tabs.bulkGet(action.savedTabIds)).filter((t): t is TabRecord => !!t && !stillOpen.has(t.id));
  const byWindow = new Map<string, TabRecord[]>();
  for (const row of rows) byWindow.set(row.windowId, [...(byWindow.get(row.windowId) ?? []), row]);
  for (const [windowId, tabs] of byWindow) {
    const urls = tabs.sort((a, b) => a.order - b.order).map((t) => t.url);
    const source = action.windowSources[windowId];
    const target = source !== undefined ? await browser.windows.get(source).catch(() => undefined) : undefined;
    try {
      if (target?.incognito && target.id !== undefined) {
        for (const url of urls) await browser.tabs.create({ windowId: target.id, url, active: false });
      } else {
        await browser.windows.create({ incognito: true, url: urls });
      }
    } catch (error) {
      console.warn('[tabfold] could not reopen Incognito tabs', error);
    }
  }
}
