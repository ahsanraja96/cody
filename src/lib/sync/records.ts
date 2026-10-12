import { CATEGORIES, type CategoryId } from '../categories';
import { cleanKeywords } from '../keywords';
import { cleanAddedBy } from '../teams';
import { TAB_GROUP_COLORS, type TabGroupColor } from '../types';
import { classifyUrl, dedupeKey, MAX_URL_LENGTH } from '../urls';

/**
 * Sync of folded tabs: the compact format kept in chrome.storage.sync (and, for Pro, on the Tabfold
 * server in the same format), and how it is packed into keys within a quota. Everything here is
 * pure, so it can be tested without a browser.
 *
 * Keys (all start with "tf."): `tf.m` a small meta record, `tf.c0`, `tf.c1`… chunks of tab
 * records, `tf.t0`, `tf.t1`… chunks of tombstones (tabs removed on some computer).
 */

export const SYNC_PREFIX = 'tf.';
export const META_KEY = 'tf.m';
export const recordKey = (index: number) => `tf.c${index}`;
export const tombstoneKey = (index: number) => `tf.t${index}`;
/** Folders and sites moved to another kind (0.6): one item, `{ v: 1, f: [...], k: [...] }`. */
export const FOLDERS_KEY = 'tf.f';
/** Folders' notes (1.0): one item, `{ v: 1, n: [[folderId, note, noteAtSeconds], ...] }`. */
export const NOTES_KEY = 'tf.n';

/** Where the shared copy lives sets how much fits: Chrome sync's quota, or the Tabfold server's. */
export interface SyncLimits {
  /** Total: JSON of every value plus every key. */
  quotaBytes: number;
  /** One key plus its JSON value. */
  quotaBytesPerItem: number;
  maxItems: number;
  /** Each chunk (key plus JSON value) stays under this, well inside the per-item quota. */
  chunkBytes: number;
  /** Kept free under the total quota, for the meta record and the store's own accounting. */
  reserveBytes: number;
  /** The newest folded tabs shared, at most. */
  maxRecords: number;
  /** Longer addresses stay on this computer. */
  maxUrlLength: number;
  /** Titles are shortened to this many characters. */
  maxTitleLength: number;
  maxTombstones: number;
  tombstoneMaxAgeMs: number;
}

