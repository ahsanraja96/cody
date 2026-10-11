import { CATEGORIES, siteKey, type CategoryId } from '../categories';
import { bumpSearchVersion, db } from '../db';
import {
  addFolder,
  cleanFolderName,
  duplicateGroups,
  freeLimitsNow,
  hostIsSite,
  installPlacementStamp,
  isFolderColor,
  listLiveFolders,
  listRoom,
  migrateProjectsToFolders,
  patchOf,
  placed,
  purgeDeletedFolders,
  requireFolder,
  setSiteKind,
  setTabsFolder,
} from '../folders';
import { CommandError, type Command, type CommandResults, type DuplicateGroup, type RoomList } from '../messages';
import type { FolderRecord, TabGroupColor } from '../types';
import { listFoldedTabs, listLiveSessions, removeDuplicateCopies, removeTabsWithSnapshot } from '../repo';
import { recordChangeUndo } from './save';
import { setupTidy } from './tidy';

/**
 * Undo for a list change: the `undo` command puts it back (src/lib/background/save.ts). A removal
 * too big to keep for Undo still happens; it just can't be undone (null).
 */
export async function undoable(change: Parameters<typeof recordChangeUndo>[0]): Promise<string | null> {
  try {
    return await recordChangeUndo(change);
  } catch (error) {
    console.warn('[tabfold] could not keep Undo', (error as Error)?.message ?? error);
    return null;
  }
}

/**
 * Folders, kinds of site, the free list's limit ("Make room") and duplicates (Fo-* and Up-* boards,
 * Mx-Ask "Same page twice"). Changes that can be undone return an `actionId` for the `undo` command.
 */
export type FolderCommand = Extract<
  Command,
  {
    type:
      | 'folder-create'
      | 'folder-update'
      | 'folder-reorder'
      | 'folder-delete'
      | 'tabs-move'
      | 'site-kind-set'
      | 'room-list'
      | 'room-free'
      | 'duplicates-list'
      | 'duplicates-remove';
  }
>;

export async function handleFolderCommand(command: FolderCommand): Promise<CommandResults[FolderCommand['type']]> {
  switch (command.type) {
    case 'folder-create':
      return createFolder(command.name, command.color, command.tabRecordIds);
    case 'folder-update':
      return updateFolder(command.id, { name: command.name, color: command.color });
    case 'folder-reorder':
      return reorderFolders(command.ids);
    case 'folder-delete':
      return deleteFolder(command.id);
    case 'tabs-move':
      return moveTabs(command.tabRecordIds, command.folderId);
    case 'site-kind-set':
      return moveSite(command.host, command.kind);
    case 'room-list':
      return roomList();
    case 'room-free':
      return freeRoom(command.sessionIds, command.olderThanDays);
    case 'duplicates-list':
      return listDuplicates();
    case 'duplicates-remove':
      return removeDuplicates(command.urls);
  }
}

// ---------------------------------------------------------------------------------------------
// Folders

/** A new folder, last in the left column; with tabs, they move into it. Free: 3 live folders. */
export async function createFolder(name: string, color?: TabGroupColor, tabRecordIds?: string[]): Promise<{ folder: FolderRecord }> {
  const unlimited = !(await freeLimitsNow());
  const folder = await addFolder({ name, color, source: 'person' }, { unlimited });
  if (tabRecordIds?.length) await setTabsFolder(tabRecordIds, folder.id);
  return { folder };
}

/** Rename or recolour. */
export async function updateFolder(id: string, patch: { name?: string; color?: TabGroupColor }): Promise<{ folder: FolderRecord }> {
  return db.transaction('rw', [db.folders, db.meta], async () => {
    const folder = await requireFolder(id);
    const next: FolderRecord = { ...folder };
    if (patch.name !== undefined) {
      const name = cleanFolderName(patch.name);
      if (!name) throw new CommandError('Give the folder a name.', 'invalid-name');
      next.name = name;
    }
    if (patch.color !== undefined) {
      if (!isFolderColor(patch.color)) throw new CommandError('That isn’t one of the colours.', 'invalid-color');
      next.color = patch.color;
    }
    if (next.name === folder.name && next.color === folder.color) return { folder };
    next.updatedAt = Date.now();
    await db.folders.put(next);
    // Names show in search results ("in Truewidgets").
    await bumpSearchVersion();
    return { folder: next };
  });
}

/** The left column's order, top first. Folders not listed keep their order, after the listed ones. */
export async function reorderFolders(ids: string[]): Promise<{ ok: true }> {
  const now = Date.now();
  await db.transaction('rw', [db.folders], async () => {
    const live = await listLiveFolders();
    const position = new Map<string, number>();
    for (const id of ids) if (!position.has(id)) position.set(id, position.size);
    const listed = live.filter((f) => position.has(f.id)).sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    const rest = live.filter((f) => !position.has(f.id));
    const changed = [...listed, ...rest]
      .map((folder, order) => ({ folder, order }))
      .filter(({ folder, order }) => folder.order !== order)
      .map(({ folder, order }) => ({ ...folder, order, updatedAt: now }));
    if (changed.length) await db.folders.bulkPut(changed);
  });
  return { ok: true };
}

/** Delete a folder: its tabs go back to their kind of site. Undo brings it back with its tabs. */
export async function deleteFolder(id: string): Promise<{ tabs: number; actionId: string | null }> {
  const now = Date.now();
  const { folder, inside } = await db.transaction('rw', [db.folders, db.tabs, db.meta], async () => {
    const folder = await requireFolder(id);
    const inside = await db.tabs.where('folderId').equals(id).toArray();
    if (inside.length) await db.tabs.bulkPut(inside.map((t) => placed(t, null, now)));
    await db.folders.put({ ...folder, deletedAt: now, updatedAt: now });
    await bumpSearchVersion();
    return { folder, inside };
  });
  const live = new Set((await listLiveSessions()).map((s) => s.id));
  const actionId = await undoable({ folders: [folder], patches: inside.map(patchOf), now });
  return { tabs: inside.filter((t) => live.has(t.sessionId)).length, actionId };
}

