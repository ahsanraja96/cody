import Dexie from 'dexie';
import { browser } from 'wxt/browser';
import { categorize, siteKey, type CategoryId, type SiteKinds } from './categories';
import { bumpSearchVersion, db, type TabfoldDB } from './db';
import { FREE_LIMITS } from './limits';
import { CommandError } from './messages';
import { PROJECT_COLORS } from './pro/ai';
import { planState, projectsState } from './pro/state';
import { hasFreeLimits } from './pro/tiers';
import type { PlanState } from './pro/types';
import { updateSettings } from './settings';
import { recentFolders, siteKinds, type LastAction } from './state';
import { DELETED_FOLDER_TTL_MS, hash53, urlKey } from './sync/records';
import { isTeamSession, personalFolders } from './teams';
import { FOLDER_NOTE_MAX, TAB_GROUP_COLORS, type FolderRecord, type TabGroupColor, type TabRecord } from './types';

/**
 * Folders the person names (Fo-* boards), where tabs are (`TabRecord.folderId`), sites moved to
 * another kind, and the free list's limits. Everything here works in the worker and on Tabfold's
 * pages (it reads IndexedDB and extension storage only). Nothing here imports src/lib/repo.ts, so
 * repo can use it. Undo goes through `LastAction` (src/lib/background/save.ts `recordChangeUndo`).
 */

// ---------------------------------------------------------------------------------------------
// Folders

/** Folder names are at most this many characters. */
export const FOLDER_NAME_MAX = 60;

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const FOLDER_ID = /^[0-9a-z]{12}$/;

/** A new folder id: 12 characters [0-9a-z], the same on every computer once synced. */
export function newFolderId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export function isFolderId(value: unknown): value is string {
  return typeof value === 'string' && FOLDER_ID.test(value);
}

/**
 * The id a folder made from an old AI project gets: the same on every computer, so two computers
 * that both had "Checkout app" end up with one folder.
 */
export function projectFolderId(name: string): string {
  return hash53(`project:${name.trim().toLowerCase()}`).padStart(12, '0').slice(-12);
}

/** Trimmed, spaces collapsed, at most 60 characters; null when nothing is left. Duplicate names are allowed. */
export function cleanFolderName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const clean = Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, FOLDER_NAME_MAX).join('').trim();
  return clean || null;
}

/**
 * A folder's note (1.0): one line, whitespace squeezed, trimmed, at most 140 characters
 * (`FOLDER_NOTE_MAX`), never cutting a character in half (nor an emoji made of several). '' when
 * nothing is left.
 */
export function cleanFolderNote(note: unknown): string {
  if (typeof note !== 'string') return '';
  const line = note.replace(/\s+/g, ' ').trim();
  const points = Array.from(line);
  if (points.length <= FOLDER_NOTE_MAX) return line;
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(text: string): Iterable<{ segment: string }> } }).Segmenter;
  if (!Segmenter) return points.slice(0, FOLDER_NOTE_MAX).join('').trim();
  let out = '';
  let used = 0;
  for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(line)) {
    const size = Array.from(segment).length;
    if (used + size > FOLDER_NOTE_MAX) break;
    out += segment;
    used += size;
  }
  return out.trim();
}

export function isFolderColor(value: unknown): value is TabGroupColor {
  return typeof value === 'string' && (TAB_GROUP_COLORS as readonly string[]).includes(value);
}

/** A colour for the next folder: the AI's project colours in turn (never grey, which reads as "Other"). */
export function nextFolderColor(liveCount: number): TabGroupColor {
  return PROJECT_COLORS[liveCount % PROJECT_COLORS.length]!;
}

const byOrder = (a: FolderRecord, b: FolderRecord) => a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);

/** Folders that aren't deleted, in the left column's order (team folders too). */
export async function listLiveFolders(database: TabfoldDB = db): Promise<FolderRecord[]> {
  return (await database.folders.where('deletedAt').equals(0).toArray()).sort(byOrder);
}