/** chrome.storage.sync limits, and how much of them Tabfold uses. The default everywhere. */
export const SYNC_LIMITS = {
  /** QUOTA_BYTES: JSON of every value plus every key, in total. */
  quotaBytes: 102_400,
  /** QUOTA_BYTES_PER_ITEM. */
  quotaBytesPerItem: 8_192,
  /** MAX_ITEMS. */
  maxItems: 512,
  /** Each chunk (key plus JSON value) stays under this, well inside the per-item quota. */
  chunkBytes: 7_500,
  /** Kept free under the total quota, for the meta record and Chrome's own accounting. */
  reserveBytes: 3_072,
  /** The newest folded tabs shared, at most. */
  maxRecords: 500,
  /** Longer addresses stay on this computer. */
  maxUrlLength: 2_000,
  /** Titles are shortened to this many characters. */
  maxTitleLength: 120,
  maxTombstones: 300,
  tombstoneMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const satisfies SyncLimits;

/**
 * Sync with the Tabfold account (Pro): the server keeps up to 8 MB per account (server/API.md), so
 * every folded tab fits in practice, with titles up to 200 characters.
 */
export const CLOUD_LIMITS = {
  quotaBytes: 8_000_000,
  quotaBytesPerItem: 262_144,
  maxItems: 5_000,
  chunkBytes: 60_000,
  reserveBytes: 16_384,
  maxRecords: 20_000,
  maxUrlLength: MAX_URL_LENGTH,
  maxTitleLength: 200,
  maxTombstones: 5_000,
  tombstoneMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const satisfies SyncLimits;

/** One folded tab as shared through Chrome sync. Times are whole seconds (in milliseconds). */
export interface SyncRecord {
  /** Stable id: the same on every computer (12 characters). */
  id: string;
  url: string;
  title: string;
  savedAt: number;
  keywords: string[];
  /** The folder it's in (`FolderRecord.id`); unset: by kind of site. */
  folderId?: string;
  /** Snoozed until (ms); unset when not snoozed. */
  snoozeUntil?: number;
  /** The computer that snoozed it (device id). */
  snoozedOn?: string;
  /** When its folder or snooze last changed (ms); unset: never. The newest change wins. */
  placedAt?: number;
  /** In a team's copy only: the email of whoever added it to the team (`[9]`). */
  addedBy?: string;
}

/** A tab removed on some computer: other computers remove their copy too. */
export interface Tombstone {
  id: string;
  /** When it was removed (whole seconds, in milliseconds). */
  at: number;
  /** urlKey of its address, so another computer's copy of the same address goes too. */
  key: string;
}

export interface SyncMeta {
  v: 1;
  /** Number of record chunks. */
  n: number;
  /** Number of tombstone chunks. */
  t: number;
  /** Hash of the content, to notice an unchanged or half-arrived copy. */
  h: string;
  /** "Clear all data" time (seconds): tabs folded before it are no longer shared. */
  c: number;
}

export interface RemoteState {
  records: SyncRecord[];
  tombstones: Tombstone[];
  meta: SyncMeta | null;
  /** Clear floor in milliseconds (0 when never cleared). */
  floor: number;
  /** Every chunk the meta record names is there and matches its hash. */
  complete: boolean;
  /** Folders and sites moved to another kind (`tf.f`); null when there is none. */
  folders: SharedFolders | null;
  /** Folders' notes (`tf.n`, 1.0); null when there is none. */
  notes: SyncNote[] | null;
  /** The whole copy's fingerprint (records, tombstones and `tf.f`), to notice an unchanged copy. */
  copyHash: string | null;
}

/**
 * Packed records: `[id, url, title, savedAtSec, keywords?, folderId?, snoozeUntilSec?, snoozedOn?,
 * placedAtSec?, addedBy?]`. Fields after the keywords came in 0.6 (`addedBy`, in a team's copy only,
 * with Teams); empty trailing ones are left off, and older readers ignore them.
 */
type PackedRecord = [
  id: string,
  url: string,
  title: string,
  savedAtSeconds: number,
  keywords?: string[],
  folderId?: string,
  snoozeUntilSeconds?: number,
  snoozedOn?: string,
  placedAtSeconds?: number,
  addedBy?: string,
];
type PackedTombstone = [id: string, atSeconds: number, key: string];

const SHORT_ID = /^[0-9a-z]{12}$/;

/** A 53-bit string hash (cyrb53), in base 36. Fast and well spread; not for security. */
export function hash53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The id a tab has in Chrome sync. A saved tab's id is a UUID; its first 12 hex digits are random
 * and short enough. Tabs that came from sync already have a 12-character id, kept as it is, so a
 * tab has the same id on every computer.
 */
export function syncId(localId: string): string {
  if (SHORT_ID.test(localId)) return localId;
  const hex = localId.toLowerCase().replace(/-/g, '');
  if (/^[0-9a-f]{32}$/.test(hex)) return hex.slice(0, 12);
  return hash53(localId).padStart(12, '0').slice(-12);
}

/** Same address on two computers: one key (the address ignoring a trailing slash, hashed). */
export function urlKey(url: string): string {
  return hash53(dedupeKey(url));
}

/** Times in sync are whole seconds; every comparison uses the same rounding on every computer. */
export function toSyncTime(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** At most 120 characters (Chrome sync; 200 for the Tabfold account), never cutting a character in half. */
export function capTitle(title: string, limits: SyncLimits = SYNC_LIMITS): string {
  const clean = title.trim();
  if (clean.length <= limits.maxTitleLength) return clean;
  return Array.from(clean).slice(0, limits.maxTitleLength).join('').trimEnd();
}

/** Short enough to share, and a real address (not data:, blob: or javascript:). */
export function isSyncable(url: string, limits: SyncLimits = SYNC_LIMITS): boolean {
  return !!url && url.length <= limits.maxUrlLength && classifyUrl(url) !== 'data';
}

/** Keywords in one canonical order, so the same set compares equal everywhere. */
export function canonicalKeywords(keywords: Iterable<string>): string[] {
  return cleanKeywords([...keywords].sort()).sort();
}

export function sameKeywords(a: string[], b: string[]): boolean {
  const x = canonicalKeywords(a);
  const y = canonicalKeywords(b);
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/** Newest first; ties broken by id, so every computer sorts the same way. */
export function compareRecords(a: Pick<SyncRecord, 'id' | 'savedAt'>, b: Pick<SyncRecord, 'id' | 'savedAt'>): number {
  return b.savedAt - a.savedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

const DEVICE_ID = /^[\w-]{1,64}$/;
const seconds = (ms: number | undefined) => (ms && ms > 0 ? Math.floor(ms / 1000) : 0);

function encodeRecord(record: SyncRecord): PackedRecord {
  const packed: PackedRecord = [record.id, record.url, record.title, Math.floor(record.savedAt / 1000)];
  const snoozed = !!record.snoozeUntil && record.snoozeUntil > 0;
  const tail: unknown[] = [
    canonicalKeywords(record.keywords),
    record.folderId ?? '',
    snoozed ? seconds(record.snoozeUntil) : 0,
    snoozed ? (record.snoozedOn ?? '') : '',
    seconds(record.placedAt),
    record.addedBy ?? '',
  ];
  let end = tail.length;
  const empty = (value: unknown) => value === '' || value === 0 || (Array.isArray(value) && value.length === 0);
  while (end > 0 && empty(tail[end - 1])) end -= 1;
  (packed as unknown[]).push(...tail.slice(0, end));
  return packed;
}

/** The same tab's folder and snooze, whatever else differs. */
export function placementOf(record: Pick<SyncRecord, 'folderId' | 'snoozeUntil' | 'snoozedOn' | 'placedAt'>): Pick<
  SyncRecord,
  'folderId' | 'snoozeUntil' | 'snoozedOn' | 'placedAt'
> {
  const out: Pick<SyncRecord, 'folderId' | 'snoozeUntil' | 'snoozedOn' | 'placedAt'> = {};
  if (record.folderId) out.folderId = record.folderId;
  if (record.snoozeUntil && record.snoozeUntil > 0) {
    out.snoozeUntil = record.snoozeUntil;
    if (record.snoozedOn) out.snoozedOn = record.snoozedOn;
  }
  if (record.placedAt && record.placedAt > 0) out.placedAt = record.placedAt;
  return out;
}

export function decodeRecord(raw: unknown, limits: SyncLimits = SYNC_LIMITS): SyncRecord | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const [id, url, title, savedSeconds, keywords, folderId, snoozeSeconds, snoozedOn, placedSeconds, addedBy] = raw as unknown[];
  if (typeof id !== 'string' || !SHORT_ID.test(id)) return null;
  if (typeof url !== 'string' || !isSyncable(url, limits)) return null;
  if (typeof title !== 'string') return null;
  if (typeof savedSeconds !== 'number' || !Number.isFinite(savedSeconds) || savedSeconds <= 0) return null;
  const words = Array.isArray(keywords) ? keywords.filter((k): k is string => typeof k === 'string') : [];
  const record: SyncRecord = {
    id,
    url,
    title: capTitle(title, limits),
    savedAt: Math.floor(savedSeconds) * 1000,
    keywords: canonicalKeywords(words),
  };
  // A malformed extra field is dropped on its own; the tab still comes in.
  if (typeof folderId === 'string' && SHORT_ID.test(folderId)) record.folderId = folderId;
  if (typeof snoozeSeconds === 'number' && Number.isFinite(snoozeSeconds) && snoozeSeconds > 0) {
    record.snoozeUntil = Math.floor(snoozeSeconds) * 1000;
    if (typeof snoozedOn === 'string' && DEVICE_ID.test(snoozedOn)) record.snoozedOn = snoozedOn;
  }
  if (typeof placedSeconds === 'number' && Number.isFinite(placedSeconds) && placedSeconds > 0) {
    record.placedAt = Math.floor(placedSeconds) * 1000;
  }
  const adder = cleanAddedBy(addedBy);
  if (adder) record.addedBy = adder;
  return record;
}

function encodeTombstone(tombstone: Tombstone): PackedTombstone {
  return [tombstone.id, Math.floor(tombstone.at / 1000), tombstone.key];
}

export function decodeTombstone(raw: unknown): Tombstone | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const [id, seconds, key] = raw as unknown[];
  if (typeof id !== 'string' || !SHORT_ID.test(id)) return null;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (typeof key !== 'string' || !key || key.length > 16) return null;
  return { id, at: Math.floor(seconds) * 1000, key };
}

/** Item size as Chrome measures it: the key plus the JSON of the value. */
export function itemBytes(key: string, value: unknown): number {
  return key.length + byteLength(JSON.stringify(value));
}

// ---------------------------------------------------------------------------------------------
// Folders and sites moved to another kind (`tf.f`)

/** A folder as shared. Times are whole seconds (in milliseconds); `deletedAt` 0 while live. */
export interface SyncFolder {
  id: string;
  name: string;
  color: TabGroupColor;
  order: number;
  updatedAt: number;
  deletedAt: number;
  /** Starred (1.0, field [6]): when; left out when not. A team's copy never carries one. */
  starredAt?: number;
}

/** A folder's note as shared (1.0, `tf.n`): '' when it was removed. `noteAt` in whole seconds (in milliseconds). */
export interface SyncNote {
  folderId: string;
  note: string;
  noteAt: number;
}

/** A site moved to another kind, or put back (`kind: ''`), and when (whole seconds, in milliseconds). */
export interface SyncSiteKind {
  host: string;
  kind: CategoryId | '';
  at: number;
}

export interface SharedFolders {
  folders: SyncFolder[];
  kinds: SyncSiteKind[];
}

/** `[6] starredAtSeconds` came in 1.0, only when starred; older readers ignore it. */
type PackedFolder = [id: string, name: string, color: string, order: number, updatedAtSeconds: number, deletedAtSeconds: number, starredAtSeconds?: number];
type PackedNote = [folderId: string, note: string, noteAtSeconds: number];
type PackedKind = [host: string, kind: string, atSeconds: number];

/** The `tf.f` item. */
export interface FolderItem {
  v: 1;
  f: PackedFolder[];
  k: PackedKind[];
}

/** Sites moved to another kind that are shared, at most (the newest). */
export const MAX_SHARED_SITE_KINDS = 200;
/** Deleted folders are shared this long, so other computers delete them too, then dropped. */
export const DELETED_FOLDER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CATEGORY_IDS = new Set<string>(CATEGORIES.map((c) => c.id));
const HOST = /^[a-z0-9.-]{1,253}$/;

function encodeFolder(folder: SyncFolder): PackedFolder {
  const packed: PackedFolder = [folder.id, folder.name, folder.color, folder.order, Math.floor(folder.updatedAt / 1000), Math.floor(folder.deletedAt / 1000)];
  if (folder.starredAt && folder.starredAt > 0) packed.push(Math.floor(folder.starredAt / 1000));
  return packed;
}

function encodeKind(kind: SyncSiteKind): PackedKind {
  return [kind.host, kind.kind, Math.floor(kind.at / 1000)];
}

export function decodeFolder(raw: unknown): SyncFolder | null {
  if (!Array.isArray(raw) || raw.length < 6) return null;
  const [id, name, color, order, updated, deleted, starred] = raw as unknown[];
  if (typeof id !== 'string' || !SHORT_ID.test(id)) return null;
  if (typeof name !== 'string' || !name.trim()) return null;
  if (typeof order !== 'number' || !Number.isFinite(order)) return null;
  if (typeof updated !== 'number' || !Number.isFinite(updated) || updated <= 0) return null;
  if (typeof deleted !== 'number' || !Number.isFinite(deleted) || deleted < 0) return null;
  const folder: SyncFolder = {
    id,
    name: Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, 60).join('').trim(),
    color: (TAB_GROUP_COLORS as readonly string[]).includes(color as string) ? (color as TabGroupColor) : 'grey',
    order,
    updatedAt: Math.floor(updated) * 1000,
    deletedAt: Math.floor(deleted) * 1000,
  };
  // A malformed star is dropped on its own; the folder still comes in.
  if (typeof starred === 'number' && Number.isFinite(starred) && starred > 0) folder.starredAt = Math.floor(starred) * 1000;
  return folder;
}

export function decodeKind(raw: unknown): SyncSiteKind | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const [host, kind, at] = raw as unknown[];
  if (typeof host !== 'string' || !HOST.test(host)) return null;
  if (typeof kind !== 'string' || (kind !== '' && !CATEGORY_IDS.has(kind))) return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  return { host, kind: kind as CategoryId | '', at: Math.floor(at) * 1000 };
}

/** What a `tf.f` item holds; anything malformed is skipped. Null when it isn't one. */
export function decodeFolderItem(raw: unknown): SharedFolders | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Partial<FolderItem>;
  if (item.v !== 1) return null;
  const folders: SyncFolder[] = [];
  const ids = new Set<string>();
  for (const entry of Array.isArray(item.f) ? item.f : []) {
    const folder = decodeFolder(entry);
    if (folder && !ids.has(folder.id)) {
      ids.add(folder.id);
      folders.push(folder);
    }
  }
  const kinds: SyncSiteKind[] = [];
  const hosts = new Set<string>();
  for (const entry of Array.isArray(item.k) ? item.k : []) {
    const kind = decodeKind(entry);
    if (kind && !hosts.has(kind.host)) {
      hosts.add(kind.host);
      kinds.push(kind);
    }
  }
  return { folders, kinds };
}

