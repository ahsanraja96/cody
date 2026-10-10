import { displayHost } from '../urls';
import {
  canonicalKeywords,
  capTitle,
  compareRecords,
  isSyncable,
  pack,
  pruneTombstones,
  sameKeywords,
  syncId,
  toSyncTime,
  urlKey,
  SYNC_LIMITS,
  type PackResult,
  type RemoteState,
  type SyncLimits,
  type SyncRecord,
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
 */

/** A folded tab on this computer (in a live fold). */
export interface LocalTab {
  /** Database id. */
  id: string;
  url: string;
  title: string;
  savedAt: number;
  keywords: string[];
}

export interface SyncPlanInput {
  local: LocalTab[];
  remote: Pick<RemoteState, 'records' | 'tombstones' | 'floor'>;
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
}

export interface SyncUpdate {
  /** Database id. */
  id: string;
  title?: string;
  keywords?: string[];
}

export interface SyncPlan {
  /** Database ids removed on another computer. */
  remove: string[];
  /** Same tab, newer title or more keywords from another computer. */
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
  counts: { synced: number; localOnly: number };
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

/** Two copies of one tab (same sync id): commutative and idempotent, so every computer agrees. */
export function mergeContent(a: SyncRecord, b: SyncRecord): SyncRecord {
  const url = a.url === b.url ? a.url : a.url > b.url ? a.url : b.url;
  return {
    id: a.id,
    url,
    title: pickTitle(a.title, b.title, url),
    savedAt: Math.max(a.savedAt, b.savedAt),
    keywords: canonicalKeywords([...a.keywords, ...b.keywords]),
  };
}

interface View {
  /** Database id. */
  dbId: string;
  record: SyncRecord;
  key: string;
}

function toRecord(tab: LocalTab, limits: SyncLimits): SyncRecord {
  return {
    id: syncId(tab.id),
    url: tab.url,
    title: capTitle(tab.title, limits),
    savedAt: toSyncTime(tab.savedAt),
    keywords: canonicalKeywords(tab.keywords),
  };
}

export function planSync(input: SyncPlanInput): SyncPlan {
  const limits = input.limits ?? SYNC_LIMITS;
  const now = toSyncTime(input.now);
  const floor = Math.max(toSyncTime(input.floor), toSyncTime(input.remote.floor));

  // This computer's folded tabs, by sync id and by address.
  const views: View[] = input.local.map((tab) => {
    const record = toRecord(tab, limits);
    return { dbId: tab.id, record, key: urlKey(tab.url) };
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
  const update: SyncUpdate[] = [];
  const adopt: SyncPlan['adopt'] = [];
  const insert: SyncRecord[] = [];
  const remote = input.remote.records
    .filter((r) => isSyncable(r.url, limits) && r.savedAt > floor && !isTombstoned(r, urlKey(r.url)))
    .sort(compareRecords);
  for (const incoming of remote) {
    const key = urlKey(incoming.url);
    const same = bySid.get(incoming.id);
    if (same) {
      const merged = mergeContent(same.record, incoming);
      const change: SyncUpdate = { id: same.dbId };
      if (merged.title !== same.record.title) change.title = merged.title;
      if (!sameKeywords(merged.keywords, same.record.keywords)) change.keywords = merged.keywords;
      if (change.title !== undefined || change.keywords) update.push(change);
      same.record = merged;
      continue;
    }
    const newest = byKey.get(key)?.[0];
    if (newest) {
      // The same address is folded here too. The newest copy wins on every computer.
      if (compareRecords(incoming, newest.record) < 0) {
        const record = { ...incoming, keywords: canonicalKeywords([...incoming.keywords, ...newest.record.keywords]) };
        adopt.push({ localId: newest.dbId, record });
        unindex(newest);
        const view: View = { dbId: record.id, record, key };
        views.push(view);
        index(view);
      }
      continue;
    }
    insert.push(incoming);
    const view: View = { dbId: incoming.id, record: incoming, key };
    views.push(view);
    index(view);
  }

  // Share the newest tab per address (folds after the last "Clear all data" only).
  const live = [...bySid.values()];
  const winners = new Map<string, SyncRecord>();
  for (const view of live) {
    if (!isSyncable(view.record.url, limits) || view.record.savedAt <= floor) continue;
    const current = winners.get(view.key);
    if (!current || compareRecords(view.record, current) < 0) winners.set(view.key, view.record);
  }
  const packed = pack([...winners.values()], tombstones, { floor, budgetFactor: input.budgetFactor, limits });

  const known: Record<string, string> = {};
  const sharedKeys = new Set<string>();
  for (const record of packed.records) {
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
    update,
    adopt,
    insert,
    packed,
    known,
    mine: keptMine,
    floor,
    counts: { synced: packed.records.length, localOnly },
  };
}