/** The person's own live folders (no team's): what Organise, the tidy-up and Free's 3 folders go by. */
export async function listPersonalFolders(database: TabfoldDB = db): Promise<FolderRecord[]> {
  return personalFolders(await listLiveFolders(database));
}

/**
 * Folders deleted more than 30 days ago are gone for good (sync shares a deletion that long, so
 * other computers delete theirs too). Their tabs left them when they were deleted.
 */
export async function purgeDeletedFolders(now = Date.now(), database: TabfoldDB = db): Promise<number> {
  return database.folders.where('deletedAt').between(1, now - DELETED_FOLDER_TTL_MS, true, false).delete();
}

/** A live folder by id, or a CommandError ("not-found"). */
export async function requireFolder(id: string, database: TabfoldDB = db): Promise<FolderRecord> {
  const folder = await database.folders.get(id);
  if (!folder || folder.deletedAt) throw new CommandError('This folder no longer exists.', 'not-found');
  return folder;
}

/** What the limits need to know about a plan. */
export type PlanLike = Pick<PlanState, 'tier' | 'lifetime' | 'team'>;

/** The plan's Free limits apply? Reads the stored plan when none is given. */
export async function freeLimitsNow(plan?: PlanLike): Promise<boolean> {
  return hasFreeLimits(plan ?? (await planState.get()));
}

export function folderLimitError(): CommandError {
  return new CommandError(
    `Free has ${FREE_LIMITS.folders} folders. Upgrade for as many as you like, or delete one first.`,
    'folder-limit',
    { limit: FREE_LIMITS.folders },
  );
}

export interface NewFolder {
  name: string;
  color?: TabGroupColor;
  source?: FolderRecord['source'];
  id?: string;
  /** A team folder (Teams): it goes last among that team's folders and counts toward no limit. */
  teamId?: string;
}

/**
 * Add a folder, last in the left column. Free stops at 3 live folders (`folder-limit`) unless
 * `unlimited` (a paid plan, or a folder that brings nothing new, like the old projects); team
 * folders count toward no limit. Runs inside the caller's transaction when there is one (it needs
 * `folders`).
 */
export async function addFolder(
  input: NewFolder,
  options: { unlimited: boolean; now?: number },
  database: TabfoldDB = db,
): Promise<FolderRecord> {
  const name = cleanFolderName(input.name);
  if (!name) throw new CommandError('Give the folder a name.', 'invalid-name');
  const now = options.now ?? Date.now();
  return database.transaction('rw', [database.folders], async () => {
    const all = await database.folders.where('deletedAt').equals(0).toArray();
    const team = input.teamId ?? null;
    // A team's folders and the person's own are numbered apart: each list keeps its own order.
    const live = team ? all.filter((f) => f.teamId === team) : personalFolders(all);
    if (!team && !options.unlimited && live.length >= FREE_LIMITS.folders) throw folderLimitError();
    const folder: FolderRecord = {
      id: input.id && isFolderId(input.id) ? input.id : newFolderId(),
      name,
      color: isFolderColor(input.color) ? input.color : nextFolderColor(live.length),
      order: live.reduce((max, f) => Math.max(max, f.order + 1), 0),
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
      source: input.source ?? 'person',
      ...(team ? { teamId: team } : {}),
    };
    await database.folders.put(folder);
    return folder;
  });
}

// ---------------------------------------------------------------------------------------------
// Where tabs are

/**
 * A tab's folder and snooze before a change, so Undo can put them back: the same shape as
 * `LastAction.patches` (src/lib/state.ts), which the `undo` command applies.
 */
export type TabPatch = NonNullable<LastAction['patches']>[number];

/** What Undo needs to put a tab's folder and snooze back. */
export function patchOf(tab: TabRecord): TabPatch {
  return { id: tab.id, before: { folderId: tab.folderId, snoozeUntil: tab.snoozeUntil, snoozedOn: tab.snoozedOn } };
}