/**
 * The `tf.f` item for these folders and site kinds, within one item's quota (8 KB in Chrome sync).
 * When it doesn't fit, the oldest deleted folders go first, then the oldest site kinds, then (never
 * in practice) the folders changed longest ago. Entries are in one canonical order, so the same
 * content always gives the same item. Null when there is nothing to share.
 */
export function encodeFolderItem(shared: SharedFolders, limits: SyncLimits = SYNC_LIMITS): FolderItem | null {
  type Entry = { kind: 'f' | 'k'; text: string; bytes: number; drop: number; tie: string };
  const entries: Entry[] = [];
  for (const folder of shared.folders) {
    const text = JSON.stringify(encodeFolder(folder));
    // Deleted folders first (oldest first), then live ones changed longest ago.
    const drop = folder.deletedAt ? folder.deletedAt : 4e12 + folder.updatedAt;
    entries.push({ kind: 'f', text, bytes: byteLength(text), drop, tie: folder.id });
  }
  for (const kind of shared.kinds) {
    const text = JSON.stringify(encodeKind(kind));
    entries.push({ kind: 'k', text, bytes: byteLength(text), drop: 2e12 + kind.at, tie: kind.host });
  }
  if (entries.length === 0) return null;
  // `{"v":1,"f":[],"k":[]}` plus a comma between entries.
  const budget = limits.quotaBytesPerItem - FOLDERS_KEY.length - 64;
  let total = 20 + entries.reduce((sum, e) => sum + e.bytes + 1, 0);
  const keep = new Set(entries);
  if (total > budget) {
    const dropOrder = [...entries].sort((a, b) => a.drop - b.drop || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));
    for (const entry of dropOrder) {
      if (total <= budget) break;
      keep.delete(entry);
      total -= entry.bytes + 1;
    }
  }
  const kept = entries.filter((e) => keep.has(e));
  const sorted = (kind: 'f' | 'k') =>
    kept
      .filter((e) => e.kind === kind)
      .sort((a, b) => (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0))
      .map((e) => JSON.parse(e.text) as never);
  return { v: 1, f: sorted('f'), k: sorted('k') };
}