/** Move tabs into a folder, or out of theirs (`null`). */
export async function moveTabs(tabRecordIds: string[], folderId: string | null): Promise<{ moved: number; actionId: string | null }> {
  if (folderId !== null) await requireFolder(folderId);
  const { moved, before } = await setTabsFolder(tabRecordIds, folderId);
  return { moved, actionId: moved ? await undoable({ patches: before }) : null };
}

// ---------------------------------------------------------------------------------------------
// Kinds of site

const KINDS = new Set<string>(CATEGORIES.map((c) => c.id));

/**
 * Move a site to another kind, remembered for its new tabs too (`kind: null` puts it back).
 * `tabs`: how many folded tabs that site has.
 */
export async function moveSite(host: string, kind: CategoryId | null): Promise<{ tabs: number; actionId: string | null }> {
  if (kind !== null && !KINDS.has(kind)) throw new CommandError('That isn’t a kind of site.', 'invalid-kind');
  const change = await setSiteKind(host, kind);
  const tabs = (await listFoldedTabs()).filter((t) => hostIsSite(siteKey(t.url), change.host)).length;
  if (!change.changed) return { tabs, actionId: null };
  return { tabs, actionId: await undoable({ siteKind: { host: change.host, before: change.before } }) };
}

// ---------------------------------------------------------------------------------------------
// Make room (the free list holds 500 tabs)

const DAY = 24 * 60 * 60 * 1000;
/** "Everything folded more than 2 months ago". */
export const ROOM_OLDER_THAN_DAYS = 60;

/** Oldest folds first (at most 50), and how many tabs were folded more than 60 days ago. */
export async function roomList(now = Date.now()): Promise<RoomList> {
  const [sessions, room, tabs] = await Promise.all([listLiveSessions(), listRoom(), listFoldedTabs()]);
  const folds = sessions
    .filter((s) => s.tabCount > 0)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .slice(0, 50)
    .map((s) => ({ sessionId: s.id, name: s.smartName || s.name, createdAt: s.createdAt, tabCount: s.tabCount, windowCount: s.windowCount }));
  const cutoff = now - ROOM_OLDER_THAN_DAYS * DAY;
  // Snoozed tabs are waiting to come back: "older than" never removes them.
  const old = tabs.filter((t) => t.savedAt < cutoff && !t.snoozeUntil).length;
  return { tabs: room.tabs, limit: room.limit, folds, olderThan: { days: ROOM_OLDER_THAN_DAYS, tabs: old } };
}

/**
 * Remove these folds, and/or every tab folded more than `olderThanDays` days ago (tabs in folders
 * too; snoozed ones stay). Removed like any removal, so Chrome sync removes them elsewhere too.
 */
export async function freeRoom(sessionIds?: string[], olderThanDays?: number, now = Date.now()): Promise<{ removed: number; actionId: string | null }> {
  const ids = new Set<string>();
  if (sessionIds?.length) {
    const live = new Set((await listLiveSessions()).map((s) => s.id));
    const wanted = sessionIds.filter((id) => live.has(id));
    if (wanted.length) for (const id of await db.tabs.where('sessionId').anyOf(wanted).primaryKeys()) ids.add(id as string);
  }
  if (typeof olderThanDays === 'number' && Number.isFinite(olderThanDays) && olderThanDays >= 0) {
    const cutoff = now - olderThanDays * DAY;
    for (const tab of await listFoldedTabs()) if (tab.savedAt < cutoff && !tab.snoozeUntil) ids.add(tab.id);
  }
  if (ids.size === 0) return { removed: 0, actionId: null };
  const removed = await removeTabsWithSnapshot([...ids]);
  return { removed: removed.tabs.length, actionId: removed.tabs.length ? await undoable({ putBack: removed }) : null };
}

// ---------------------------------------------------------------------------------------------
// Same page twice

/** Pages folded more than once, newest first; in each, the newest copy first (the one that stays). */
export async function listDuplicates(): Promise<{ groups: DuplicateGroup[] }> {
  const groups = duplicateGroups(await listFoldedTabs()).map((tabs) => ({
    url: tabs[0]!.url,
    title: tabs[0]!.title,
    tabRecordIds: tabs.map((t) => t.id),
  }));
  return { groups };
}

/** Remove the extra copies (the newest stays, with its folder), all or only these pages'. */
export async function removeDuplicates(urls?: string[]): Promise<{ removed: number; actionId: string | null }> {
  const { removed, placements } = await removeDuplicateCopies(urls);
  if (removed.tabs.length === 0) return { removed: 0, actionId: null };
  return { removed: removed.tabs.length, actionId: await undoable({ putBack: removed, patches: placements }) };
}

// ---------------------------------------------------------------------------------------------
// Worker start

function safely(label: string, task: () => Promise<unknown>): void {
  task().catch((error) => console.error(`[tabfold] ${label} failed`, error));
}

/**
 * Called once at the worker's top level (src/lib/background/index.ts): the placement stamp on tab
 * writes, the weekly tidy-up's alarm, moving old AI projects into folders (once), and dropping
 * folders deleted more than 30 days ago.
 */
export function setupFolders(): void {
  installPlacementStamp(db);
  setupTidy();
  safely('folders migration', () => migrateProjectsToFolders());
  safely('deleted folders', () => purgeDeletedFolders());
}
