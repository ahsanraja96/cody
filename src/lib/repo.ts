import Dexie from 'dexie';
import { aggregates, buildDraft, modeKey, type DraftMeta, type SkippedTab } from './capture';
import { refreshDataGuard, resetDataGuard } from './dataGuard';
import { bumpSearchVersion, db, type TabfoldDB } from './db';
import {
  addFolder,
  cleanFolderName,
  duplicateGroups,
  freeLimitsNow,
  listRoom,
  quietPlacement,
  setTabsFolder,
  type TabPatch,
} from './folders';
import { cleanKeywords } from './keywords';
import { CURRENT_PLAN, FREE_LIMITS, sessionLimitReached, tagsAllowed, UNSORTED_NAME, type Plan } from './limits';
import { newId } from './format';
import { clearLocal10State, getDeviceId, snapshotMirror } from './state';
import { clearSyncedData } from './sync/clear';
import { clearCloudSyncedData } from './sync/cloud';
import { forgetTeamSyncState } from './sync/team';
import { urlKey } from './sync/records';
import { isTeamSession, teamDeviceId, teamSessionName } from './teams';
import { dedupeKey, displayHost } from './urls';
import type {
  CapturedTab,
  CapturedWindow,
  FolderRecord,
  SessionDraft,
  SessionGraph,
  SessionRecord,
  SnapshotReason,
  SnapshotRecord,
  TabRecord,
  WindowRecord,
} from './types';

export class LimitError extends Error {
  constructor(
    message: string,
    readonly limit: 'sessions' | 'tags',
  ) {
    super(message);
    this.name = 'LimitError';
  }
}

const TRASH_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;

function liveRange(collection: TabfoldDB['sessions']) {
  return collection.where('[deletedAt+updatedAt]').between([0, Dexie.minKey], [0, Dexie.maxKey]);
}

// ---------------------------------------------------------------------------------------------
// Reads

export async function listLiveSessions(database: TabfoldDB = db): Promise<SessionRecord[]> {
  return liveRange(database.sessions).reverse().toArray();
}

export async function listRecentSessions(limit: number, database: TabfoldDB = db): Promise<SessionRecord[]> {
  return liveRange(database.sessions).reverse().limit(limit).toArray();
}