/** The same tab with this folder (or none), stamped as a change made now. */
export function placed(tab: TabRecord, folderId: string | null, now: number): TabRecord {
  const { folderId: _old, ...rest } = tab;
  return folderId ? { ...rest, folderId, placedAt: now } : { ...rest, placedAt: now };
}

/**
 * Put tabs in a folder, or take them out of theirs (`null`). Only tabs whose folder changes are
 * written; returns how many were found, how many moved, and what those were before (for Undo).
 */
export async function setTabsFolder(
  tabIds: string[],
  folderId: string | null,
  options: { now?: number } = {},
  database: TabfoldDB = db,
): Promise<{ found: number; moved: number; before: TabPatch[] }> {
  const now = options.now ?? Date.now();
  return database.transaction('rw', [database.tabs, database.meta], async () => {
    const rows = (await database.tabs.bulkGet([...new Set(tabIds)])).filter((t): t is TabRecord => !!t);
    const changing = rows.filter((t) => (t.folderId ?? null) !== folderId);
    if (changing.length === 0) return { found: rows.length, moved: 0, before: [] };
    await database.tabs.bulkPut(changing.map((t) => placed(t, folderId, now)));
    await bumpSearchVersion(database);
    return { found: rows.length, moved: changing.length, before: changing.map(patchOf) };
  });
}

/**
 * Undo's part for folders and site kinds (`LastAction.folders`, `foldersMade`, `siteKind`; the
 * `undo` command in src/lib/background/save.ts calls it). Putting things back counts as a new
 * change, so it wins on the other computers too.
 */
export async function undoFolderChanges(
  action: Pick<LastAction, 'folders' | 'foldersMade' | 'siteKind'>,
  now = Date.now(),
  database: TabfoldDB = db,
): Promise<void> {
  if (action.folders?.length || action.foldersMade?.length) {
    await database.transaction('rw', [database.folders], async () => {
      if (action.folders?.length) await database.folders.bulkPut(action.folders.map((f) => ({ ...f, updatedAt: now })));
      if (action.foldersMade?.length) {
        const made = (await database.folders.bulkGet(action.foldersMade)).filter((f): f is FolderRecord => !!f);
        await database.folders.bulkPut(made.map((f) => ({ ...f, deletedAt: now, updatedAt: now })));
      }
    });
  }
  if (action.siteKind) await restoreSiteKind(action.siteKind, now);
}

/** How many folders "used lately" keeps (`recentFolders`, 1.0). */
export const RECENT_FOLDERS_KEPT = 30;

/**
 * Tabs were folded or moved into these folders (1.0): they're "used lately", first after the starred
 * ones in "Fold into" lists and the right-click menu. The newest 30 are kept. Never throws.
 */
export async function noteRecentFolders(folderIds: Iterable<string>, now = Date.now()): Promise<void> {
  const ids = [...new Set(folderIds)].filter(Boolean);
  if (ids.length === 0) return;
  try {
    const current = await recentFolders.get();
    const next: Record<string, number> = { ...current };
    for (const id of ids) next[id] = now;
    const kept = Object.entries(next)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, RECENT_FOLDERS_KEPT);
    await recentFolders.set(Object.fromEntries(kept));
  } catch {
    // Only the order of a list depends on it.
  }
}

/** Opened from Tabfold: remembered for the weekly tidy-up ("not opened in a month"). Not synced. */
export async function markOpened(tabRecordIds: string[], now = Date.now(), database: TabfoldDB = db): Promise<void> {
  if (tabRecordIds.length === 0) return;
  await database.tabs.where(':id').anyOf(tabRecordIds).modify({ lastOpenedAt: now });
}

// The placement stamp: any change to a tab's folder or snooze that doesn't say when gets `placedAt`
// (now), so the newest change wins between computers. Writes that carry a placement from elsewhere
// (sync, the migration) run "quiet".

