import type { SiteKinds } from '../categories';
import type { FolderRecord } from '../types';
import { displayHost } from '../urls';
import {
  canonicalKeywords,
  capTitle,
  compareRecords,
  DELETED_FOLDER_TTL_MS,
  encodeFolderItem,
  isSyncable,
  MAX_SHARED_SITE_KINDS,
  pack,
  placementOf,
  pruneTombstones,
  sameKeywords,
  syncId,
  toSyncTime,
  urlKey,
  SYNC_LIMITS,
  type PackResult,
  type RemoteState,
  type SharedFolders,
  type SyncFolder,
  type SyncLimits,
  type SyncRecord,
  type SyncSiteKind,
  type Tombstone,
} from './records';

/**
 * How this computer's folded tabs and the copy in Chrome sync come together. Pure: the engine
 * reads both sides, asks for a plan, applies it to the database, then writes `packed` if it differs
 * from what Chrome sync holds.
 *
 * The model is a union: every computer merges what the others shared, and shares the newest tabs
 * it has (its own and merged ones). Removals travel as tombstones. Merging is commutative and
 * idempotent, so two computers that have seen the same changes compute the same shared copy and
 * stop writing: an echo of a write never causes another one.
 *
 * Folders and sites moved to another kind travel the same way in `tf.f` (newest change wins per
 * folder and per site), and each tab carries its folder and snooze (the newest change wins).
 */

/** A folded tab on this computer (in a live fold). */
export interface LocalTab {
  /** Database id. */
  id: string;
  url: string;
  title: string;
  savedAt: number;
  keywords: string[];
  folderId?: string;
  snoozeUntil?: number;
  snoozedOn?: string;
  placedAt?: number;
  /** Team copy only: who added it to the team. */
  addedBy?: string;
}

/** Folders (every row, deleted ones too) and site kinds on this computer. */
export interface LocalFolders {
  folders: FolderRecord[];
  kinds: SiteKinds;
  /** Sites put back to their usual kind: host → when. */
  removals: Record<string, number>;
}

export interface SyncPlanInput {
  local: LocalTab[];
  remote: Pick<RemoteState, 'records' | 'tombstones' | 'floor'> & Partial<Pick<RemoteState, 'folders'>>;
  /** Shared tabs that were on this computer after the last run: sync id -> urlKey. */
  known: Record<string, string>;
  /** Tombstones this computer wrote (sync id -> time), so putting a tab back takes them back. */
  mine: Record<string, number>;
  /** "Clear all data" time known on this computer (ms). */
  floor: number;
  now: number;
  budgetFactor?: number;
  /** Where the shared copy lives: Chrome sync's limits unless given (CLOUD_LIMITS for the Tabfold account). */
  limits?: SyncLimits;
  /** Folders and site kinds here: merged with `tf.f` and shared. Left out, `tf.f` isn't touched. */
  folders?: LocalFolders;
  /**
   * How many new tabs may come in (a Free list's room). The rest wait in the shared copy, which
   * still carries them. Unlimited unless given.
   */
  room?: number;
}

/** A tab's folder and snooze. A field left out means none. */
export type SyncPlacement = Pick<SyncRecord, 'folderId' | 'snoozeUntil' | 'snoozedOn' | 'placedAt'>;

export interface SyncUpdate {
  /** Database id. */
  id: string;
  title?: string;
  keywords?: string[];
  /** Its folder and snooze changed on another computer (or its folder was deleted). */
  placement?: SyncPlacement;
  /** Team copy: who added it (when this computer didn't know). */
  addedBy?: string;
}

export interface FolderMerge {
  /** Folder rows to write here: new from another computer, or changed there more recently. */
  write: FolderRecord[];
  /** Folders deleted more than 30 days ago: removed here too. */
  drop: string[];
  /** Site kinds and put-backs here after the merge (whole maps). */
  kinds: SiteKinds;
  removals: Record<string, number>;
  kindsChanged: boolean;
  /** What `tf.f` shares. */
  shared: SharedFolders;
  /** Deleted folders (id → when), after the merge. */
  deleted: Map<string, number>;
}

