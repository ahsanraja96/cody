import { browser, type Browser } from 'wxt/browser';
import { captureTab, isPlaceholderTitle, rawTabUrl } from '../capture';
import { bumpSearchVersion, db } from '../db';
import { CommandError, type Command, type CommandResults } from '../messages';
import { removeTabsWithSnapshot, saveCapture, type RemovedTabs } from '../repo';
import { getSettings } from '../settings';
import { getDeviceId, liveFolders, type LiveFolder } from '../state';
import { planState } from '../pro/state';
import { placeTabs } from '../teamFolders';
import type { FolderRecord, TabRecord } from '../types';
import { capFavicon, capUrl, classifyUrl, displayHost } from '../urls';
import { currentNormalWindowId, ownOrigin } from './browserState';
import { sleepWhenLoaded } from './restore';
import { chunk, refuseToOpen } from './restorePlan';
import { requirePaid } from './room';
import { closeTabsSafely, recordChangeUndo, takeClosingByTabfold } from './save';

/**
 * Live folders (Mx-Live boards, Pro): a folder open as a Chrome tab group that saves itself. The
 * folder's tabs stay in the list while it's live. Tabs that join the group are saved to the
 * folder; a tab in the group that goes to another page updates its saved address and title; a tab
 * the person closes leaves the folder (Undo in the list), and one dragged out of the group leaves
 * it too. "Fold the group" closes the tabs (they're saved already); closing the window, closing the
 * whole group or ungrouping keeps everything.
 *
 * Bindings (`liveFolders`) and which open tab is which saved tab live in session storage: group
 * and tab ids don't survive a browser restart. Every change runs one at a time.
 */

export type LiveCommand = Extract<Command, { type: 'live-open' | 'live-fold' | 'live-focus' }>;

/** Browser tab id → the saved tab it is, in a live folder. */
type TabMap = Record<string, { folderId: string; recordId: string }>;

const LIVE_TABS = 'liveTabs';
/** A tab that left its group or closed waits this long, to tell it from the whole group going (closed, ungrouped). */
export const LIVE_SETTLE_MS = 500;
const BATCH_SIZE = 10;

let bindingsCache: Record<string, LiveFolder> | undefined;
let mapCache: TabMap | undefined;
let chain: Promise<unknown> = Promise.resolve();

/** For tests: forget what's cached in memory (as a fresh worker would). */
export function resetLiveRuntime(): void {
  bindingsCache = undefined;
  mapCache = undefined;
  chain = Promise.resolve();
  clearTimeout(settleTimer);
  settleTimer = undefined;
  pending = [];
}

/** One change at a time: events and commands never interleave their reads and writes. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

async function bindings(): Promise<Record<string, LiveFolder>> {
  bindingsCache ??= await liveFolders.get();
  return bindingsCache;
}

async function saveBindings(next: Record<string, LiveFolder>): Promise<void> {
  bindingsCache = next;
  await liveFolders.set(next);
}

async function tabMap(): Promise<TabMap> {
  mapCache ??= ((await browser.storage.session.get(LIVE_TABS))[LIVE_TABS] as TabMap | undefined) ?? {};
  return mapCache;
}

async function saveTabMap(next: TabMap): Promise<void> {
  mapCache = next;
  await browser.storage.session.set({ [LIVE_TABS]: next });
}

async function mapTabs(entries: Array<[number, { folderId: string; recordId: string }]>): Promise<void> {
  if (entries.length === 0) return;
  const next = { ...(await tabMap()) };
  for (const [tabId, entry] of entries) next[tabId] = entry;
  await saveTabMap(next);
}

async function unmapTabs(tabIds: number[]): Promise<void> {
  const current = await tabMap();
  if (!tabIds.some((id) => id in current)) return;
  const next = { ...current };
  for (const id of tabIds) delete next[id];
  await saveTabMap(next);
}

async function bindingForGroup(groupId: number | undefined): Promise<LiveFolder | undefined> {
  if (groupId === undefined || groupId < 0) return undefined;
  return Object.values(await bindings()).find((b) => b.groupId === groupId);
}

async function groupExists(groupId: number): Promise<boolean> {
  try {
    return !!(await browser.tabGroups.get(groupId));
  } catch {
    return false;
  }
}

/** The open tabs in a group, left to right. */
async function groupTabs(groupId: number): Promise<Browser.tabs.Tab[]> {
  const tabs = await browser.tabs.query({ groupId } as Browser.tabs.QueryInfo);
  return tabs.filter((t) => t.groupId === groupId && t.id !== undefined).sort((a, b) => a.windowId! - b.windowId! || a.index - b.index);
}

