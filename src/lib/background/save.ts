import { browser, type Browser } from 'wxt/browser';
import { isPlaceholderTitle, planCapture, rawTabUrl, wouldCloseEverything, type CapturePlan } from '../capture';
import { db, isQuotaError } from '../db';
import { refreshDataGuard } from '../dataGuard';
import { undoFolderChanges } from '../folders';
import { estimateBytes } from '../format';
import {
  CommandError,
  type Command,
  type DuplicateTab,
  type PreflightResult,
  type SaveOutcome,
  type TabRef,
} from '../messages';
import { deleteSessionsForever, findSavedCopies, putBackTabs, removeTabs, saveCapture, type SaveResult } from '../repo';
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
import { ensureRoomFor } from './room';
import type { RestoreTab, RestoreWindow } from './restorePlan';
import { rememberPendingTitles } from './titles';

type SaveCommand = Extract<Command, { type: 'save' }>;
type PreflightCommand = Extract<Command, { type: 'preflight-save' }>;
type BrowserTab = Browser.tabs.Tab;

/**
 * Saves and folds share one queue: two of them never race to close the same tabs, and the same
 * request arriving twice (double-click, shortcut plus button) runs once.
 */
export const saveQueue = singleFlight<SaveOutcome>(800);

/** A save covers Incognito only for one window or picked tabs the user confirmed; folds have their own setting. */
function savesIncognito(command: Pick<SaveCommand, 'scope' | 'includeIncognito'>): boolean {
  return command.scope !== 'all' && command.includeIncognito === true;
}

export async function buildPlan(
  windows: Browser.windows.Window[],
  command: Pick<SaveCommand, 'scope' | 'windowId' | 'tabIds' | 'audible' | 'keywordsByTabId' | 'includeIncognito'>,
  settings: Settings,
  keepTabIds?: number[],
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
    keepTabIds,
  });
}

export function tabsById(windows: Browser.windows.Window[]): Map<number, BrowserTab> {
  const map = new Map<number, BrowserTab>();
  for (const tab of windows.flatMap((w) => w.tabs ?? [])) if (tab.id !== undefined) map.set(tab.id, tab);
  return map;
}

/** An open tab as pages see it. Addresses are capped like saved ones, so a huge data: URL stays out of messages. */
export function toRef(tab: BrowserTab): TabRef {
  const url = capUrl(rawTabUrl(tab)).url;
  return { tabId: tab.id ?? -1, windowId: tab.windowId ?? -1, title: tab.title?.trim() || displayHost(url) || url, url };
}

export function capturedTabs(plan: CapturePlan): CapturedTab[] {
  return plan.windows.flatMap((w) => w.tabs);
}