export interface SyncPlan {
  /** Database ids removed on another computer. */
  remove: string[];
  /** Same tab, newer title, more keywords, or a newer folder or snooze from another computer. */
  update: SyncUpdate[];
  /** Same address folded later on another computer: this copy becomes that one (newest wins). */
  adopt: Array<{ localId: string; record: SyncRecord }>;
  /** Tabs from other computers that this one doesn't have. */
  insert: SyncRecord[];
  /** What Chrome sync should hold afterwards. */
  packed: PackResult;
  known: Record<string, string>;
  mine: Record<string, number>;
  floor: number;
  /** `waiting`: tabs from other computers that didn't come in for lack of room (they stay shared). */
  counts: { synced: number; localOnly: number; waiting: number };
  /** Folders and site kinds after merging `tf.f`; null when `folders` wasn't given. */
  folders: FolderMerge | null;
}

/**
 * Our own tombstones are remembered as long as tombstones live: a tab this computer removed and
 * then put back (Undo, or restored some other way) is never deleted again because of sync.
 */
export const MINE_TTL_MS = SYNC_LIMITS.tombstoneMaxAgeMs;

function isPlaceholder(title: string, url: string): boolean {
  return !title || title === url || title === displayHost(url);
}

/** The same title on every computer: a real title beats the address, then the larger string. */
export function pickTitle(a: string, b: string, url: string): string {
  if (a === b) return a;
  const pa = isPlaceholder(a, url);
  const pb = isPlaceholder(b, url);
  if (pa !== pb) return pa ? b : a;
  return a > b ? a : b;
}

function placementKey(p: SyncPlacement): string {
  return `${p.folderId ?? ''}\u0001${p.snoozeUntil ?? 0}\u0001${p.snoozedOn ?? ''}`;
}

function samePlacement(a: SyncPlacement, b: SyncPlacement): boolean {
  return placementKey(a) === placementKey(b) && (a.placedAt ?? 0) === (b.placedAt ?? 0);
}

/** The newer of two placements (the latest change), the same on every computer. */
export function pickPlacement(a: SyncPlacement, b: SyncPlacement): SyncPlacement {
  const pa = a.placedAt ?? 0;
  const pb = b.placedAt ?? 0;
  if (pa !== pb) return placementOf(pa > pb ? a : b);
  return placementOf(placementKey(a) >= placementKey(b) ? a : b);
}

/** Who added a tab (team copy), the same on every computer: one that says beats one that doesn't. */
export function pickAddedBy(a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b) return a || b || undefined;
  return a <= b ? a : b;
}

/** Two copies of one tab (same sync id): commutative and idempotent, so every computer agrees. */
export function mergeContent(a: SyncRecord, b: SyncRecord): SyncRecord {
  const url = a.url === b.url ? a.url : a.url > b.url ? a.url : b.url;
  const addedBy = pickAddedBy(a.addedBy, b.addedBy);
  return {
    id: a.id,
    url,
    title: pickTitle(a.title, b.title, url),
    savedAt: Math.max(a.savedAt, b.savedAt),
    keywords: canonicalKeywords([...a.keywords, ...b.keywords]),
    ...pickPlacement(a, b),
    ...(addedBy ? { addedBy } : {}),
  };
}

/** A tab in a deleted folder is by site again, as a change made when the folder was deleted. */
function outOfDeleted(record: SyncRecord, deleted: Map<string, number>): SyncRecord {
  const at = record.folderId ? deleted.get(record.folderId) : undefined;
  if (at === undefined) return record;
  const { folderId: _gone, ...rest } = record;
  return { ...rest, placedAt: Math.max(record.placedAt ?? 0, at) };
}

// ---------------------------------------------------------------------------------------------
// Folders and site kinds (`tf.f`)

function toSyncFolder(folder: FolderRecord): SyncFolder {
  return {
    id: folder.id,
    name: folder.name,
    color: folder.color,
    order: folder.order,
    updatedAt: toSyncTime(folder.updatedAt),
    deletedAt: folder.deletedAt ? Math.max(1000, toSyncTime(folder.deletedAt)) : 0,
  };
}

const folderText = (f: SyncFolder) => JSON.stringify([f.id, f.name, f.color, f.order, f.updatedAt, f.deletedAt]);

/** The newer folder (the latest change); on a tie, the same choice on every computer. */
function pickFolder(a: SyncFolder, b: SyncFolder): SyncFolder {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return folderText(a) >= folderText(b) ? a : b;
}