// ---------------------------------------------------------------------------------------------
// Folders' notes (`tf.n`, 1.0)

/** The `tf.n` item. */
export interface NoteItem {
  v: 1;
  n: PackedNote[];
}

/** A note is at most this many characters (FOLDER_NOTE_MAX); longer ones from elsewhere are cut. */
const NOTE_MAX = 140;

function cutNote(note: string): string {
  const line = note.replace(/\s+/g, ' ').trim();
  const points = Array.from(line);
  return points.length <= NOTE_MAX ? line : points.slice(0, NOTE_MAX).join('').trim();
}

export function decodeNote(raw: unknown): SyncNote | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const [folderId, note, at] = raw as unknown[];
  if (typeof folderId !== 'string' || !SHORT_ID.test(folderId)) return null;
  if (typeof note !== 'string') return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  return { folderId, note: cutNote(note), noteAt: Math.floor(at) * 1000 };
}

/** What a `tf.n` item holds (one note per folder, the newest); anything malformed is skipped. Null when it isn't one. */
export function decodeNoteItem(raw: unknown): SyncNote[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Partial<NoteItem>;
  if (item.v !== 1) return null;
  const byFolder = new Map<string, SyncNote>();
  for (const entry of Array.isArray(item.n) ? item.n : []) {
    const note = decodeNote(entry);
    if (!note) continue;
    const current = byFolder.get(note.folderId);
    if (!current || note.noteAt > current.noteAt) byFolder.set(note.folderId, note);
  }
  return [...byFolder.values()];
}