const PLACEMENT_FIELDS = ['folderId', 'snoozeUntil', 'snoozedOn'] as const;
const quietTransactions = new WeakSet<object>();
const stampedDatabases = new WeakSet<object>();
const bumpAfter = new WeakSet<object>();

/** Inside a transaction: tab writes in it keep the placement times they carry. */
export function quietPlacement(): void {
  const transaction = Dexie.currentTransaction;
  if (transaction) quietTransactions.add(transaction);
}

/**
 * Install the placement stamp on this database (once; the worker does it at start). When the
 * writing transaction can't bump the search version itself, it is bumped after it commits, so sync
 * notices the change.
 */
export function installPlacementStamp(database: TabfoldDB = db): void {
  if (stampedDatabases.has(database)) return;
  stampedDatabases.add(database);
  database.tabs.hook('updating', function (mods, _key, obj, transaction) {
    if (quietTransactions.has(transaction)) return undefined;
    const changes = mods as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(changes, 'placedAt')) return undefined;
    const current = obj as unknown as Record<string, unknown>;
    const moved = PLACEMENT_FIELDS.some(
      (field) => Object.prototype.hasOwnProperty.call(changes, field) && (changes[field] ?? null) !== (current[field] ?? null),
    );
    if (!moved) return undefined;
    const names = (transaction as unknown as { storeNames?: string[] }).storeNames ?? [];
    if (!names.includes('meta') && !bumpAfter.has(transaction)) {
      bumpAfter.add(transaction);
      transaction.on('complete', () => {
        bumpSearchVersion(database).catch(() => undefined);
      });
    }
    return { placedAt: Date.now() };
  });
}

// ---------------------------------------------------------------------------------------------
// The free list's limit (500 tabs)

/** Folded tabs now: the live folds' tab counts (snoozed tabs count too; a team's fold doesn't). */
export async function countFoldedTabs(database: TabfoldDB = db): Promise<number> {
  const live = await database.sessions.where('deletedAt').equals(0).toArray();
  return live.reduce((sum, session) => sum + (isTeamSession(session) ? 0 : session.tabCount || 0), 0);
}

export interface ListRoom {
  tabs: number;
  /** Null on a paid plan. */
  limit: number | null;
  /** Tabs that still fit (Infinity on a paid plan). */
  room: number;
}

export async function listRoom(plan?: PlanLike, database: TabfoldDB = db): Promise<ListRoom> {
  const [tabs, limited] = await Promise.all([countFoldedTabs(database), freeLimitsNow(plan)]);
  if (!limited) return { tabs, limit: null, room: Number.POSITIVE_INFINITY };
  return { tabs, limit: FREE_LIMITS.tabs, room: Math.max(0, FREE_LIMITS.tabs - tabs) };
}

/**
 * "Your free list is full (500 tabs). Make room or upgrade for unlimited." or "This needs room for
 * 23 tabs; your free list has room for 18." (`what`: "This fold", "This import"…).
 */
export function listFullError(room: number, needed: number, what = 'This'): CommandError {
  const limit = FREE_LIMITS.tabs;
  const message =
    room <= 0
      ? `Your free list is full (${limit} tabs). Make room or upgrade for unlimited.`
      : `${what} needs room for ${needed} tabs; your free list has room for ${room}.`;
  return new CommandError(message, 'list-full', { room: Math.max(0, room), needed, limit });
}

/**
 * Throws `list-full` when `needed` more tabs don't fit in the free list (nothing on a paid plan).
 * Returns the room otherwise. Callers check before saving or closing anything: never half.
 */
export async function throwIfNoRoom(needed: number, plan?: PlanLike, what?: string, database: TabfoldDB = db): Promise<ListRoom> {
  const room = await listRoom(plan, database);
  if (room.limit !== null && needed > 0 && needed > room.room) throw listFullError(room.room, needed, what);
  return room;
}

// ---------------------------------------------------------------------------------------------
// The same page folded twice