export async function listTrash(database: TabfoldDB = db): Promise<SessionRecord[]> {
  const rows = await database.sessions.where('deletedAt').above(0).toArray();
  return rows.sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function countNamedSessions(database: TabfoldDB = db): Promise<number> {
  const live = await liveRange(database.sessions).toArray();
  return live.filter((s) => s.kind !== 'unsorted').length;
}

/** Distinct tags on live sessions, with how many sessions use each. */
export async function tagCounts(database: TabfoldDB = db): Promise<Array<{ tag: string; count: number }>> {
  const counts = new Map<string, number>();
  for (const session of await liveRange(database.sessions).toArray()) {
    for (const tag of session.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
}

export async function getSessionGraph(id: string, database: TabfoldDB = db): Promise<SessionGraph | null> {
  const session = await database.sessions.get(id);
  if (!session) return null;
  const [windows, tabs] = await Promise.all([
    database.windows.where('sessionId').equals(id).toArray(),
    database.tabs.where('sessionId').equals(id).toArray(),
  ]);
  const byWindow = new Map<string, TabRecord[]>();
  for (const tab of tabs) {
    const list = byWindow.get(tab.windowId) ?? [];
    list.push(tab);
    byWindow.set(tab.windowId, list);
  }
  return {
    session,
    windows: windows
      .sort((a, b) => a.order - b.order)
      .map((window) => ({ ...window, tabs: (byWindow.get(window.id) ?? []).sort((a, b) => a.order - b.order) }))
      .filter((window) => window.tabs.length > 0),
  };
}

/** Keywords already in use, most used first. Feeds the "Your keywords" chips. */
export async function keywordVocabulary(
  limit = 12,
  database: TabfoldDB = db,
): Promise<Array<{ keyword: string; count: number }>> {
  const keys = (await database.tabs.orderBy('keywords').keys()) as string[];
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Saving

export interface SaveOptions {
  /** Add to this session instead of creating a new one. */
  targetSessionId?: string | null;
  /**
   * Skip tabs whose address is already saved in any live session (or earlier in this save). Keywords
   * picked for a skipped tab are added to the copy already saved.
   */
  dedupe: boolean;
  /**
   * Only with a plan given are named sessions capped (past the cap, saves go into Unsorted).
   * Tabfold has no plans now and sessions are not shown as such, so every fold, import and save
   * gets its own session.
   */
  plan?: Plan;
}

export interface SaveResult {
  /** The session written to. When every tab was a skipped duplicate, the session holding the first one. */
  sessionId: string;
  sessionName: string;
  createdSession: boolean;
  intoUnsorted: boolean;
  savedTabIds: string[];
  skippedDuplicates: number;
  /** Duplicates that were not written, with the browser window they came from. */
  skippedTabs: SkippedTab[];
  /** Browser tab id -> saved tab id, for tabs that were written. */
  tabIdMap: Map<number, string>;
  /** Saved window id -> browser window id it came from. */
  windowSources: Map<string, number>;
}

export interface SavedCopy {
  /** The saved tab with this address. */
  tab: TabRecord;
  /** The live session it is in. */
  session: SessionRecord;
}

/**
 * Where each address is already saved, among live sessions. Keyed by `dedupeKey`. When an address
 * is saved more than once, the copy in `preferSessionId` wins, then the most recently updated session.
 */
export async function findSavedCopies(
  urls: Iterable<string>,
  preferSessionId?: string | null,
  database: TabfoldDB = db,
  /** Only copies folded from Incognito (true) or from normal windows (false); any when left out. */
  incognito?: boolean,
): Promise<Map<string, SavedCopy>> {
  const keys = new Set([...urls].map(dedupeKey));
  const found = new Map<string, SavedCopy>();
  if (keys.size === 0) return found;
  // Stored addresses may or may not end in a slash; dedupeKey ignores one.
  const rows = await database.tabs
    .where('url')
    .anyOf([...keys].flatMap((key) => [key, `${key}/`]))
    .toArray();
  if (rows.length === 0) return found;
  const sessionIds = [...new Set(rows.map((t) => t.sessionId))];
  const sessions = new Map(
    (await database.sessions.bulkGet(sessionIds))
      .filter((s): s is SessionRecord => !!s && s.deletedAt === 0)
      .map((s) => [s.id, s]),
  );
  for (const tab of rows) {
    const session = sessions.get(tab.sessionId);
    const key = dedupeKey(tab.url);
    if (!session || !keys.has(key)) continue;
    if (incognito !== undefined && !!tab.incognito !== incognito) continue;
    const current = found.get(key);
    const better =
      !current ||
      (current.session.id !== preferSessionId &&
        (session.id === preferSessionId || session.updatedAt > current.session.updatedAt));
    if (better) found.set(key, { tab, session });
  }
  return found;
}

/** Refresh a session's counts and favicon strip. `touch` moves it up the list (an edit by the user). */
async function recomputeSession(sessionId: string, database: TabfoldDB, now: number, touch = true): Promise<SessionRecord | null> {
  const session = await database.sessions.get(sessionId);
  if (!session) return null;
  const [windows, tabs] = await Promise.all([
    database.windows.where('sessionId').equals(sessionId).toArray(),
    database.tabs.where('sessionId').equals(sessionId).toArray(),
  ]);
  const used = new Set(tabs.map((t) => t.windowId));
  const emptyWindows = windows.filter((w) => !used.has(w.id));
  if (emptyWindows.length) await database.windows.bulkDelete(emptyWindows.map((w) => w.id));
  const next: SessionRecord = {
    ...session,
    ...aggregates(windows.filter((w) => used.has(w.id)), tabs),
    updatedAt: touch ? now : session.updatedAt,
    version: session.version + 1,
  };
  await database.sessions.put(next);
  return next;
}

async function findOrCreateUnsorted(database: TabfoldDB, deviceId: string, now: number): Promise<SessionRecord> {
  const existing = (await liveRange(database.sessions).toArray()).find((s) => s.kind === 'unsorted');
  if (existing) return existing;
  const session: SessionRecord = {
    id: newId(),
    name: UNSORTED_NAME,
    tags: [],
    pinned: 0,
    color: null,
    kind: 'unsorted',
    source: 'manual',
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    deviceId,
    version: 1,
    tabCount: 0,
    windowCount: 0,
    preview: [],
  };
  await database.sessions.add(session);
  return session;
}

/**
 * Write captured windows as a new session, or into an existing one. Resolves only after the
 * IndexedDB transaction commits; callers close tabs only after this resolves.
 */
export async function saveCapture(
  windows: CapturedWindow[],
  meta: Omit<DraftMeta, 'existingUrls' | 'kind' | 'dedupe'>,
  options: SaveOptions,
  database: TabfoldDB = db,
): Promise<SaveResult> {
  return database.transaction('rw', [database.sessions, database.windows, database.tabs, database.meta], async () => {
    let target: SessionRecord | null = null;
    if (options.targetSessionId) {
      const found = await database.sessions.get(options.targetSessionId);
      if (found && !found.deletedAt) target = found;
    }
    const captured = windows.flatMap((w) => w.tabs);
    const incognitoTabs = new Set(windows.filter((w) => w.incognito).flatMap((w) => w.tabs));

    // Tabs restored lazily and never opened have no title yet; reuse the title saved for that address.
    for (const tab of captured) {
      if (tab.title !== displayHost(tab.url) && tab.title !== tab.url) continue;
      const known = await database.tabs.where('url').equals(tab.url).first();
      if (known && known.title !== tab.title && known.title !== displayHost(known.url)) tab.title = known.title;
    }

    // Duplicates are looked up per mode: an Incognito tab never folds into a normal copy, or the reverse.
    const copies = options.dedupe
      ? await findSavedCopies(
          captured.filter((t) => !incognitoTabs.has(t)).map((t) => t.url),
          target?.id,
          database,
          false,
        )
      : new Map<string, SavedCopy>();
    const incognitoCopies =
      options.dedupe && incognitoTabs.size
        ? await findSavedCopies(
            [...incognitoTabs].map((t) => t.url),
            target?.id,
            database,
            true,
          )
        : new Map<string, SavedCopy>();
    const copyOf = (tab: CapturedTab, incognito = incognitoTabs.has(tab)) =>
      (incognito ? incognitoCopies : copies).get(dedupeKey(tab.url));
    // A duplicate is skipped, but keywords picked for it still land on the tab already saved.
    const merged = new Map<string, TabRecord>();
    for (const tab of captured) {
      const copy = copyOf(tab);
      if (!copy || tab.keywords.length === 0) continue;
      const existing = merged.get(copy.tab.id) ?? copy.tab;
      const keywords = cleanKeywords([...existing.keywords, ...tab.keywords]);
      if (keywords.join('\u0001') !== existing.keywords.join('\u0001')) merged.set(existing.id, { ...existing, keywords });
    }
    if (merged.size) await database.tabs.bulkPut([...merged.values()]);

    const { draft, skippedDuplicates, skippedTabs, tabIdMap, windowIdMap } = buildDraft(windows, {
      ...meta,
      dedupe: options.dedupe,
      existingUrls: [...copies.values()].map((c) => c.tab.url),
      existingIncognitoUrls: [...incognitoCopies.values()].map((c) => c.tab.url),
    });
    const windowSources = new Map<string, number>([...windowIdMap.entries()].map(([source, id]) => [id, source]));

    if (draft.tabs.length === 0) {
      // Nothing new to write (every tab is saved already): no empty session, no Unsorted.
      if (merged.size) await bumpSearchVersion(database);
      const first = skippedTabs[0] ? copyOf(skippedTabs[0].tab, !!skippedTabs[0].incognito)?.session : undefined;
      const holder = target ?? first;
      return {
        sessionId: holder?.id ?? '',
        sessionName: holder?.name ?? '',
        createdSession: false,
        intoUnsorted: false,
        savedTabIds: [],
        skippedDuplicates,
        skippedTabs,
        tabIdMap,
        windowSources: new Map(),
      };
    }

    let intoUnsorted = false;
    if (!target) {
      const named = (await liveRange(database.sessions).toArray()).filter((s) => s.kind !== 'unsorted').length;
      if (options.plan && sessionLimitReached(named, options.plan)) {
        target = await findOrCreateUnsorted(database, meta.deviceId, meta.now);
        intoUnsorted = true;
      }
    }

    if (!target) {
      await database.sessions.add(draft.session);
      await database.windows.bulkAdd(draft.windows);
      await database.tabs.bulkAdd(draft.tabs);
      await bumpSearchVersion(database);
      return {
        sessionId: draft.session.id,
        sessionName: draft.session.name,
        createdSession: true,
        intoUnsorted: false,
        savedTabIds: draft.tabs.map((t) => t.id),
        skippedDuplicates,
        skippedTabs,
        tabIdMap,
        windowSources,
      };
    }

    const targetWindows = await database.windows.where('sessionId').equals(target.id).sortBy('order');
    const tabs: TabRecord[] = [];
    let newWindows: WindowRecord[] = [];
    if (meta.source === 'save-tabs' && targetWindows.length > 0) {
      // Single tabs join the session's first window, after its last tab.
      const first = targetWindows[0]!;
      const siblings = await database.tabs.where('windowId').equals(first.id).toArray();
      let order = siblings.reduce((max, t) => Math.max(max, t.order + 1), 0);
      for (const tab of draft.tabs) tabs.push({ ...tab, sessionId: target.id, windowId: first.id, order: order++ });
      for (const [source, draftWindowId] of windowIdMap) {
        windowSources.delete(draftWindowId);
        windowSources.set(first.id, source);
      }
    } else {
      let order = targetWindows.reduce((max, w) => Math.max(max, w.order + 1), 0);
      newWindows = draft.windows.map((w) => ({ ...w, sessionId: target!.id, order: order++ }));
      for (const tab of draft.tabs) tabs.push({ ...tab, sessionId: target.id });
    }
    if (newWindows.length) await database.windows.bulkAdd(newWindows);
    if (tabs.length) await database.tabs.bulkAdd(tabs);
    const updated = await recomputeSession(target.id, database, meta.now);
    await bumpSearchVersion(database);
    return {
      sessionId: target.id,
      sessionName: updated?.name ?? target.name,
      createdSession: false,
      intoUnsorted,
      savedTabIds: tabs.map((t) => t.id),
      skippedDuplicates,
      skippedTabs,
      tabIdMap,
      windowSources,
    };
  });
}

/**
 * A tab saved while its page was still loading was given its host as a title. Once Chrome reports
 * the real title, store it (and in the session's favicon strip). The session keeps its place in
 * the list: this is not an edit by the user.
 */
export async function fillTabTitle(tabId: string, title: string, database: TabfoldDB = db): Promise<boolean> {
  const clean = title.trim();
  if (!clean) return false;
  return database.transaction('rw', [database.sessions, database.tabs, database.meta], async () => {
    const tab = await database.tabs.get(tabId);
    if (!tab || tab.title === clean) return false;
    await database.tabs.update(tabId, { title: clean });
    const session = await database.sessions.get(tab.sessionId);
    if (session?.preview.some((p) => p.url === tab.url && p.title === tab.title)) {
      await database.sessions.put({
        ...session,
        preview: session.preview.map((p) => (p.url === tab.url && p.title === tab.title ? { ...p, title: clean } : p)),
        version: session.version + 1,
      });
    }
    await bumpSearchVersion(database);
    return true;
  });
}

/** Add whole sessions (imports, snapshot conversions, duplicates) in one transaction. */
export async function addDrafts(drafts: SessionDraft[], database: TabfoldDB = db): Promise<void> {
  if (drafts.length === 0) return;
  await database.transaction('rw', [database.sessions, database.windows, database.tabs, database.meta], async () => {
    await database.sessions.bulkAdd(drafts.map((d) => d.session));
    await database.windows.bulkAdd(drafts.flatMap((d) => d.windows));
    await database.tabs.bulkAdd(drafts.flatMap((d) => d.tabs));
    await bumpSearchVersion(database);
  });
}

export interface ImportOptions {
  deviceId?: string;
  /**
   * Each collection becomes a folder (source `import`), or goes into the folder that already has
   * its name. On Free, collections past the 3rd folder go by site instead (`withoutFolder`).
   */
  asFolders?: boolean;
  /** No limit on the list or on folders (a paid plan). Read from the stored plan when left out. */
  unlimited?: boolean;
  /** After each batch is written, with the tabs imported so far. */
  onProgress?: (done: number) => void;
  now?: number;
}

export interface ImportOutcome {
  /** Folds made (one per collection that brought tabs). */
  sessions: number;
  tabs: number;
  /** Always 0 now (imports aren't capped by sessions); kept for older callers. */
  intoUnsorted: number;
  /** Folders the tabs went into (new, or already there with the collection's name). */
  folders: number;
  /** Tabs left out because the free list is full (500 tabs). */
  skippedOverLimit: number;
  /** Collections that went by site because Free has 3 folders. */
  withoutFolder: number;
  /** Tabs left out because they're already in the list (or earlier in the import). */
  duplicates: number;
}

/** Tabs written per transaction, so a huge import shows progress and never holds one giant write. */
const IMPORT_BATCH = 2000;

/**
 * Import collections from another tab manager: each becomes its own fold (and, with `asFolders`,
 * a folder). Addresses already in the list are left out. On Free the import stops when the list
 * is full; what was left out is counted. Works on a page (the import dialog) and in the worker.
 */
export async function importSessions(
  sessions: Array<{ name: string; createdAt: number | null; windows: CapturedWindow[] }>,
  deviceIdOrOptions: string | ImportOptions = {},
  database: TabfoldDB = db,
): Promise<ImportOutcome> {
  const options: ImportOptions = typeof deviceIdOrOptions === 'string' ? { deviceId: deviceIdOrOptions } : deviceIdOrOptions;
  const deviceId = options.deviceId ?? (await getDeviceId());
  const now = options.now ?? Date.now();
  const unlimited = options.unlimited ?? !(await freeLimitsNow());
  const room = unlimited ? Number.POSITIVE_INFINITY : (await listRoom({ tier: 'free' }, database)).room;
  const seen = new Set((await listFoldedTabs(database)).filter((t) => !t.incognito).map((t) => modeKey(t.url, false)));
  const live = await database.folders.where('deletedAt').equals(0).toArray();
  const folderByName = new Map(live.map((f) => [f.name.toLowerCase(), f.id]));
  let liveFolders = live.length;

  const outcome: ImportOutcome = { sessions: 0, tabs: 0, intoUnsorted: 0, folders: 0, skippedOverLimit: 0, withoutFolder: 0, duplicates: 0 };
  const usedFolders = new Set<string>();
  let accepted = 0;
  let pending: SessionDraft[] = [];
  let pendingTabs = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    await addDrafts(pending, database);
    outcome.sessions += pending.length;
    outcome.tabs += pendingTabs;
    pending = [];
    pendingTabs = 0;
    options.onProgress?.(outcome.tabs);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  for (const session of sessions) {
    const windows: CapturedWindow[] = [];
    for (const window of session.windows) {
      const kept: CapturedTab[] = [];
      for (const tab of window.tabs) {
        const key = modeKey(tab.url, false);
        if (seen.has(key)) {
          outcome.duplicates += 1;
          continue;
        }
        if (accepted >= room) {
          outcome.skippedOverLimit += 1;
          continue;
        }
        seen.add(key);
        kept.push(tab);
        accepted += 1;
      }
      // Imports are never Incognito tabs.
      if (kept.length) windows.push({ name: window.name, focused: false, bounds: window.bounds, state: window.state, tabs: kept });
    }
    if (windows.length === 0) continue;

    let folderId: string | undefined;
    const name = options.asFolders ? cleanFolderName(session.name) : null;
    if (name) {
      folderId = folderByName.get(name.toLowerCase());
      if (!folderId && (unlimited || liveFolders < FREE_LIMITS.folders)) {
        folderId = (await addFolder({ name, source: 'import' }, { unlimited: true, now }, database)).id;
        folderByName.set(name.toLowerCase(), folderId);
        liveFolders += 1;
      } else if (!folderId) {
        outcome.withoutFolder += 1;
      }
    }
    if (folderId) usedFolders.add(folderId);

    const { draft } = buildDraft(windows, {
      name: session.name,
      source: 'import',
      deviceId,
      now: session.createdAt ?? now,
      dedupe: false,
    });
    if (folderId) for (const tab of draft.tabs) tab.folderId = folderId;
    pending.push(draft);
    pendingTabs += draft.tabs.length;
    if (pendingTabs >= IMPORT_BATCH) await flush();
  }
  await flush();
  outcome.folders = usedFolders.size;
  await refreshDataGuard(database).catch(() => undefined);
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Editing sessions

async function patchSession(id: string, patch: Partial<SessionRecord>, database: TabfoldDB, bump = false) {
  await database.transaction('rw', [database.sessions, database.meta], async () => {
    const session = await database.sessions.get(id);
    if (!session) return;
    await database.sessions.put({ ...session, ...patch, updatedAt: Date.now(), version: session.version + 1 });
    if (bump) await bumpSearchVersion(database);
  });
}

export async function renameSession(id: string, name: string, database: TabfoldDB = db): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await patchSession(id, { name: trimmed.slice(0, 200) }, database, true);
}

export async function setSessionPinned(id: string, pinned: boolean, database: TabfoldDB = db): Promise<void> {
  await patchSession(id, { pinned: pinned ? 1 : 0 }, database);
}

export async function setSessionTags(id: string, tags: string[], database: TabfoldDB = db): Promise<void> {
  const clean = cleanKeywords(tags).slice(0, 10);
  const live = await liveRange(database.sessions).toArray();
  const others = live.filter((s) => s.id !== id).flatMap((s) => s.tags);
  const current = live.find((s) => s.id === id)?.tags ?? [];
  if (!tagsAllowed(others, clean, CURRENT_PLAN, current)) {
    throw new LimitError('Free includes up to 5 tags. Pick a tag you already use, or remove one first.', 'tags');
  }
  await patchSession(id, { tags: clean }, database);
}

/** Rename a tag on every session (merging into the new name if it already exists). Never adds a tag. */
export async function renameTag(from: string, to: string, database: TabfoldDB = db): Promise<number> {
  const [next] = cleanKeywords([to]);
  if (!next || next === from) return 0;
  return database.transaction('rw', [database.sessions, database.meta], async () => {
    const rows = await database.sessions.where('tags').equals(from).toArray();
    const now = Date.now();
    for (const row of rows) {
      const tags = cleanKeywords(row.tags.map((t) => (t === from ? next : t)));
      await database.sessions.put({ ...row, tags, updatedAt: now, version: row.version + 1 });
    }
    if (rows.length) await bumpSearchVersion(database);
    return rows.length;
  });
}

/** Remove a tag from every session, including ones in Trash. The sessions themselves stay. */
export async function deleteTag(tag: string, database: TabfoldDB = db): Promise<number> {
  return database.transaction('rw', [database.sessions, database.meta], async () => {
    const rows = await database.sessions.where('tags').equals(tag).toArray();
    const now = Date.now();
    for (const row of rows) {
      await database.sessions.put({ ...row, tags: row.tags.filter((t) => t !== tag), updatedAt: now, version: row.version + 1 });
    }
    if (rows.length) await bumpSearchVersion(database);
    return rows.length;
  });
}

export async function duplicateSession(id: string, database: TabfoldDB = db): Promise<string | null> {
  const graph = await getSessionGraph(id, database);
  if (!graph) return null;
  const now = Date.now();
  const { draft } = buildDraft(
    graph.windows.map((w) => ({
      name: w.name,
      focused: w.wasFocused,
      bounds: w.bounds,
      state: w.state,
      tabs: w.tabs.map((t) => ({ ...t })),
    })),
    {
      name: `${graph.session.name} (copy)`,
      source: 'duplicate',
      deviceId: graph.session.deviceId,
      now,
      tags: graph.session.tags,
      dedupe: false,
    },
  );
  const named = await countNamedSessions(database);
  if (sessionLimitReached(named)) {
    throw new LimitError('Free includes up to 50 sessions. Delete or merge one to make a copy.', 'sessions');
  }
  await addDrafts([draft], database);
  return draft.session.id;
}

export async function trashSessions(ids: string[], database: TabfoldDB = db, now = Date.now()): Promise<void> {
  await database.transaction('rw', [database.sessions, database.meta], async () => {
    const rows = (await database.sessions.bulkGet(ids)).filter((s): s is SessionRecord => !!s);
    await database.sessions.bulkPut(rows.map((s) => ({ ...s, deletedAt: now, version: s.version + 1 })));
    await bumpSearchVersion(database);
  });
}

export async function restoreFromTrash(ids: string[], database: TabfoldDB = db): Promise<void> {
  const now = Date.now();
  await database.transaction('rw', [database.sessions, database.meta], async () => {
    const rows = (await database.sessions.bulkGet(ids)).filter((s): s is SessionRecord => !!s);
    await database.sessions.bulkPut(rows.map((s) => ({ ...s, deletedAt: 0, updatedAt: now, version: s.version + 1 })));
    await bumpSearchVersion(database);
  });
}

export async function deleteSessionsForever(ids: string[], database: TabfoldDB = db): Promise<void> {
  if (ids.length === 0) return;
  const left = await database.transaction('rw', [database.sessions, database.windows, database.tabs, database.meta], async () => {
    const existing = (await database.sessions.bulkGet(ids)).filter(Boolean).length;
    if (existing === 0) return -1;
    await database.tabs.where('sessionId').anyOf(ids).delete();
    await database.windows.where('sessionId').anyOf(ids).delete();
    await database.sessions.bulkDelete(ids);
    await bumpSearchVersion(database);
    return database.sessions.count();
  });
  // Tabfold itself emptied the library: an empty database is expected now, not a sign of a wipe.
  if (left === 0) await resetDataGuard(database).catch(() => undefined);
}

/** Hard-delete sessions that have been in Trash longer than 30 days. */
export async function purgeTrash(now = Date.now(), database: TabfoldDB = db): Promise<number> {
  const old = await database.sessions.where('deletedAt').between(1, now - TRASH_RETENTION_MS, true, true).primaryKeys();
  await deleteSessionsForever(old as string[], database);
  return old.length;
}

export async function renameWindow(windowId: string, name: string, database: TabfoldDB = db): Promise<void> {
  await database.windows.update(windowId, { name: name.trim().slice(0, 120) });
}

// ---------------------------------------------------------------------------------------------
// Editing tabs

export async function setTabKeywords(tabId: string, keywords: string[], database: TabfoldDB = db): Promise<string[]> {
  const clean = cleanKeywords(keywords);
  await database.transaction('rw', [database.tabs, database.meta], async () => {
    await database.tabs.update(tabId, { keywords: clean });
    await bumpSearchVersion(database);
  });
  return clean;
}

/** Remove tabs from their sessions. A session left empty goes to Trash, so nothing disappears silently. */
export async function removeTabs(tabIds: string[], database: TabfoldDB = db): Promise<void> {
  const now = Date.now();
  await database.transaction('rw', [database.sessions, database.windows, database.tabs, database.meta], async () => {
    const rows = (await database.tabs.bulkGet(tabIds)).filter((t): t is TabRecord => !!t);
    await database.tabs.bulkDelete(rows.map((t) => t.id));
    for (const sessionId of new Set(rows.map((t) => t.sessionId))) {
      const updated = await recomputeSession(sessionId, database, now);
      if (updated && updated.tabCount === 0 && updated.kind !== 'unsorted') {
        await database.sessions.put({ ...updated, deletedAt: now });
      }
    }
    await bumpSearchVersion(database);
  });
}

/** What `removeTabsWithSnapshot` took away, so Undo can put it back exactly. */
export interface RemovedTabs {
  tabs: TabRecord[];
  windows: WindowRecord[];
}

/** Remove folded tabs (the × on a row, "Remove all" on a group) and return what Undo needs. */
export async function removeTabsWithSnapshot(tabIds: string[], database: TabfoldDB = db): Promise<RemovedTabs> {
  const tabs = (await database.tabs.bulkGet(tabIds)).filter((t): t is TabRecord => !!t);
  const windowIds = [...new Set(tabs.map((t) => t.windowId))];
  const windows = (await database.windows.bulkGet(windowIds)).filter((w): w is WindowRecord => !!w);
  await removeTabs(tabIds, database);
  return { tabs, windows };
}

/**
 * Remove the extra copies of pages folded more than once (every such page, or only these
 * addresses): the newest copy stays. When it isn't in a folder but an older copy is, it moves into
 * that folder first, so nothing leaves a folder. Returns what Undo needs.
 */
export async function removeDuplicateCopies(
  urls?: string[],
  database: TabfoldDB = db,
): Promise<{ removed: RemovedTabs; placements: TabPatch[] }> {
  const wanted = urls ? new Set(urls.map(urlKey)) : null;
  const live = new Set((await database.folders.where('deletedAt').equals(0).filter((f) => !f.teamId).primaryKeys()) as string[]);
  const extras: string[] = [];
  const moves = new Map<string, string[]>();
  // A team's tabs are everyone's: they're never "extra copies" of the person's own.
  for (const group of duplicateGroups(await listPersonalTabs(database))) {
    const [keep, ...rest] = group;
    if (!keep || (wanted && !wanted.has(urlKey(keep.url)))) continue;
    if (!keep.folderId || !live.has(keep.folderId)) {
      const inFolder = rest.find((t) => t.folderId && live.has(t.folderId));
      if (inFolder) moves.set(inFolder.folderId!, [...(moves.get(inFolder.folderId!) ?? []), keep.id]);
    }
    extras.push(...rest.map((t) => t.id));
  }
  const placements: TabPatch[] = [];
  if (extras.length === 0) return { removed: { tabs: [], windows: [] }, placements };
  for (const [folderId, ids] of moves) placements.push(...(await setTabsFolder(ids, folderId, {}, database)).before);
  return { removed: await removeTabsWithSnapshot(extras, database), placements };
}

/** Undo a removal: bring the tabs (and any window or session emptied by it) back. */
export async function putBackTabs(removed: RemovedTabs, database: TabfoldDB = db): Promise<void> {
  const now = Date.now();
  await database.transaction('rw', [database.sessions, database.windows, database.tabs, database.meta], async () => {
    const existing = new Set((await database.windows.bulkGet(removed.windows.map((w) => w.id))).filter(Boolean).map((w) => w!.id));
    const missing = removed.windows.filter((w) => !existing.has(w.id));
    if (missing.length) await database.windows.bulkPut(missing);
    await database.tabs.bulkPut(removed.tabs);
    for (const sessionId of new Set(removed.tabs.map((t) => t.sessionId))) {
      const session = await database.sessions.get(sessionId);
      if (session?.deletedAt) await database.sessions.put({ ...session, deletedAt: 0 });
      await recomputeSession(sessionId, database, now);
    }
    await bumpSearchVersion(database);
  });
}

/**
 * Move a saved tab to another window (in the same or another session). `beforeTabId` places it in
 * front of that tab; otherwise it goes last. Moving to a session without a window id uses that
 * session's first window.
 */
export async function moveTab(
  tabId: string,
  destination: { windowId?: string; sessionId?: string; beforeTabId?: string | null },
  database: TabfoldDB = db,
): Promise<void> {
  const now = Date.now();
  await database.transaction('rw', [database.sessions, database.windows, database.tabs, database.meta], async () => {
    const tab = await database.tabs.get(tabId);
    if (!tab) return;
    let windowId = destination.windowId;
    let sessionId = destination.sessionId;
    if (windowId) {
      const window = await database.windows.get(windowId);
      if (!window) return;
      sessionId = window.sessionId;
    } else if (sessionId) {
      const first = (await database.windows.where('sessionId').equals(sessionId).sortBy('order'))[0];
      if (first) {
        windowId = first.id;
      } else {
        windowId = newId();
        await database.windows.add({ id: windowId, sessionId, name: '', order: 0, wasFocused: false, bounds: null, state: null });
      }
    }
    if (!windowId || !sessionId) return;
    const siblings = (await database.tabs.where('windowId').equals(windowId).sortBy('order')).filter((t) => t.id !== tabId);
    const insertAt = destination.beforeTabId ? siblings.findIndex((t) => t.id === destination.beforeTabId) : -1;
    siblings.splice(insertAt === -1 ? siblings.length : insertAt, 0, { ...tab, windowId, sessionId });
    await database.tabs.bulkPut(siblings.map((t, index) => ({ ...t, order: index })));
    const sessions = new Set([tab.sessionId, sessionId]);
    for (const id of sessions) await recomputeSession(id, database, now);
    await bumpSearchVersion(database);
  });
}

// ---------------------------------------------------------------------------------------------
// Chrome sync

/** Tabs folded on the person's other computers arrive in one fold with this name. */
export const SYNC_INBOX_NAME = 'From your other computers';

/** The fold that holds tabs from other computers (it isn't a fold of windows from this one). */
export function isSyncInbox(session: Pick<SessionRecord, 'deviceId'>): boolean {
  return session.deviceId.startsWith('sync:');
}

/** Every tab in a live fold. */
export async function listFoldedTabs(database: TabfoldDB = db): Promise<TabRecord[]> {
  const live = new Set((await listLiveSessions(database)).map((s) => s.id));
  if (live.size === 0) return [];
  return database.tabs.where('sessionId').anyOf([...live]).toArray();
}

/**
 * The person's own folded tabs: every tab in a live fold except a team's (src/lib/teams.ts). What
 * Chrome sync and the account carry, and what Make room, duplicates and the tidy-up look at.
 */
export async function listPersonalTabs(database: TabfoldDB = db): Promise<TabRecord[]> {
  const live = (await listLiveSessions(database)).filter((s) => !isTeamSession(s)).map((s) => s.id);
  if (live.length === 0) return [];
  return database.tabs.where('sessionId').anyOf(live).toArray();
}

/** A team's tabs: the ones in its live fold. */
export async function listTeamTabs(teamId: string, database: TabfoldDB = db): Promise<TabRecord[]> {
  const deviceId = teamDeviceId(teamId);
  const live = (await listLiveSessions(database)).filter((s) => s.deviceId === deviceId).map((s) => s.id);
  if (live.length === 0) return [];
  return database.tabs.where('sessionId').anyOf(live).toArray();
}

/**
 * A team's fold (one per team, "Team · <name>"), made when there's none, with its window and the
 * next tab position. Runs inside the caller's transaction (sessions, windows, tabs).
 */
export async function findOrCreateTeamSession(
  database: TabfoldDB,
  team: { id: string; name: string },
  now: number,
): Promise<{ session: SessionRecord; windowId: string; nextOrder: number }> {
  const deviceId = teamDeviceId(team.id);
  let session = (await liveRange(database.sessions).toArray()).find((s) => s.deviceId === deviceId);
  if (session && team.name && session.name !== teamSessionName(team.name)) {
    session = { ...session, name: teamSessionName(team.name) };
    await database.sessions.put(session);
  }
  if (!session) {
    session = {
      id: newId(),
      name: teamSessionName(team.name || 'Team'),
      tags: [],
      pinned: 0,
      color: null,
      kind: 'session',
      // Not a fold of windows: it stays out of Recent folds.
      source: 'import',
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
      deviceId,
      version: 1,
      tabCount: 0,
      windowCount: 0,
      preview: [],
    };
    await database.sessions.add(session);
  }
  return { session, ...(await firstWindow(database, session.id)) };
}

/** A fold's first window (made when it has none) and the next position in it. */
async function firstWindow(database: TabfoldDB, sessionId: string): Promise<{ windowId: string; nextOrder: number }> {
  const window = (await database.windows.where('sessionId').equals(sessionId).sortBy('order'))[0];
  if (window) {
    const siblings = await database.tabs.where('windowId').equals(window.id).toArray();
    return { windowId: window.id, nextOrder: siblings.reduce((max, t) => Math.max(max, t.order + 1), 0) };
  }
  const windowId = newId();
  await database.windows.add({ id: windowId, sessionId, name: '', order: 0, wasFocused: false, bounds: null, state: null });
  return { windowId, nextOrder: 0 };
}

/**
 * A personal fold to put tabs in that come out of a team folder ("From Truewidgets"): one per name
 * on this computer, made when there's none. Not a fold of windows, so not in Recent folds. Runs
 * inside the caller's transaction.
 */
export async function findOrCreatePersonalSession(
  database: TabfoldDB,
  name: string,
  deviceId: string,
  now: number,
): Promise<{ session: SessionRecord; windowId: string; nextOrder: number }> {
  let session = (await liveRange(database.sessions).toArray()).find(
    (s) => s.name === name && s.source === 'import' && s.deviceId === deviceId && s.kind === 'session',
  );
  if (!session) {
    session = {
      id: newId(),
      name,
      tags: [],
      pinned: 0,
      color: null,
      kind: 'session',
      source: 'import',
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
      deviceId,
      version: 1,
      tabCount: 0,
      windowCount: 0,
      preview: [],
    };
    await database.sessions.add(session);
  }
  return { session, ...(await firstWindow(database, session.id)) };
}

/** Refresh these folds' counts after tabs moved in or out; a fold left empty goes to Trash. Inside a transaction. */
export async function settleSessions(sessionIds: Iterable<string>, database: TabfoldDB, now: number): Promise<void> {
  for (const sessionId of new Set(sessionIds)) {
    const updated = await recomputeSession(sessionId, database, now);
    if (updated && updated.tabCount === 0 && updated.kind !== 'unsorted' && !updated.deletedAt) {
      await database.sessions.put({ ...updated, deletedAt: now });
    }
  }
}

/** A tab's folder and snooze, and when they last changed. A field left out means none. */
export type TabPlacement = Pick<TabRecord, 'folderId' | 'snoozeUntil' | 'snoozedOn' | 'placedAt'>;

/** A tab as it comes from Chrome sync. */
export interface SyncedTab extends TabPlacement {
  id: string;
  url: string;
  title: string;
  savedAt: number;
  keywords: string[];
  /** A team's copy: who added it. */
  addedBy?: string;
}

export interface SyncChanges {
  /** Removed on another computer. */
  remove: string[];
  update: Array<{ id: string; title?: string; keywords?: string[]; placement?: TabPlacement; addedBy?: string }>;
  /** Replace this computer's copy of an address with the newer one from another computer. */
  adopt: Array<{ localId: string; tab: SyncedTab }>;
  /** New from other computers: added to the "From your other computers" fold. */
  insert: SyncedTab[];
  /** Folders from other computers (new or changed), and folders deleted long enough ago to drop. */
  folders?: { write: FolderRecord[]; drop: string[] };
}

/** The row with exactly this folder and snooze (fields left out are cleared). */
function withPlacement(row: TabRecord, placement: TabPlacement): TabRecord {
  const { folderId: _f, snoozeUntil: _s, snoozedOn: _o, placedAt: _p, ...rest } = row;
  return {
    ...rest,
    ...(placement.folderId ? { folderId: placement.folderId } : {}),
    ...(placement.snoozeUntil ? { snoozeUntil: placement.snoozeUntil } : {}),
    ...(placement.snoozeUntil && placement.snoozedOn ? { snoozedOn: placement.snoozedOn } : {}),
    ...(placement.placedAt ? { placedAt: placement.placedAt } : {}),
  };
}

async function findOrCreateInbox(
  database: TabfoldDB,
  inboxId: string | null,
  deviceId: string,
  now: number,
): Promise<{ session: SessionRecord; windowId: string; nextOrder: number }> {
  let session = inboxId ? await database.sessions.get(inboxId) : undefined;
  if (!session || session.deletedAt) {
    session = (await liveRange(database.sessions).toArray()).find((s) => isSyncInbox(s));
  }
  if (!session) {
    session = {
      id: newId(),
      name: SYNC_INBOX_NAME,
      tags: [],
      pinned: 0,
      color: null,
      kind: 'session',
      source: 'import',
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
      deviceId: `sync:${deviceId}`,
      version: 1,
      tabCount: 0,
      windowCount: 0,
      preview: [],
    };
    await database.sessions.add(session);
  }
  const window = (await database.windows.where('sessionId').equals(session.id).sortBy('order'))[0];
  if (window) {
    const siblings = await database.tabs.where('windowId').equals(window.id).toArray();
    return { session, windowId: window.id, nextOrder: siblings.reduce((max, t) => Math.max(max, t.order + 1), 0) };
  }
  const windowId = newId();
  await database.windows.add({ id: windowId, sessionId: session.id, name: '', order: 0, wasFocused: false, bounds: null, state: null });
  return { session, windowId, nextOrder: 0 };
}

/**
 * Apply what Chrome sync brought, in one transaction. Folds that lose their last tab go to Trash,
 * as with any removal. Returns the id of the "From your other computers" fold when tabs went in.
 * With `team` (a team's copy), new tabs go into the team's fold instead, and that fold's id comes back.
 */
export async function applySyncChanges(
  changes: SyncChanges,
  options: { inboxId: string | null; deviceId: string; now?: number; team?: { id: string; name: string } },
  database: TabfoldDB = db,
): Promise<{ inboxId: string | null }> {
  const now = options.now ?? Date.now();
  const tables = [database.sessions, database.windows, database.tabs, database.meta, database.folders];
  return database.transaction('rw', tables, async () => {
    // Folders and snoozes arrive with the time they were set: keep it.
    quietPlacement();
    const touched = new Set<string>();
    let inboxId = options.inboxId;
    let changed = false;

    if (changes.folders?.write.length) await database.folders.bulkPut(changes.folders.write);
    if (changes.folders?.drop.length) await database.folders.bulkDelete(changes.folders.drop);
    changed ||= !!(changes.folders?.write.length || changes.folders?.drop.length);

    if (changes.remove.length) {
      const rows = (await database.tabs.bulkGet(changes.remove)).filter((t): t is TabRecord => !!t);
      await database.tabs.bulkDelete(rows.map((t) => t.id));
      for (const row of rows) touched.add(row.sessionId);
      changed ||= rows.length > 0;
    }
    for (const update of changes.update) {
      const row = await database.tabs.get(update.id);
      if (!row) continue;
      const next: TabRecord = {
        ...row,
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.keywords ? { keywords: update.keywords } : {}),
        ...(update.addedBy ? { addedBy: update.addedBy } : {}),
      };
      await database.tabs.put(update.placement ? withPlacement(next, update.placement) : next);
      touched.add(row.sessionId);
      changed = true;
    }
    for (const { localId, tab } of changes.adopt) {
      const row = await database.tabs.get(localId);
      if (!row) continue;
      const clash = await database.tabs.get(tab.id);
      if (clash) touched.add(clash.sessionId);
      await database.tabs.delete(localId);
      const { addedBy: _was, ...kept } = row;
      await database.tabs.put(
        withPlacement(
          { ...kept, id: tab.id, url: tab.url, title: tab.title, savedAt: tab.savedAt, keywords: tab.keywords, ...(tab.addedBy ? { addedBy: tab.addedBy } : {}) },
          tab,
        ),
      );
      touched.add(row.sessionId);
      changed = true;
    }
    if (changes.insert.length) {
      const inbox = options.team
        ? await findOrCreateTeamSession(database, options.team, now)
        : await findOrCreateInbox(database, inboxId, options.deviceId, now);
      inboxId = inbox.session.id;
      touched.add(inboxId);
      let order = inbox.nextOrder;
      for (const tab of changes.insert) {
        // A copy still sitting in a fold in Trash moves here.
        const clash = await database.tabs.get(tab.id);
        if (clash) touched.add(clash.sessionId);
        await database.tabs.put(
          withPlacement(
            {
              id: tab.id,
              sessionId: inbox.session.id,
              windowId: inbox.windowId,
              url: tab.url,
              title: tab.title,
              favIconUrl: '',
              pinned: false,
              groupName: null,
              groupColor: null,
              groupCollapsed: false,
              order: order++,
              savedAt: tab.savedAt,
              keywords: tab.keywords,
              urlTruncated: false,
              ...(tab.addedBy ? { addedBy: tab.addedBy } : {}),
            },
            tab,
          ),
        );
      }
      changed = true;
    }

    for (const sessionId of touched) {
      // Changes from another computer don't move a fold up the list; new tabs arriving do.
      const updated = await recomputeSession(sessionId, database, now, sessionId === inboxId && changes.insert.length > 0);
      if (updated && updated.tabCount === 0 && updated.kind !== 'unsorted' && !updated.deletedAt) {
        await database.sessions.put({ ...updated, deletedAt: now });
      }
    }
    if (changed) await bumpSearchVersion(database);
    return { inboxId };
  });
}

// ---------------------------------------------------------------------------------------------
// Snapshots

export interface SnapshotPolicy {
  /** Crash-recovery snapshots kept (Free: 1). */
  shutdown: number;
  /** Safety snapshots taken before bulk closes, restores and imports. */
  safety: number;
  safetyMaxAgeMs: number;
}

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
  shutdown: 1,
  safety: 5,
  safetyMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

export async function addSnapshot(snapshot: Omit<SnapshotRecord, 'id'>, database: TabfoldDB = db): Promise<number> {
  return (await database.snapshots.add(snapshot as SnapshotRecord)) as number;
}

export async function latestSnapshot(reason: SnapshotReason, database: TabfoldDB = db): Promise<SnapshotRecord | undefined> {
  const rows = await database.snapshots.where('reason').equals(reason).sortBy('createdAt');
  return rows.at(-1);
}

/** Every snapshot, newest first, including the rolling automatic ('timer') one. */
export async function listSnapshots(database: TabfoldDB = db): Promise<SnapshotRecord[]> {
  return database.snapshots.orderBy('createdAt').reverse().toArray();
}

export async function pruneSnapshots(
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
  now = Date.now(),
  database: TabfoldDB = db,
): Promise<void> {
  const all = await database.snapshots.orderBy('createdAt').reverse().toArray();
  const remove: number[] = [];
  let timer = 0;
  let shutdown = 0;
  let safety = 0;
  for (const snap of all) {
    if (snap.id === undefined) continue;
    if (snap.reason === 'timer') {
      if (++timer > 1) remove.push(snap.id);
    } else if (snap.reason === 'shutdown') {
      if (++shutdown > policy.shutdown) remove.push(snap.id);
    } else if (snap.reason !== 'manual') {
      if (++safety > policy.safety || now - snap.createdAt > policy.safetyMaxAgeMs) remove.push(snap.id);
    }
  }
  if (remove.length) await database.snapshots.bulkDelete(remove);
}

// ---------------------------------------------------------------------------------------------
// Everything

export async function exportGraphs(sessionIds?: string[], database: TabfoldDB = db): Promise<SessionGraph[]> {
  const sessions = sessionIds
    ? ((await database.sessions.bulkGet(sessionIds)).filter(Boolean) as SessionRecord[])
    : await listLiveSessions(database);
  const graphs: SessionGraph[] = [];
  for (const session of sessions) {
    const graph = await getSessionGraph(session.id, database);
    if (graph) graphs.push(graph);
  }
  return graphs;
}

export async function clearAllData(database: TabfoldDB = db): Promise<void> {
  const tables = [database.sessions, database.windows, database.tabs, database.snapshots, database.meta, database.folders];
  await database.transaction('rw', tables, async () => {
    await Promise.all([
      database.sessions.clear(),
      database.windows.clear(),
      database.tabs.clear(),
      database.snapshots.clear(),
      database.folders.clear(),
    ]);
    await bumpSearchVersion(database);
  });
  // The user asked for this: nothing to recover from, and no copy of the last snapshot kept; and
  // nothing 1.0 keeps beside the list either (window names, weekly numbers, recent folders…).
  await Promise.all([resetDataGuard(database), snapshotMirror.set(null), clearLocal10State()]).catch(() => undefined);
  // Gone from Chrome sync too ("Removes all folded tabs here and from Chrome sync"), and from the
  // Tabfold account for Pro.
  await clearSyncedData();
  await clearCloudSyncedData();
  // A team's copy is everyone's: it isn't cleared. This computer only forgets what it knew of it,
  // so the emptied list isn't taken for "removed everything" and the team's folders come back.
  await forgetTeamSyncState().catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Pro: backups, projects, smart names

/** A tab as kept in a backup (the sync format). */
export interface BackupTab {
  url: string;
  title: string;
  keywords: string[];
  savedAt?: number;
  /** The folder it was in (0.6 backups). */
  folderId?: string;
}

/**
 * Bring back tabs from a daily backup: one new fold (`name`, e.g. "Restored · 8 Oct") with every
 * tab whose address isn't already in a live fold, each back in its folder when that folder still
 * exists. Nothing is deleted or changed. The tabs count as folded now, so a removal recorded on
 * another computer since the backup doesn't take them away again. No fold is made when nothing is
 * missing. With `room` (a Free list), at most that many come back, the newest first.
 */
export async function restoreRecords(
  records: BackupTab[],
  name: string,
  options: { deviceId?: string; now?: number; room?: number } = {},
  database: TabfoldDB = db,
): Promise<{ restored: number; sessionId: string | null; skippedOverLimit: number }> {
  const now = options.now ?? Date.now();
  const newestFirst = [...records]
    .filter((r) => typeof r.url === 'string' && r.url)
    .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  const toTab = (r: BackupTab): CapturedTab => ({
    url: r.url,
    title: r.title || r.url,
    favIconUrl: '',
    pinned: false,
    groupName: null,
    groupColor: null,
    groupCollapsed: false,
    keywords: cleanKeywords(r.keywords ?? []),
    urlTruncated: false,
  });
  // Folded from normal windows only: a backup never holds Incognito tabs, and an Incognito copy isn't the same tab.
  const seen = new Set((await listPersonalTabs(database)).filter((t) => !t.incognito).map((t) => modeKey(t.url, false)));
  const missing: BackupTab[] = [];
  for (const record of newestFirst) {
    const key = modeKey(record.url, false);
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(record);
  }
  const room = options.room ?? Number.POSITIVE_INFINITY;
  const restoring = missing.slice(0, Math.max(0, room));
  const skippedOverLimit = missing.length - restoring.length;
  if (restoring.length === 0) return { restored: 0, sessionId: null, skippedOverLimit };
  const window: CapturedWindow = { name: '', focused: false, bounds: null, state: null, tabs: restoring.map(toTab) };
  const { draft } = buildDraft([window], {
    name,
    source: 'import',
    deviceId: options.deviceId ?? (await getDeviceId()),
    now,
    dedupe: false,
  });
  const live = new Set((await database.folders.where('deletedAt').equals(0).filter((f) => !f.teamId).primaryKeys()) as string[]);
  draft.tabs.forEach((tab, index) => {
    const folderId = restoring[index]?.folderId;
    if (folderId && live.has(folderId)) tab.folderId = folderId;
  });
  await addDrafts([draft], database);
  await refreshDataGuard(database).catch(() => undefined);
  return { restored: draft.tabs.length, sessionId: draft.session.id, skippedOverLimit };
}

/** The AI's name for a fold (Pro AI), shown instead of its time. Doesn't move the fold in the list. */
export async function setSmartName(sessionId: string, smartName: string, database: TabfoldDB = db): Promise<boolean> {
  const clean = Array.from(smartName.replace(/\s+/g, ' ').trim()).slice(0, 40).join('').trim();
  if (!clean) return false;
  return database.transaction('rw', [database.sessions, database.meta], async () => {
    const session = await database.sessions.get(sessionId);
    if (!session || session.deletedAt) return false;
    await database.sessions.put({ ...session, smartName: clean, version: session.version + 1 });
    await bumpSearchVersion(database);
    return true;
  });
}