/**
 * The `tf.n` item for these notes, within one item's quota (8 KB in Chrome sync): when they don't
 * all fit, the oldest notes are left out first (they stay on the computers that have them). In one
 * canonical order, so the same notes always give the same item. Null when there is none.
 */
export function encodeNoteItem(notes: readonly SyncNote[], limits: SyncLimits = SYNC_LIMITS): NoteItem | null {
  if (notes.length === 0) return null;
  const entries = notes.map((n) => {
    const packed: PackedNote = [n.folderId, n.note, Math.floor(n.noteAt / 1000)];
    const text = JSON.stringify(packed);
    return { note: n, text, bytes: byteLength(text) };
  });
  // `{"v":1,"n":[]}` plus a comma between entries.
  const budget = limits.quotaBytesPerItem - NOTES_KEY.length - 64;
  let total = 14 + entries.reduce((sum, e) => sum + e.bytes + 1, 0);
  const keep = new Set(entries);
  if (total > budget) {
    const oldestFirst = [...entries].sort((a, b) => a.note.noteAt - b.note.noteAt || (a.note.folderId < b.note.folderId ? -1 : 1));
    for (const entry of oldestFirst) {
      if (total <= budget) break;
      keep.delete(entry);
      total -= entry.bytes + 1;
    }
  }
  const kept = entries
    .filter((e) => keep.has(e))
    .sort((a, b) => (a.note.folderId < b.note.folderId ? -1 : a.note.folderId > b.note.folderId ? 1 : 0));
  if (kept.length === 0) return null;
  return { v: 1, n: kept.map((e) => JSON.parse(e.text) as PackedNote) };
}