/** Same page: the same `urlKey`, and the same mode (an Incognito copy isn't the same tab). Snoozed tabs are left out. */
export function duplicateGroups(tabs: TabRecord[]): TabRecord[][] {
  const groups = new Map<string, TabRecord[]>();
  for (const tab of tabs) {
    if (tab.snoozeUntil) continue;
    const key = `${tab.incognito ? 'i:' : ''}${urlKey(tab.url)}`;
    const list = groups.get(key);
    if (list) list.push(tab);
    else groups.set(key, [tab]);
  }
  const newest = (a: TabRecord, b: TabRecord) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [...groups.values()]
    .filter((list) => list.length > 1)
    .map((list) => list.sort(newest))
    .sort((a, b) => newest(a[0]!, b[0]!));
}

// ---------------------------------------------------------------------------------------------
// Sites moved to another kind

const SITE_KIND_REMOVALS = 'siteKindsRemoved';
/** Put-backs kept this long, so another computer's older move doesn't come back. */
export const SITE_KIND_REMOVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Sites put back to their usual kind (host → when), shared so other computers put them back too. */
export const siteKindRemovals = {
  get: async (): Promise<Record<string, number>> =>
    ((await browser.storage.local.get(SITE_KIND_REMOVALS))[SITE_KIND_REMOVALS] as Record<string, number> | undefined) ?? {},
  set: (value: Record<string, number>) => browser.storage.local.set({ [SITE_KIND_REMOVALS]: value }),
};

/** Site kinds and put-backs together, as sync reads and writes them (src/lib/sync/engine.ts `SiteKindsStore`). */
export const storedSiteKinds = {
  async get(): Promise<{ kinds: SiteKinds; removals: Record<string, number> }> {
    const [kinds, removals] = await Promise.all([siteKinds.get(), siteKindRemovals.get()]);
    return { kinds, removals };
  },
  async set(value: { kinds: SiteKinds; removals: Record<string, number> }): Promise<void> {
    await Promise.all([siteKinds.set(value.kinds), siteKindRemovals.set(value.removals)]);
  },
};

/** The key a site is stored under, from a host or an address. Empty when it isn't a site. */
export function siteKindKey(hostOrUrl: string): string {
  const text = hostOrUrl.trim();
  if (!text) return '';
  return siteKey(text.includes('://') ? text : `https://${text}`);
}

/** The host is this site or one of its subdomains. */
export function hostIsSite(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

export interface SiteKindChange {
  host: string;
  before: { kind: CategoryId; at: number } | null;
}

/**
 * Move a site to another kind (`kind: null` puts it back). Moving it to the kind it would have
 * anyway removes the move instead. Returns what it was before (for Undo) and whether anything changed.
 */
export async function setSiteKind(
  hostOrUrl: string,
  kind: CategoryId | null,
  now = Date.now(),
): Promise<SiteKindChange & { changed: boolean }> {
  const host = siteKindKey(hostOrUrl);
  if (!host) throw new CommandError('That isn’t a site.', 'invalid-host');
  const [kinds, removals] = await Promise.all([siteKinds.get(), siteKindRemovals.get()]);
  const before = kinds[host] ? { ...kinds[host]! } : null;
  const others: SiteKinds = { ...kinds };
  delete others[host];
  const usual = categorize(`https://${host}/`, others);
  if (kind === null || kind === usual) {
    if (!before) return { host, before, changed: false };
    delete kinds[host];
    removals[host] = now;
  } else {
    if (before?.kind === kind) return { host, before, changed: false };
    kinds[host] = { kind, at: now };
    delete removals[host];
  }
  await Promise.all([siteKinds.set(kinds), siteKindRemovals.set(pruneRemovals(removals, now))]);
  return { host, before, changed: true };
}

/** Put a site's kind back as it was (Undo): a new change, so it wins on other computers too. */
export async function restoreSiteKind(change: SiteKindChange, now = Date.now()): Promise<void> {
  const [kinds, removals] = await Promise.all([siteKinds.get(), siteKindRemovals.get()]);
  if (change.before) {
    kinds[change.host] = { kind: change.before.kind, at: now };
    delete removals[change.host];
  } else {
    delete kinds[change.host];
    removals[change.host] = now;
  }
  await Promise.all([siteKinds.set(kinds), siteKindRemovals.set(pruneRemovals(removals, now))]);
}

function pruneRemovals(removals: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(removals)
      .filter(([, at]) => at >= now - SITE_KIND_REMOVAL_TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200),
  );
}