export async function preflightSave(command: PreflightCommand): Promise<PreflightResult> {
  const [windows, settings] = await Promise.all([getNormalWindows(), getSettings()]);
  const plan = await buildPlan(windows, { ...command, audible: 'close', includeIncognito: savesIncognito(command) }, settings);
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

export interface CloseResult {
  closed: number;
  /** Still open a moment after closing (for example showing Chrome's "Leave site?" dialog). */
  failed: BrowserTab[];
  /** Tabs that turned up in the saved windows after planning; they stay open. */
  newTabsLeftOpen: number;
}

export interface CloseOptions {
  batchSize?: number;
  /** Leave this window open with a new tab if every tab in it closes (the window you folded from). */
  keepWindowOpen?: number;
  /** After each batch, with how many of the tabs are closed so far. */
  onBatch?: (closed: number) => Promise<void> | void;
}

/**
 * Tabs Tabfold itself is closing (a fold, a save, "Fold the group"), so tabs.onRemoved listeners can
 * tell them from tabs the person closed: a live folder keeps the saved copy of a tab Tabfold folded,
 * and drops the one of a tab the person closed. Entries go when the listener takes them, or after a minute.
 */
const closingByTabfold = new Map<number, number>();
const CLOSING_TTL_MS = 60_000;

export function noteClosingByTabfold(tabIds: Iterable<number>, now = Date.now()): void {
  for (const [id, until] of closingByTabfold) if (until < now) closingByTabfold.delete(id);
  for (const id of tabIds) closingByTabfold.set(id, now + CLOSING_TTL_MS);
}

/** Was this tab closed by Tabfold? Answers once per tab. */
export function takeClosingByTabfold(tabId: number): boolean {
  const until = closingByTabfold.get(tabId);
  closingByTabfold.delete(tabId);
  return until !== undefined && until >= Date.now();
}

/**
 * tabs.remove, but never waiting long: Chrome holds the call for a batch until a "Leave site?"
 * dialog in it is answered (the other tabs close at once).
 */
async function removeQuickly(ids: number | number[], ms: number): Promise<void> {
  await Promise.race([browser.tabs.remove(ids as number[]), sleep(ms)]);
}

/** Which of these tabs are still open. */
export async function stillOpen(ids: Iterable<number>): Promise<BrowserTab[]> {
  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  return (await browser.tabs.query({})).filter((t) => t.id !== undefined && wanted.has(t.id));
}

/**
 * Close tabs only after their save is confirmed. Never lets Chrome quit by closing its last tab,
 * and reports tabs that refused to close (for example a "Leave site?" prompt).
 * `planned` holds, per saved browser window, every tab it had when the save was planned.
 */
export async function closeTabsSafely(
  tabIds: number[],
  planned: Map<number, Set<number>>,
  options: CloseOptions = {},
): Promise<CloseResult> {
  if (tabIds.length === 0) return { closed: 0, failed: [], newTabsLeftOpen: 0 };
  // Re-read windows right before closing: a window may have been opened or dragged meanwhile.
  const windows = await getNormalWindows();
  const closing = new Set(tabIds);
  let keeper: number | undefined;
  const emptied = windows.find((w) => w.id === options.keepWindowOpen && (w.tabs ?? []).every((t) => t.id !== undefined && closing.has(t.id)));
  if (emptied?.id !== undefined) {
    keeper = (await browser.tabs.create({ windowId: emptied.id, active: true })).id;
  } else if (wouldCloseEverything(windows, tabIds)) {
    const target =
      windows.find((w) => w.focused && !w.incognito) ?? windows.find((w) => !w.incognito) ?? windows.find((w) => w.id !== undefined);
    if (target?.id !== undefined) keeper = (await browser.tabs.create({ windowId: target.id, active: true })).id;
  }
  const newTabsLeftOpen = windows
    .filter((w) => w.id !== undefined && planned.has(w.id))
    .flatMap((w) => (w.tabs ?? []).filter((t) => t.id !== undefined && t.id !== keeper && !closing.has(t.id) && !planned.get(w.id!)!.has(t.id)))
    .length;
  noteClosingByTabfold(tabIds);
  const size = options.batchSize ?? 50;
  let closedSoFar = 0;
  for (let i = 0; i < tabIds.length; i += size) {
    const batch = tabIds.slice(i, i + size);
    try {
      await removeQuickly(batch, 1500);
    } catch {
      for (const id of batch) await removeQuickly(id, 1000).catch(() => undefined);
    }
    if (options.onBatch) {
      closedSoFar += batch.length - (await stillOpen(batch)).length;
      await options.onBatch(closedSoFar);
    }
  }
  await sleep(600);
  const failed = await stillOpen(closing);
  return { closed: tabIds.length - failed.length, failed, newTabsLeftOpen };
}

/** Per saved browser window, every tab it had when the save was planned. */
export function plannedTabs(plan: CapturePlan, windows: Browser.windows.Window[]): Map<number, Set<number>> {
  const planned = new Map<number, Set<number>>();
  for (const window of plan.windows) {
    const source = windows.find((w) => w.id === window.sourceWindowId);
    if (source?.id !== undefined) planned.set(source.id, new Set((source.tabs ?? []).map((t) => t.id!).filter((id) => id !== undefined)));
  }
  return planned;
}

/** A tab that refused to close, as pages see it (with what we knew about it before, if Chrome lost it). */
export function refusedRef(tab: BrowserTab, before: Map<number, BrowserTab>): TabRef {
  const known = before.get(tab.id!);
  return toRef({ ...tab, title: tab.title || known?.title, url: tab.url || known?.url, windowId: tab.windowId ?? known?.windowId });
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


/**
 * Remember a save for Undo (10 s): what it wrote, and the tabs it closed without writing them
 * (already saved elsewhere), which Undo reopens too. Returns the action id, or null when there is
 * nothing to undo.
 */
export async function recordUndo(input: {
  result: SaveResult;
  plan: CapturePlan;
  now: number;
  close: boolean;
  closedTabs: number;
  freedBytes: number;
  /** Browser tabs that never closed. */
  stillOpen: Set<number>;
  /** Tabs already folded that this action changed (moved into a folder, snoozed): Undo puts these back. */
  patches?: LastAction['patches'];
}): Promise<string | null> {
  const { result, plan, close, stillOpen } = input;
  const reopenOnly: NonNullable<LastAction['reopenOnly']> = close
    ? result.skippedTabs
        .filter((s) => s.tab.sourceTabId === undefined || !stillOpen.has(s.tab.sourceTabId))
        .map((s) => ({
          url: s.tab.url,
          title: s.tab.title,
          pinned: s.tab.pinned,
          sourceWindowId: s.sourceWindowId,
          ...(s.incognito ? { incognito: true as const } : {}),
        }))
    : [];
  const patches = input.patches ?? [];
  if (result.savedTabIds.length === 0 && reopenOnly.length === 0 && patches.length === 0) return null;
  const actionId = crypto.randomUUID();
  const notClosedTabIds = [...stillOpen].map((id) => result.tabIdMap.get(id)).filter((id): id is string => !!id);
  const action: LastAction = {
    id: actionId,
    kind: 'save',
    at: input.now,
    expiresAt: Date.now() + UNDO_WINDOW_MS,
    sessionId: result.sessionId,
    sessionName: result.sessionName,
    savedTabs: result.savedTabIds.length,
    closedTabs: input.closedTabs,
    freedBytes: input.freedBytes,
    keptOpen: plan.kept,
    intoUnsorted: result.intoUnsorted,
    savedTabIds: result.savedTabIds,
    createdSession: result.createdSession,
    windowSources: Object.fromEntries(result.windowSources),
    closed: close,
    ...(reopenOnly.length ? { reopenOnly } : {}),
    ...(notClosedTabIds.length ? { notClosedTabIds } : {}),
    ...(patches.length ? { patches } : {}),
  };
  await lastAction.set(action);
  return actionId;
}

/**
 * Remember an action that changed tabs already folded without saving or closing anything (snoozing
 * folded tabs, a tab closed in a live folder's group, moving tabs between folders, deleting a
 * folder, moving a site to another kind, Make room, removing duplicates), so Undo can put them back.
 */
export async function recordChangeUndo(change: {
  patches?: LastAction['patches'];
  putBack?: LastAction['putBack'];
  sessionId?: string;
  now?: number;
  folders?: LastAction['folders'];
  foldersMade?: LastAction['foldersMade'];
  siteKind?: LastAction['siteKind'];
  /** Tabs this change wrote (a tab moved into or out of a team folder gets a new copy): Undo removes them. */
  savedTabIds?: string[];
}): Promise<string | null> {
  const folderChange = !!change.folders?.length || !!change.foldersMade?.length || !!change.siteKind;
  if (!change.patches?.length && !change.putBack?.tabs.length && !folderChange && !change.savedTabIds?.length) return null;
  const now = change.now ?? Date.now();
  const action: LastAction = {
    id: crypto.randomUUID(),
    kind: 'save',
    at: now,
    expiresAt: Date.now() + UNDO_WINDOW_MS,
    sessionId: change.sessionId ?? '',
    sessionName: '',
    savedTabs: 0,
    closedTabs: 0,
    freedBytes: 0,
    keptOpen: { pinned: 0, audible: 0 },
    intoUnsorted: false,
    savedTabIds: change.savedTabIds ?? [],
    createdSession: false,
    windowSources: {},
    closed: false,
    ...(change.patches?.length ? { patches: change.patches } : {}),
    ...(change.putBack?.tabs.length ? { putBack: change.putBack } : {}),
    ...(change.folders?.length ? { folders: change.folders } : {}),
    ...(change.foldersMade?.length ? { foldersMade: change.foldersMade } : {}),
    ...(change.siteKind ? { siteKind: change.siteKind } : {}),
  };
  await lastAction.set(action);
  return action.id;
}

/** Put back fields an action changed on tabs that were already folded (a missing field is unset again). */
export async function applyPatches(patches: NonNullable<LastAction['patches']>): Promise<void> {
  if (patches.length === 0) return;
  await db.transaction('rw', db.tabs, async () => {
    for (const { id, before } of patches) {
      await db.tabs.update(id, { folderId: before.folderId, snoozeUntil: before.snoozeUntil, snoozedOn: before.snoozedOn });
    }
  });
}

export function handleSave(command: SaveCommand): Promise<SaveOutcome> {
  return saveQueue(saveKey(command), async () => {
    const settings = await getSettings();
    const duplicates = duplicatesMode(command, settings);
    const windows = await getNormalWindows();
    const plan = await buildPlan(windows, { ...command, includeIncognito: savesIncognito(command) }, settings);
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
    // The free list's limit: all of it fits, or nothing is saved or closed.
    await ensureRoomFor(plan.windows, duplicates === 'skip');

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
      const outcome = await closeTabsSafely(plan.closeTabIds, plannedTabs(plan, windows));
      closedTabs = outcome.closed;
      newTabsLeftOpen = outcome.newTabsLeftOpen;
      for (const tab of outcome.failed) stillOpen.add(tab.id!);
      freedBytes = estimateBytes(
        plan.closeTabIds.filter((id) => byId.has(id) && !byId.get(id)!.discarded && !stillOpen.has(id)).length,
      );
      failedToClose = outcome.failed.map((t) => refusedRef(t, byId));
    }

    const actionId = await recordUndo({ result, plan, now, close: command.close, closedTabs, freedBytes, stillOpen });

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

  if (action.closed) {
    // Tabs that refused to close are still open: don't open a second copy.
    const stillOpen = new Set(action.notClosedTabIds ?? []);
    const rows = (await db.tabs.bulkGet(action.savedTabIds)).filter((t): t is TabRecord => !!t && !stillOpen.has(t.id));
    // Skipped duplicates go back to the window they came from, after the saved tabs of that window.
    const extraBySource = new Map<number | undefined, RestoreTab[]>();
    const incognitoSources = new Set<number | undefined>();
    for (const item of action.reopenOnly ?? []) {
      extraBySource.set(item.sourceWindowId, [...(extraBySource.get(item.sourceWindowId) ?? []), reopenTab(item)]);
      if (item.incognito) incognitoSources.add(item.sourceWindowId);
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
      // An Incognito window comes back as an Incognito window, never a normal one.
      const incognito = record?.incognito === true || tabs.some((t) => t.incognito);
      targets.push((await windowExists(source, incognito)) ? source : undefined);
      plans.push({
        name: record?.name ?? '',
        bounds: record?.bounds ?? null,
        state: record?.state ?? null,
        focused: record?.wasFocused ?? false,
        tabs: [...tabs.sort((a, b) => a.order - b.order), ...extra],
        ...(incognito ? { incognito: true } : {}),
      });
    }
    for (const [source, tabs] of extraBySource) {
      const incognito = incognitoSources.has(source);
      targets.push((await windowExists(source, incognito)) ? source : undefined);
      plans.push({ name: '', bounds: null, state: null, focused: false, tabs, ...(incognito ? { incognito: true } : {}) });
    }
    // Undo puts tabs back as they were a moment ago: loaded, with their titles (not lazily).
    if (plans.length) await restoreWindows(plans, { mode: 'original', lazy: false, targetWindowIds: targets });
  }
  if (action.createdSession) await deleteSessionsForever([action.sessionId]);
  else if (action.savedTabIds.length) await removeTabs(action.savedTabIds);
  // Folders and site kinds first, so tabs put back into a folder find it there.
  if (action.folders?.length || action.foldersMade?.length || action.siteKind) await undoFolderChanges(action);
  if (action.patches?.length) await applyPatches(action.patches);
  if (action.putBack?.tabs.length) await putBackTabs(action.putBack);
  return { undone: true };
}