async function liveFolderRecord(folderId: string): Promise<FolderRecord> {
  const folder = await db.folders.get(folderId);
  if (!folder || folder.deletedAt) throw new CommandError('This folder no longer exists.', 'not-found');
  return folder;
}

/** The folder's tabs that open in its group: in live folds, not snoozed, not folded from Incognito. */
async function folderTabs(folderId: string): Promise<TabRecord[]> {
  const rows = await db.tabs.where('folderId').equals(folderId).toArray();
  const sessions = await db.sessions.bulkGet([...new Set(rows.map((r) => r.sessionId))]);
  const live = new Map(sessions.filter((s) => !!s && !s.deletedAt).map((s) => [s!.id, s!]));
  return rows
    .filter((r) => live.has(r.sessionId) && !r.snoozeUntil && !r.incognito)
    .sort((a, b) => live.get(a.sessionId)!.createdAt - live.get(b.sessionId)!.createdAt || a.order - b.order);
}

/** A tab whose page is worth saving (not a New Tab, not Tabfold's own pages, not Incognito). */
function saveable(tab: Browser.tabs.Tab): boolean {
  if (tab.incognito) return false;
  const kind = classifyUrl(rawTabUrl(tab), ownOrigin());
  return kind !== 'blank' && kind !== 'own';
}

/** Save an open tab that joined a live group as a tab in its folder (in the live folder's own fold). */
async function join(binding: LiveFolder, tab: Browser.tabs.Tab): Promise<string | null> {
  if (tab.id === undefined || !saveable(tab)) return null;
  const folder = await db.folders.get(binding.folderId);
  if (!folder || folder.deletedAt) return null;
  const captured = captureTab(tab, new Map());
  const now = Date.now();
  let target = binding.liveSessionId ? await db.sessions.get(binding.liveSessionId) : undefined;
  if (target?.deletedAt) target = undefined;
  const result = await saveCapture(
    [{ name: '', focused: false, bounds: null, state: null, tabs: [captured] }],
    { name: folder.name, source: 'save-tabs', deviceId: await getDeviceId(), now },
    { targetSessionId: target?.id ?? null, dedupe: false },
  );
  let recordId = result.savedTabIds[0];
  if (!recordId) return null;
  if (folder.teamId) {
    // A live team folder: the tab is shared with the team, as added by this person.
    const plan = await planState.get();
    if (!plan.email || plan.team?.id !== folder.teamId) return null;
    const placed = await placeTabs([recordId], folder, { email: plan.email, teamName: plan.team.name, deviceId: await getDeviceId(), now });
    recordId = placed.newIds[0];
    if (!recordId) return null;
  } else {
    await db.tabs.update(recordId, { folderId: binding.folderId });
  }
  if (result.sessionId !== binding.liveSessionId) {
    const all = await bindings();
    if (all[binding.folderId]) await saveBindings({ ...all, [binding.folderId]: { ...all[binding.folderId]!, liveSessionId: result.sessionId } });
  }
  await mapTabs([[tab.id, { folderId: binding.folderId, recordId }]]);
  return recordId;
}