/** Tombstones younger than 30 days, one per id (the latest), newest first, at most 300 (Chrome sync). */
export function pruneTombstones(tombstones: Tombstone[], now: number, limits: SyncLimits = SYNC_LIMITS): Tombstone[] {
  const byId = new Map<string, Tombstone>();
  for (const tombstone of tombstones) {
    if (tombstone.at < now - limits.tombstoneMaxAgeMs) continue;
    const current = byId.get(tombstone.id);
    if (!current || tombstone.at > current.at) byId.set(tombstone.id, tombstone);
  }
  return [...byId.values()]
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limits.maxTombstones);
}

export interface PackOptions {
  /** Clear floor in milliseconds. */
  floor: number;
  /** Below 1 after Chrome refused a write as too big: use less of the quota. */
  budgetFactor?: number;
  /** Chrome sync's limits unless given. */
  limits?: SyncLimits;
  /** The `tf.f` item (folders and site kinds), already within one item's quota; it takes room from the records. */
  folderItem?: FolderItem | null;
  /** The `tf.n` item (folders' notes, 1.0), already within one item's quota; it takes room from the records too. */
  noteItem?: NoteItem | null;
}

export interface PackResult {
  /** What chrome.storage.sync should hold: every `tf.` key. Empty when there is nothing to share. */
  items: Record<string, unknown>;
  /** The records that fit, newest first. */
  records: SyncRecord[];
  tombstones: Tombstone[];
  /** Content hash of the records and tombstones (also in the meta record); null when there is nothing to share. */
  hash: string | null;
  /** Bytes used, as Chrome counts them. */
  bytes: number;
}

/** Split encoded entries into chunks under the chunk size. */
function chunkEntries(entries: string[], keyFor: (index: number) => string, chunkBytes: number): string[][] {
  const chunks: string[][] = [];
  let size = 0;
  for (const entry of entries) {
    const current = chunks.at(-1);
    const entryBytes = byteLength(entry);
    if (current && size + 1 + entryBytes <= chunkBytes) {
      current.push(entry);
      size += 1 + entryBytes;
    } else {
      chunks.push([entry]);
      size = keyFor(chunks.length - 1).length + 2 + entryBytes;
    }
  }
  return chunks;
}

/**
 * Pack the shared records (already deduplicated, any order) and tombstones into chrome.storage.sync
 * items (or the Tabfold server's, with its limits). Records go newest first while they fit, up to
 * 500 for Chrome sync: one that doesn't fit is skipped and smaller later ones may still go in. The
 * same input always gives the same items, on every computer.
 */