function pickKind(a: SyncSiteKind, b: SyncSiteKind): SyncSiteKind {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return a.kind >= b.kind ? a : b;
}

function sortedJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
}

/**
 * Merge this computer's folders and site kinds with the shared `tf.f`: per folder and per site the
 * newest change wins. Deleted folders are shared for 30 days, then dropped everywhere. Folders last
 * changed before "Clear all data" (`floor`) are no longer shared nor brought in.
 */
export function mergeFolders(local: LocalFolders, remote: SharedFolders | null, now: number, floor = 0): FolderMerge {
  const expired = (f: SyncFolder) => f.deletedAt > 0 && f.deletedAt < now - DELETED_FOLDER_TTL_MS;
  const cleared = (f: SyncFolder) => f.updatedAt <= floor;
  const localById = new Map(local.folders.map((f) => [f.id, f]));
  const remoteById = new Map((remote?.folders ?? []).map((f) => [f.id, f]));

  const write: FolderRecord[] = [];
  const drop: string[] = [];
  const shared: SyncFolder[] = [];
  const deleted = new Map<string, number>();
  for (const id of new Set([...localById.keys(), ...remoteById.keys()])) {
    const here = localById.get(id);
    const mine = here ? toSyncFolder(here) : undefined;
    const theirs = remoteById.get(id);
    const usable = (f: SyncFolder | undefined) => (f && !expired(f) && !cleared(f) ? f : undefined);
    const a = usable(mine);
    const b = usable(theirs);
    const winner = a && b ? pickFolder(a, b) : (a ?? b);
    if (!winner) {
      // Deleted more than 30 days ago: gone here too.
      if (mine && expired(mine)) drop.push(id);
      continue;
    }
    shared.push(winner);
    if (winner.deletedAt) deleted.set(id, winner.deletedAt);
    if (winner === b && (!mine || folderText(mine) !== folderText(winner))) {
      write.push({
        ...(here ?? { createdAt: winner.updatedAt }),
        id,
        name: winner.name,
        color: winner.color,
        order: winner.order,
        updatedAt: winner.updatedAt,
        deletedAt: winner.deletedAt,
      } as FolderRecord);
    }
  }
  // Deleted here, never shared (or no longer): its tabs still leave it.
  for (const folder of local.folders) if (folder.deletedAt && !deleted.has(folder.id)) deleted.set(folder.id, toSyncTime(folder.deletedAt));

  // Site kinds: moves and put-backs, newest per site.
  const kindTtl = now - DELETED_FOLDER_TTL_MS;
  const entries = new Map<string, SyncSiteKind>();
  const offer = (entry: SyncSiteKind) => {
    if (entry.kind === '' && entry.at < kindTtl) return;
    const current = entries.get(entry.host);
    entries.set(entry.host, current ? pickKind(current, entry) : entry);
  };
  for (const [host, value] of Object.entries(local.kinds)) offer({ host, kind: value.kind, at: toSyncTime(value.at) });
  for (const [host, at] of Object.entries(local.removals)) offer({ host, kind: '', at: toSyncTime(at) });
  for (const entry of remote?.kinds ?? []) offer(entry);

  const kinds: SiteKinds = {};
  const removals: Record<string, number> = {};
  for (const entry of entries.values()) {
    if (entry.kind === '') {
      removals[entry.host] = local.removals[entry.host] !== undefined && toSyncTime(local.removals[entry.host]!) === entry.at ? local.removals[entry.host]! : entry.at;
    } else {
      const mine = local.kinds[entry.host];
      kinds[entry.host] = mine && mine.kind === entry.kind && toSyncTime(mine.at) === entry.at ? mine : { kind: entry.kind, at: entry.at };
    }
  }
  const kindsChanged = sortedJson(kinds) !== sortedJson(local.kinds) || sortedJson(removals) !== sortedJson(local.removals);
  const sharedKinds = [...entries.values()]
    .sort((a, b) => b.at - a.at || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))
    .slice(0, MAX_SHARED_SITE_KINDS);

  return { write, drop, kinds, removals, kindsChanged, shared: { folders: shared, kinds: sharedKinds }, deleted };
}

// ---------------------------------------------------------------------------------------------
// Tabs