// ---------------------------------------------------------------------------------------------
// Before 0.6: AI projects become folders, once

const MIGRATED = 'foldersMigrated';

/**
 * Every project name (Organise with AI's `projects`, and every `TabRecord.project`) becomes a
 * folder (its colour, source `ai`), its tabs go in, `project` is cleared, and the list goes back to
 * By site. Runs once (a flag in `meta`) and is safe to run again. Not limited by Free's 3 folders:
 * nothing anyone had is taken away.
 */
export async function migrateProjectsToFolders(database: TabfoldDB = db, now = Date.now()): Promise<{ folders: number; tabs: number } | null> {
  if ((await database.meta.get(MIGRATED))?.value) return null;
  const state = await projectsState.get().catch(() => ({ projects: [], organisedAt: 0 }));
  const colorOf = new Map<string, TabGroupColor>();
  const names: string[] = [];
  const seen = new Set<string>();
  const addName = (raw: unknown, color?: unknown) => {
    const name = cleanFolderName(raw);
    if (!name) return;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
    if (isFolderColor(color) && !colorOf.has(key)) colorOf.set(key, color);
  };
  for (const project of state.projects ?? []) addName(project?.name, project?.color);
  const tabbed = await database.tabs.filter((t) => typeof t.project === 'string').toArray();
  for (const tab of tabbed) addName(tab.project);

  const result = await database.transaction('rw', [database.tabs, database.folders, database.meta], async () => {
    quietPlacement();
    if ((await database.meta.get(MIGRATED))?.value) return null;
    const all = await database.folders.toArray();
    const live = all.filter((f) => f.deletedAt === 0);
    let order = live.reduce((max, f) => Math.max(max, f.order + 1), 0);
    const folderOf = new Map<string, string | null>();
    let made = 0;
    for (const name of names) {
      const id = projectFolderId(name);
      const existing = all.find((f) => f.id === id);
      if (existing) {
        // Already here (from another computer's migration): use it unless it was deleted.
        folderOf.set(name.toLowerCase(), existing.deletedAt ? null : id);
        continue;
      }
      const sameName = live.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (sameName) {
        folderOf.set(name.toLowerCase(), sameName.id);
        continue;
      }
      await database.folders.put({
        id,
        name,
        color: colorOf.get(name.toLowerCase()) ?? nextFolderColor(live.length + made),
        order: order++,
        createdAt: now,
        updatedAt: now,
        deletedAt: 0,
        source: 'ai',
      });
      made += 1;
      folderOf.set(name.toLowerCase(), id);
    }
    let moved = 0;
    await database.tabs
      .filter((t) => t.project !== undefined)
      .modify((tab) => {
        const name = cleanFolderName(tab.project);
        const folderId = name ? folderOf.get(name.toLowerCase()) : null;
        if (folderId && !tab.folderId) {
          tab.folderId = folderId;
          moved += 1;
        }
        delete tab.project;
      });
    await database.meta.put({ key: MIGRATED, value: now });
    if (made || moved) await bumpSearchVersion(database);
    return { folders: made, tabs: moved };
  });
  if (result) {
    // The By project view is gone: the list is by folder, then by site.
    await updateSettings({ groupBy: 'site' }).catch(() => undefined);
    await projectsState.set(null).catch(() => undefined);
  }
  return result;
}