export function pack(candidates: SyncRecord[], tombstoneList: Tombstone[], options: PackOptions): PackResult {
  const limits = options.limits ?? SYNC_LIMITS;
  const factor = Math.min(1, Math.max(0.3, options.budgetFactor ?? 1));
  const tombstones = [...tombstoneList];
  const tombstoneChunks = chunkEntries(
    tombstones.map((t) => JSON.stringify(encodeTombstone(t))),
    tombstoneKey,
    limits.chunkBytes,
  );
  let tombstoneBytes = 0;
  tombstoneChunks.forEach((chunk, i) => (tombstoneBytes += tombstoneKey(i).length + 2 + byteLength(chunk.join(','))));

  const folderItem = options.folderItem ?? null;
  const folderBytes = folderItem ? itemBytes(FOLDERS_KEY, folderItem) : 0;
  const noteItem = options.noteItem ?? null;
  const noteBytes = noteItem ? itemBytes(NOTES_KEY, noteItem) : 0;
  const metaReserve = 160;
  const budget = Math.floor((limits.quotaBytes - limits.reserveBytes) * factor) - metaReserve - tombstoneBytes - folderBytes - noteBytes;
  const maxChunks = limits.maxItems - 1 - tombstoneChunks.length - (folderItem ? 1 : 0) - (noteItem ? 1 : 0);

  const sorted = [...candidates].sort(compareRecords);
  const recordChunks: string[][] = [];
  const included: SyncRecord[] = [];
  let used = 0;
  let chunkSize = 0;
  for (const record of sorted) {
    if (included.length >= limits.maxRecords) break;
    const entry = JSON.stringify(encodeRecord(record));
    const entryBytes = byteLength(entry);
    const current = recordChunks.at(-1);
    if (current && chunkSize + 1 + entryBytes <= limits.chunkBytes && used + 1 + entryBytes <= budget) {
      current.push(entry);
      chunkSize += 1 + entryBytes;
      used += 1 + entryBytes;
      included.push(record);
      continue;
    }
    const opening = recordKey(recordChunks.length).length + 2 + entryBytes;
    if (opening <= limits.chunkBytes && used + opening <= budget && recordChunks.length < maxChunks) {
      recordChunks.push([entry]);
      chunkSize = opening;
      used += opening;
      included.push(record);
    }
    // Otherwise this one doesn't fit; a smaller, older one still may.
  }

  const floorSeconds = Math.floor(Math.max(0, options.floor) / 1000);
  if (included.length === 0 && tombstones.length === 0 && floorSeconds === 0 && !folderItem && !noteItem) {
    return { items: {}, records: [], tombstones: [], hash: null, bytes: 0 };
  }
  const items: Record<string, unknown> = {};
  recordChunks.forEach((chunk, i) => (items[recordKey(i)] = JSON.parse(`[${chunk.join(',')}]`)));
  tombstoneChunks.forEach((chunk, i) => (items[tombstoneKey(i)] = JSON.parse(`[${chunk.join(',')}]`)));
  if (folderItem) items[FOLDERS_KEY] = folderItem;
  if (noteItem) items[NOTES_KEY] = noteItem;
  // The meta hash covers records and tombstones only, as before 0.6, so older versions still read
  // the copy as complete; `copyHash` adds `tf.f` for noticing changes.
  const hash = contentHash(recordChunks.map((c) => c.join(',')), tombstoneChunks.map((c) => c.join(',')), floorSeconds);
  const meta: SyncMeta = { v: 1, n: recordChunks.length, t: tombstoneChunks.length, h: hash, c: floorSeconds };
  items[META_KEY] = meta;
  let bytes = 0;
  for (const [key, value] of Object.entries(items)) bytes += itemBytes(key, value);
  return { items, records: included, tombstones, hash, bytes };
}

function contentHash(recordChunks: string[], tombstoneChunks: string[], floorSeconds: number): string {
  return hash53(`${recordChunks.join('\n')}\u0001${tombstoneChunks.join('\n')}\u0001${floorSeconds}`);
}

/**
 * A fingerprint of the whole shared copy: the meta record's hash, plus `tf.f` and `tf.n` when there
 * are. Equal to the meta hash alone when there are no folders (what 0.5 remembered), and to 0.6's
 * when there are no notes. Null for an empty copy.
 */