/** A tab in a live group went to another page (or its title arrived): its saved copy follows. */
async function follow(recordId: string, tab: Browser.tabs.Tab): Promise<boolean> {
  if (!saveable(tab)) return false;
  const raw = rawTabUrl(tab);
  const { url, truncated } = capUrl(raw);
  const title = (tab.title ?? '').trim();
  return db.transaction('rw', [db.tabs, db.meta], async () => {
    const record = await db.tabs.get(recordId);
    if (!record) return false;
    const sameUrl = record.url === url;
    // Still loading: keep the title it had for this address, or show the site until the title arrives.
    const nextTitle = !isPlaceholderTitle(title, raw) && title !== url ? title : sameUrl ? record.title : displayHost(url) || url;
    const favIconUrl = tab.favIconUrl ? capFavicon(tab.favIconUrl) : sameUrl ? record.favIconUrl : '';
    if (sameUrl && nextTitle === record.title && favIconUrl === record.favIconUrl) return false;
    await db.tabs.update(recordId, { url, title: nextTitle, favIconUrl, urlTruncated: truncated });
    await bumpSearchVersion(db);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Tabs that closed or left a group: decided a moment later

interface Gone {
  tabId: number;
  folderId: string;
  recordId: string;
  groupId: number;
}

let pending: Gone[] = [];
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function settleLater(gone: Gone): void {
  pending.push(gone);
  settleTimer ??= setTimeout(() => {
    settleTimer = undefined;
    void serial(settle);
  }, LIVE_SETTLE_MS);
}

/**
 * Tabs that closed (by the person) or left their live group: when the group is still there, they
 * leave the folder (Undo in the list for closed ones); when the group went too (closed or
 * ungrouped as a whole), the folder keeps them.
 */
async function settle(): Promise<void> {
  const batch = pending;
  pending = [];
  if (batch.length === 0) return;
  const byGroup = new Map<number, Gone[]>();
  for (const gone of batch) byGroup.set(gone.groupId, [...(byGroup.get(gone.groupId) ?? []), gone]);
  const leaving: string[] = [];
  for (const [groupId, gone] of byGroup) {
    if (await groupExists(groupId)) leaving.push(...gone.map((g) => g.recordId));
  }
  if (leaving.length === 0) return;
  const removed: RemovedTabs = await removeTabsWithSnapshot(leaving);
  await recordChangeUndo({ putBack: removed, sessionId: removed.tabs[0]?.sessionId });
}

/** For tests: decide the closed and ungrouped tabs now, after every queued change. */
export async function settleLive(): Promise<void> {
  clearTimeout(settleTimer);
  settleTimer = undefined;
  await serial(settle);
}

// ---------------------------------------------------------------------------------------------
// Events (registered once at the worker's top level; cheap when nothing is live)

async function nothingLive(): Promise<boolean> {
  return Object.keys(await bindings()).length === 0 && Object.keys(await tabMap()).length === 0;
}

/** A tab was made or changed: it joined a live group, left one, or went to another page. */
async function onTab(event: Browser.tabs.Tab): Promise<void> {
  if (event.id === undefined || (await nothingLive())) return;
  const liveGroup = await bindingForGroup(event.groupId);
  if (!liveGroup && !(event.id in (await tabMap()))) return;
  // Changes are handled one at a time, so the event can be out of date (a tab grouped since): look again.
  const tab = await browser.tabs.get(event.id).catch(() => undefined);
  if (tab?.id === undefined) return;
  const binding = await bindingForGroup(tab.groupId);
  const mapped = (await tabMap())[tab.id];
  if (mapped && binding?.folderId !== mapped.folderId) {
    // Left its live group (or moved to another live folder's group).
    const left = (await bindings())[mapped.folderId];
    await unmapTabs([tab.id]);
    if (left) settleLater({ tabId: tab.id, ...mapped, groupId: left.groupId });
    if (binding) await join(binding, tab);
    return;
  }
  if (!binding) return;
  if (mapped) {
    if (!(await follow(mapped.recordId, tab)) && !(await db.tabs.get(mapped.recordId))) await unmapTabs([tab.id]);
    return;
  }
  await join(binding, tab);
}

export function onLiveTabCreated(tab: Browser.tabs.Tab): Promise<void> {
  if (tab.groupId === undefined || tab.groupId < 0) return Promise.resolve();
  return serial(() => onTab(tab));
}

export function onLiveTabUpdated(tabId: number, change: Browser.tabs.OnUpdatedInfo, tab: Browser.tabs.Tab): Promise<void> {
  const relevant = change.groupId !== undefined || change.url !== undefined || change.title !== undefined || change.status === 'complete';
  if (!relevant) return Promise.resolve();
  return serial(() => onTab({ ...tab, id: tab.id ?? tabId }));
}

/** A tab closed: closed by the person, it leaves its folder; closed by Tabfold or with its window, the folder keeps it. */
export function onLiveTabRemoved(tabId: number, info: { isWindowClosing: boolean; windowId?: number }): Promise<void> {
  const byTabfold = takeClosingByTabfold(tabId);
  return serial(async () => {
    const mapped = (await tabMap())[tabId];
    if (!mapped) return;
    await unmapTabs([tabId]);
    if (byTabfold || info.isWindowClosing) return;
    const binding = (await bindings())[mapped.folderId];
    if (binding) settleLater({ tabId, ...mapped, groupId: binding.groupId });
  });
}

/** Chrome swapped a tab for another (discarded, prerendered): it's the same saved tab. */
export function onLiveTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
  return serial(async () => {
    const mapped = (await tabMap())[removedTabId];
    if (!mapped) return;
    const next: TabMap = { ...(await tabMap()), [addedTabId]: mapped };
    delete next[removedTabId];
    await saveTabMap(next);
  });
}

async function dropBindings(match: (binding: LiveFolder) => boolean): Promise<void> {
  const all = await bindings();
  const gone = Object.values(all).filter(match);
  if (gone.length === 0) return;
  const next = { ...all };
  for (const binding of gone) delete next[binding.folderId];
  await saveBindings(next);
  const folders = new Set(gone.map((b) => b.folderId));
  const map = await tabMap();
  await unmapTabs(Object.entries(map).filter(([, v]) => folders.has(v.folderId)).map(([id]) => Number(id)));
}

/** The group went (closed, ungrouped): the folder stops being live and keeps its tabs. */
export function onLiveGroupRemoved(group: { id: number }): Promise<void> {
  return serial(async () => {
    if (await nothingLive()) return;
    await dropBindings((b) => b.groupId === group.id);
  });
}

/**
 * The window closed: its live folders stop being live and keep their tabs. A group dragged to
 * another window first stays live there.
 */
export function onLiveWindowRemoved(windowId: number): Promise<void> {
  return serial(async () => {
    if (await nothingLive()) return;
    const moved: LiveFolder[] = [];
    for (const binding of Object.values(await bindings())) {
      if (binding.windowId !== windowId) continue;
      const group = await browser.tabGroups.get(binding.groupId).catch(() => undefined);
      if (group && group.windowId !== windowId) moved.push({ ...binding, windowId: group.windowId });
    }
    if (moved.length) await saveBindings({ ...(await bindings()), ...Object.fromEntries(moved.map((b) => [b.folderId, b])) });
    await dropBindings((b) => b.windowId === windowId);
  });
}

/** Called once at the worker's top level. */
export function setupLive(): void {
  const safely = (task: Promise<unknown>) => task.catch((error) => console.error('[tabfold] live folder failed', (error as Error)?.name ?? error));
  browser.tabs.onCreated.addListener((tab) => void safely(onLiveTabCreated(tab)));
  browser.tabs.onUpdated.addListener((tabId, change, tab) => void safely(onLiveTabUpdated(tabId, change, tab)));
  browser.tabs.onRemoved.addListener((tabId, info) => void safely(onLiveTabRemoved(tabId, info)));
  browser.tabs.onReplaced.addListener((added, removed) => void safely(onLiveTabReplaced(added, removed)));
  browser.windows.onRemoved.addListener((windowId) => void safely(onLiveWindowRemoved(windowId)));
  try {
    browser.tabGroups.onRemoved.addListener((group) => void safely(onLiveGroupRemoved(group)));
  } catch {
    // No tab groups (an organisation policy): nothing can be live.
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

export async function handleLiveCommand(command: LiveCommand): Promise<CommandResults[LiveCommand['type']]> {
  switch (command.type) {
    case 'live-open':
      await requirePaid();
      return serial(() => openLive(command.folderId, command.newWindow, command.foldOthers === true));
    case 'live-fold':
      return serial(() => foldLive(command.folderId));
    case 'live-focus':
      return serial(() => focusLive(command.folderId));
  }
}

async function focusLive(folderId: string): Promise<{ focused: boolean }> {
  const binding = (await bindings())[folderId];
  if (!binding) return { focused: false };
  const tabs = await groupTabs(binding.groupId);
  if (tabs.length === 0 && !(await groupExists(binding.groupId))) {
    await dropBindings((b) => b.folderId === folderId);
    return { focused: false };
  }
  try {
    const first = tabs.find((t) => t.active) ?? tabs[0];
    if (first?.id !== undefined) await browser.tabs.update(first.id, { active: true });
    await browser.windows.update(first?.windowId ?? binding.windowId, { focused: true });
    return { focused: true };
  } catch {
    return { focused: false };
  }
}

/**
 * Open a folder as a live group: its tabs open (the first one shown, the rest loading once in the
 * background, like a restore) in a new window, or in the current one when that has nothing else
 * open; they become one Chrome tab group with the folder's name and colour.
 */
async function openLive(folderId: string, newWindow: boolean | undefined, foldOthers: boolean): Promise<CommandResults['live-open']> {
  const folder = await liveFolderRecord(folderId);
  const existing = (await bindings())[folderId];
  if (existing) {
    if (await groupExists(existing.groupId)) {
      await focusLive(folderId);
      return { opened: 0, groupId: existing.groupId, reason: 'This folder is already open.' };
    }
    await dropBindings((b) => b.folderId === folderId);
  }
  if (foldOthers) {
    for (const other of Object.keys(await bindings())) if (other !== folderId) await foldLive(other);
  }

  const origin = ownOrigin();
  const settings = await getSettings();
  const records = (await folderTabs(folderId)).filter((r) => !refuseToOpen(r.url, origin));
  const current = await currentNormalWindowId();
  const others = current !== undefined ? (await browser.tabs.query({ windowId: current })).filter((t) => classifyUrl(rawTabUrl(t), origin) !== 'blank') : [];
  const inNew = newWindow ?? (current === undefined || others.length > 0);

  let windowId = inNew ? undefined : current;
  let placeholder: number | undefined;
  if (windowId === undefined) {
    const created = await browser.windows.create({ focused: true });
    windowId = created?.id;
    placeholder = created?.tabs?.[0]?.id;
  }
  if (windowId === undefined) return { opened: 0, groupId: null, reason: 'Chrome couldn’t open a window. Try again.' };

  const opened: Array<[number, { folderId: string; recordId: string }]> = [];
  let first = true;
  for (const batch of chunk(records, BATCH_SIZE)) {
    const results = await Promise.all(
      batch.map(async (record, offset) => {
        const active = first && offset === 0;
        try {
          const tab = await browser.tabs.create({ windowId, url: record.url, active });
          let id = tab.id;
          if (id !== undefined && settings.lazyRestore && !active) {
            // Muted while it loads once in the background, then asleep until clicked.
            await browser.tabs.update(id, { muted: true }).catch(() => undefined);
            id = await sleepWhenLoaded(id);
          }
          return id === undefined ? null : ([id, { folderId, recordId: record.id }] as [number, { folderId: string; recordId: string }]);
        } catch {
          return null;
        }
      }),
    );
    first = false;
    for (const result of results) if (result) opened.push(result);
  }

  // An empty folder still opens as a group to work in: a New Tab (the new window's own, or one here).
  let groupTabIds = opened.map(([id]) => id);
  if (groupTabIds.length === 0) {
    const blank = placeholder ?? (await browser.tabs.create({ windowId, active: true }).catch(() => undefined))?.id;
    placeholder = undefined;
    if (blank !== undefined) groupTabIds = [blank];
  }
  if (placeholder !== undefined) await browser.tabs.remove(placeholder).catch(() => undefined);
  if (groupTabIds.length === 0) return { opened: 0, groupId: null, reason: 'Chrome couldn’t open the tabs. Try again.' };

  await mapTabs(opened);
  let groupId: number;
  try {
    groupId = await browser.tabs.group({ tabIds: groupTabIds as [number, ...number[]], createProperties: { windowId } });
    await browser.tabGroups.update(groupId, { title: folder.name, color: folder.color, collapsed: false });
  } catch {
    await unmapTabs(opened.map(([id]) => id));
    return { opened: opened.length, groupId: null, reason: 'Chrome didn’t let Tabfold make a tab group, so the tabs are open but don’t save themselves.' };
  }
  await saveBindings({ ...(await bindings()), [folderId]: { folderId, groupId, windowId, openedAt: Date.now() } });
  return { opened: opened.length, groupId };
}

/**
 * "Fold the group": the group's tabs are saved already (any not yet saved are saved now, and every
 * one's address and title brought up to date), then they close and the folder stops being live.
 */
async function foldLive(folderId: string): Promise<{ folded: number }> {
  const binding = (await bindings())[folderId];
  if (!binding) return { folded: 0 };
  const tabs = await groupTabs(binding.groupId);
  const map = await tabMap();
  let folded = 0;
  for (const tab of tabs) {
    const mapped = map[tab.id!];
    if (mapped?.folderId === folderId && (await db.tabs.get(mapped.recordId))) {
      await follow(mapped.recordId, tab);
      folded += 1;
    } else if (await join(binding, tab)) {
      folded += 1;
    }
  }
  await dropBindings((b) => b.folderId === folderId);
  const ids = tabs.map((t) => t.id!);
  if (ids.length) await closeTabsSafely(ids, new Map());
  return { folded };
}