interface View {
  /** Database id. */
  dbId: string;
  record: SyncRecord;
  key: string;
  /** Its folder and snooze as stored here (before merging); unset for tabs not here yet. */
  stored?: SyncPlacement;
}

function toRecord(tab: LocalTab, limits: SyncLimits): SyncRecord {
  return {
    id: syncId(tab.id),
    url: tab.url,
    title: capTitle(tab.title, limits),
    savedAt: toSyncTime(tab.savedAt),
    keywords: canonicalKeywords(tab.keywords),
    ...placementOf({
      folderId: tab.folderId,
      snoozeUntil: tab.snoozeUntil ? toSyncTime(tab.snoozeUntil) : undefined,
      snoozedOn: tab.snoozedOn,
      placedAt: tab.placedAt ? toSyncTime(tab.placedAt) : undefined,
    }),
    ...(tab.addedBy ? { addedBy: tab.addedBy } : {}),
  };
}

export function planSync(input: SyncPlanInput): SyncPlan {
  const limits = input.limits ?? SYNC_LIMITS;
  const now = toSyncTime(input.now);
  const floor = Math.max(toSyncTime(input.floor), toSyncTime(input.remote.floor));
  const room = input.room ?? Number.POSITIVE_INFINITY;

  // Folders first: a tab in a folder deleted anywhere goes back to its kind of site.
  const folders = input.folders ? mergeFolders(input.folders, input.remote.folders ?? null, now, floor) : null;
  const deletedFolders = folders?.deleted ?? new Map<string, number>();

  // This computer's folded tabs, by sync id and by address.
  const views: View[] = input.local.map((tab) => {
    const stored = toRecord(tab, limits);
    return { dbId: tab.id, record: outOfDeleted(stored, deletedFolders), key: urlKey(tab.url), stored: placementOf(stored) };
  });
  const bySid = new Map<string, View>();
  const byKey = new Map<string, View[]>();
  const index = (view: View) => {
    bySid.set(view.record.id, view);
    const list = byKey.get(view.key) ?? [];
    list.push(view);
    list.sort((a, b) => compareRecords(a.record, b.record));
    byKey.set(view.key, list);
  };
  const unindex = (view: View) => {
    if (bySid.get(view.record.id) === view) bySid.delete(view.record.id);
    const list = (byKey.get(view.key) ?? []).filter((v) => v !== view);
    if (list.length) byKey.set(view.key, list);
    else byKey.delete(view.key);
  };
  for (const view of views) index(view);

  // Tombstones: drop old ones, and take back our own when the tab is here again (Undo).
  const mine: Record<string, number> = {};
  for (const [id, at] of Object.entries(input.mine)) if (at >= now - limits.tombstoneMaxAgeMs) mine[id] = at;
  let tombstones = pruneTombstones(input.remote.tombstones, now, limits).filter((t) => {
    const ours = mine[t.id] !== undefined;
    if (ours && (bySid.has(t.id) || byKey.has(t.key))) {
      delete mine[t.id];
      return false;
    }
    return true;
  });

  // Tabs shared last time that are gone from this computer were removed here: tombstone them.
  const tombstoned = new Set(tombstones.map((t) => t.id));
  for (const [sid, key] of Object.entries(input.known)) {
    if (bySid.has(sid) || byKey.has(key) || tombstoned.has(sid)) continue;
    tombstones.push({ id: sid, at: now, key });
    tombstoned.add(sid);
    mine[sid] = now;
  }
  tombstones = pruneTombstones(tombstones, now, limits);
  const removedById = new Set(tombstones.map((t) => t.id));
  const removedKeyAt = new Map<string, number>();
  for (const t of tombstones) removedKeyAt.set(t.key, Math.max(removedKeyAt.get(t.key) ?? 0, t.at));
  const isTombstoned = (record: SyncRecord, key: string) =>
    removedById.has(record.id) || (removedKeyAt.get(key) ?? -1) >= record.savedAt;

  // Removed on another computer: remove the copy here (by id, or the same address folded earlier).
  const remove: string[] = [];
  for (const view of views) {
    if (!isTombstoned(view.record, view.key)) continue;
    remove.push(view.dbId);
    unindex(view);
  }

  // Bring in what the other computers shared.
  const update = new Map<string, SyncUpdate>();
  const adopt: SyncPlan['adopt'] = [];
  const insert: SyncRecord[] = [];
  /** New tabs that didn't fit in the list: not here, but still shared. */
  const waiting: SyncRecord[] = [];
  const remote = input.remote.records
    .filter((r) => isSyncable(r.url, limits) && r.savedAt > floor && !isTombstoned(r, urlKey(r.url)))
    .map((r) => outOfDeleted(r, deletedFolders))
    .sort(compareRecords);
  for (const incoming of remote) {
    const key = urlKey(incoming.url);
    const same = bySid.get(incoming.id);
    if (same) {
      const merged = mergeContent(same.record, incoming);
      const change: SyncUpdate = { id: same.dbId };
      if (merged.title !== same.record.title) change.title = merged.title;
      if (!sameKeywords(merged.keywords, same.record.keywords)) change.keywords = merged.keywords;
      if (merged.addedBy && merged.addedBy !== same.record.addedBy) change.addedBy = merged.addedBy;
      if (change.title !== undefined || change.keywords || change.addedBy) update.set(same.dbId, change);
      same.record = merged;
      continue;
    }
    const newest = byKey.get(key)?.[0];
    if (newest) {
      // The same address is folded here too. The newest copy wins on every computer.
      if (compareRecords(incoming, newest.record) < 0) {
        const record: SyncRecord = {
          ...incoming,
          keywords: canonicalKeywords([...incoming.keywords, ...newest.record.keywords]),
        };
        delete record.folderId;
        delete record.snoozeUntil;
        delete record.snoozedOn;
        delete record.placedAt;
        Object.assign(record, pickPlacement(incoming, newest.record));
        const adder = pickAddedBy(incoming.addedBy, newest.record.addedBy);
        if (adder) record.addedBy = adder;
        else delete record.addedBy;
        adopt.push({ localId: newest.dbId, record });
        unindex(newest);
        const view: View = { dbId: record.id, record, key };
        views.push(view);
        index(view);
      }
      continue;
    }
    if (insert.length >= room) {
      waiting.push(incoming);
      continue;
    }
    insert.push(incoming);
    const view: View = { dbId: incoming.id, record: incoming, key };
    views.push(view);
    index(view);
  }

  // A folder or snooze that changed (from another computer, or a deleted folder) is written here.
  for (const view of bySid.values()) {
    if (!view.stored) continue;
    const placement = placementOf(view.record);
    if (samePlacement(placement, view.stored)) continue;
    const change = update.get(view.dbId) ?? { id: view.dbId };
    change.placement = placement;
    update.set(view.dbId, change);
  }

  // Share the newest tab per address (folds after the last "Clear all data" only), and the tabs
  // still waiting for room here.
  const live = [...bySid.values()];
  const winners = new Map<string, SyncRecord>();
  const offer = (record: SyncRecord, key: string) => {
    if (!isSyncable(record.url, limits) || record.savedAt <= floor) return;
    const current = winners.get(key);
    if (!current || compareRecords(record, current) < 0) winners.set(key, record);
  };
  for (const view of live) offer(view.record, view.key);
  for (const record of waiting) offer(record, urlKey(record.url));
  const folderItem = folders ? encodeFolderItem(folders.shared, limits) : null;
  const packed = pack([...winners.values()], tombstones, { floor, budgetFactor: input.budgetFactor, limits, folderItem });

  const known: Record<string, string> = {};
  const sharedKeys = new Set<string>();
  for (const record of packed.records) {
    // A tab waiting for room isn't here: it is never "removed here" when it's missing next time.
    if (!bySid.has(record.id)) continue;
    const key = urlKey(record.url);
    known[record.id] = key;
    sharedKeys.add(key);
  }
  const localOnly = live.filter((view) => !known[view.record.id] && !sharedKeys.has(view.key)).length;
  // Only ids still tombstoned matter; keep the map small.
  const stillTombstoned = new Set(packed.tombstones.map((t) => t.id));
  const keptMine = Object.fromEntries(Object.entries(mine).filter(([id]) => stillTombstoned.has(id)));
  return {
    remove,
    update: [...update.values()],
    adopt,
    insert,
    packed,
    known,
    mine: keptMine,
    floor,
    counts: { synced: Object.keys(known).length, localOnly, waiting: waiting.length },
    folders,
  };
}

export type { SharedFolders, Tombstone };