export function copyHash(items: Record<string, unknown>): string | null {
  const meta = isMeta(items[META_KEY]) ? (items[META_KEY] as SyncMeta).h : null;
  const folders = items[FOLDERS_KEY];
  const notes = items[NOTES_KEY];
  if (folders === undefined && notes === undefined) return meta;
  const base = folders === undefined ? (meta ?? '') : `${meta ?? ''}.${hash53(JSON.stringify(folders))}`;
  return notes === undefined ? base : `${base}.n${hash53(JSON.stringify(notes))}`;
}

function isMeta(value: unknown): value is SyncMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Partial<SyncMeta>;
  return (
    meta.v === 1 &&
    Number.isInteger(meta.n) &&
    Number.isInteger(meta.t) &&
    typeof meta.h === 'string' &&
    typeof meta.c === 'number' &&
    (meta.n ?? -1) >= 0 &&
    (meta.t ?? -1) >= 0
  );
}

/** Indexes of `tf.c<i>` (or `tf.t<i>`) keys present. */
function chunkIndexes(items: Record<string, unknown>, prefix: string): number[] {
  const out: number[] = [];
  for (const key of Object.keys(items)) {
    if (!key.startsWith(prefix)) continue;
    const index = Number(key.slice(prefix.length));
    if (Number.isInteger(index) && index >= 0 && String(index) === key.slice(prefix.length)) out.push(index);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Read what chrome.storage.sync holds. Anything malformed is skipped. Chunks beyond what the meta
 * record names (left over from a longer list) are ignored. A copy that arrived only in part (Chrome
 * sync delivers keys one by one) is read as far as it goes and marked incomplete. `limits` decide
 * which addresses and how much of each title are read (Chrome sync's unless given).
 */
export function unpack(items: Record<string, unknown>, limits: SyncLimits = SYNC_LIMITS): RemoteState {
  const meta = isMeta(items[META_KEY]) ? (items[META_KEY] as SyncMeta) : null;
  const recordIdx = chunkIndexes(items, 'tf.c').filter((i) => !meta || i < meta.n);
  const tombIdx = chunkIndexes(items, 'tf.t').filter((i) => !meta || i < meta.t);

  const records: SyncRecord[] = [];
  const seen = new Set<string>();
  const recordTexts: string[] = [];
  for (const index of recordIdx) {
    const chunk = items[recordKey(index)];
    if (!Array.isArray(chunk)) continue;
    recordTexts[index] = chunk.map((entry) => JSON.stringify(entry)).join(',');
    for (const entry of chunk) {
      const record = decodeRecord(entry, limits);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
  }
  const tombstones: Tombstone[] = [];
  const tombTexts: string[] = [];
  for (const index of tombIdx) {
    const chunk = items[tombstoneKey(index)];
    if (!Array.isArray(chunk)) continue;
    tombTexts[index] = chunk.map((entry) => JSON.stringify(entry)).join(',');
    for (const entry of chunk) {
      const tombstone = decodeTombstone(entry);
      if (tombstone) tombstones.push(tombstone);
    }
  }

  let complete = false;
  if (meta) {
    const allThere =
      Array.from({ length: meta.n }, (_, i) => i).every((i) => recordTexts[i] !== undefined) &&
      Array.from({ length: meta.t }, (_, i) => i).every((i) => tombTexts[i] !== undefined);
    complete = allThere && contentHash(recordTexts.slice(0, meta.n), tombTexts.slice(0, meta.t), meta.c) === meta.h;
  } else {
    // Nothing shared yet (or only stray chunks, which a writer will tidy up).
    complete = recordIdx.length === 0 && tombIdx.length === 0;
  }
  return {
    records,
    tombstones,
    meta,
    floor: meta ? meta.c * 1000 : 0,
    complete,
    folders: decodeFolderItem(items[FOLDERS_KEY]),
    notes: decodeNoteItem(items[NOTES_KEY]),
    copyHash: copyHash(items),
  };
}

/**
 * The writes that turn `current` (every `tf.` key in chrome.storage.sync) into `next`: keys to set
 * (only those that changed) and keys to remove. Empty when nothing changed, so echoes never write.
 */
export function diffItems(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): { set: Record<string, unknown>; remove: string[] } {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) set[key] = value;
  }
  const remove = Object.keys(current).filter((key) => key.startsWith(SYNC_PREFIX) && !(key in next));
  return { set, remove };
}
