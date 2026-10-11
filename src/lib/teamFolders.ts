import { resetDataGuard } from './dataGuard';
import { bumpSearchVersion, db, type TabfoldDB } from './db';
import { patchOf, quietPlacement, setTabsFolder, type TabPatch } from './folders';
import { newId } from './format';
import { findOrCreatePersonalSession, findOrCreateTeamSession, settleSessions, type RemovedTabs } from './repo';
import { hash53, syncId } from './sync/records';
import { isTeamSession, teamDeviceId, teamOfSession } from './teams';
import type { FolderRecord, SessionRecord, TabRecord, WindowRecord } from './types';

/**
 * Moving tabs in and out of team folders, and what happens to a team's folders on this computer
 * when the person is no longer in the team. Works on any database (tests use one per computer).
 *
 * A tab moved into a team folder leaves the person's own list for the team's fold: it is shared
 * with everyone in the team, as added now by this person. One moved out of a team folder becomes
 * the person's own again ("From <team>" fold), as folded now. Either way it gets a new id, so the
 * person's own sync and the team's never share an id (each removes its old copy as a removal).
 */

/** Who is moving tabs, for the team's records. */
export interface TeamMoveContext {
  /** The signed-in email: who added a tab to the team. */
  email: string;
  /** This computer's device id: tabs taken out of a team land in a fold of its own. */
  deviceId: string;
  /** The team's name now ("From Truewidgets"). */
  teamName: string;
  now?: number;
}

export interface TeamMove {
  /** Tabs moved (shared, made personal again, or moved between the team's folders). */
  moved: number;
  /** Folder changes Undo puts back (moves that stayed on the same side). */
  before: TabPatch[];
  /** Tabs as they were before moving sides: Undo puts them back. */
  putBack: RemovedTabs;
  /** The new copies made on the other side: Undo removes them. */
  newIds: string[];
  /** Folded from Incognito: these stay on this computer and never go to a team. */
  skippedIncognito: number;
}

const TABLES = (database: TabfoldDB) => [database.sessions, database.windows, database.tabs, database.meta, database.folders];

/** The live folds these rows are in, by id. */
async function liveSessionsOf(rows: TabRecord[], database: TabfoldDB): Promise<Map<string, SessionRecord>> {
  const sessions = await database.sessions.bulkGet([...new Set(rows.map((r) => r.sessionId))]);
  return new Map(sessions.filter((s): s is SessionRecord => !!s && !s.deletedAt).map((s) => [s.id, s]));
}

/** A row with its folder and snooze, and the fields only one side keeps, cleared. */
function bare(row: TabRecord): TabRecord {
  const { folderId: _f, snoozeUntil: _s, snoozedOn: _o, placedAt: _p, addedBy: _a, lastOpenedAt: _l, ...rest } = row;
  return rest;
}

/**
 * Put tabs in a folder (a team's or the person's own), or out of their folder (`null`). Tabs that
 * change sides move between the person's folds and the team's fold with new ids; the rest only
 * change folder. Returns what Undo needs.
 */
export async function placeTabs(
  tabIds: string[],
  folder: FolderRecord | null,
  context: TeamMoveContext,
  database: TabfoldDB = db,
): Promise<TeamMove> {
  const now = context.now ?? Date.now();
  const rows = (await database.tabs.bulkGet([...new Set(tabIds)])).filter((t): t is TabRecord => !!t);
  const sessions = await liveSessionsOf(rows, database);
  const live = rows.filter((r) => sessions.has(r.sessionId));
  const teamOf = (row: TabRecord) => teamOfSession(sessions.get(row.sessionId));
  const target = folder?.teamId ?? null;

  // Same side: only the folder changes (in the team's fold, or in the person's own folds).
  const stay = live.filter((r) => teamOf(r) === target);
  const cross = live.filter((r) => teamOf(r) !== target);
  const moves = stay.length ? await setTabsFolder(stay.map((r) => r.id), folder?.id ?? null, { now }, database) : { moved: 0, before: [] };
  const result: TeamMove = { moved: moves.moved, before: moves.before, putBack: { tabs: [], windows: [] }, newIds: [], skippedIncognito: 0 };
  if (cross.length === 0) return result;

  const sharing = cross.filter((r) => !(target && r.incognito));
  result.skippedIncognito = cross.length - sharing.length;
  if (sharing.length === 0) return result;
  const windows = (await database.windows.bulkGet([...new Set(sharing.map((r) => r.windowId))])).filter((w): w is WindowRecord => !!w);

  await database.transaction('rw', TABLES(database), async () => {
    // The new copies carry their own placement time.
    quietPlacement();
    const dest = target
      ? await findOrCreateTeamSession(database, { id: target, name: context.teamName }, now)
      : await findOrCreatePersonalSession(database, `From ${context.teamName}`, context.deviceId, now);
    let order = dest.nextOrder;
    const copies: TabRecord[] = sharing.map((row) => ({
      ...bare(row),
      id: newId(),
      sessionId: dest.session.id,
      windowId: dest.windowId,
      order: order++,
      // Added to the team (or folded again) now: it sorts as new, and an older removal never matches it.
      savedAt: now,
      placedAt: now,
      ...(folder ? { folderId: folder.id } : {}),
      ...(target ? { addedBy: context.email } : {}),
    }));
    await database.tabs.bulkDelete(sharing.map((r) => r.id));
    await database.tabs.bulkAdd(copies);
    await settleSessions([...sharing.map((r) => r.sessionId), dest.session.id], database, now);
    await bumpSearchVersion(database);
    result.newIds = copies.map((c) => c.id);
  });
  result.putBack = { tabs: sharing, windows };
  result.moved += sharing.length;
  return result;
}

/** A team folder's tabs (in the team's live fold). */
export async function teamFolderTabs(folder: FolderRecord, database: TabfoldDB = db): Promise<TabRecord[]> {
  const rows = await database.tabs.where('folderId').equals(folder.id).toArray();
  const sessions = await liveSessionsOf(rows, database);
  return rows.filter((r) => isTeamSession(sessions.get(r.sessionId)));
}

// ---------------------------------------------------------------------------------------------
// No longer in the team

/** The team's folds on this computer, live or not. */
async function teamSessions(teamId: string, database: TabfoldDB): Promise<SessionRecord[]> {
  const deviceId = teamDeviceId(teamId);
  return database.sessions.filter((s) => s.deviceId === deviceId).toArray();
}

/** Teams this computer has folders or tabs from (live ones), with the name the team's fold has. */
export async function localTeams(database: TabfoldDB = db): Promise<Map<string, { name: string }>> {
  const teams = new Map<string, { name: string }>();
  for (const folder of await database.folders.where('deletedAt').equals(0).toArray()) {
    if (folder.teamId && !teams.has(folder.teamId)) teams.set(folder.teamId, { name: '' });
  }
  for (const session of await database.sessions.where('deletedAt').equals(0).toArray()) {
    const team = teamOfSession(session);
    if (team) teams.set(team, { name: session.name.replace(/^Team · /, '') });
  }
  return teams;
}

/**
 * Take a team's folders and tabs out of the list on this computer (the person left, was removed,
 * or the team's plan ended): its fold goes to Trash and its folders are marked deleted, as of `now`,
 * until the person keeps a copy or lets them go. Nothing is shared: the team's copy isn't synced
 * any more. Returns how many folders and tabs went.
 */
export async function takeTeamOut(teamId: string, now = Date.now(), database: TabfoldDB = db): Promise<{ folders: number; tabs: number }> {
  return database.transaction('rw', TABLES(database), async () => {
    const folders = (await database.folders.where('deletedAt').equals(0).toArray()).filter((f) => f.teamId === teamId);
    if (folders.length) await database.folders.bulkPut(folders.map((f) => ({ ...f, deletedAt: now, updatedAt: now })));
    let tabs = 0;
    for (const session of await teamSessions(teamId, database)) {
      if (session.deletedAt) continue;
      tabs += await database.tabs.where('sessionId').equals(session.id).count();
      await database.sessions.put({ ...session, deletedAt: now });
    }
    if (folders.length || tabs) await bumpSearchVersion(database);
    return { folders: folders.length, tabs };
  });
}

/** The id a team folder's personal copy gets: the same on every computer of the person's. */
export function copyFolderId(teamId: string, folderId: string): string {
  return hash53(`team-copy:${teamId}:${folderId}`).padStart(12, '0').slice(-12);
}

/** The id a team tab's personal copy gets: the same on every computer of the person's. */
export function copyTabId(teamId: string, tabId: string): string {
  return hash53(`team-copy:${teamId}:${syncId(tabId)}`).padStart(12, '0').slice(-12);
}

/**
 * "Keep a copy": the team's folders taken out at `since` become the person's own folders (after
 * theirs), with their tabs in a fold of their own ("From <team>"), as folded now; then the team's
 * rows go. Free limits don't stop it: nothing anyone had is taken away.
 */
export async function keepTeamCopy(
  teamId: string,
  options: { name: string; deviceId: string; since: number; now?: number },
  database: TabfoldDB = db,
): Promise<{ folders: number; tabs: number }> {
  const now = options.now ?? Date.now();
  const result = await database.transaction('rw', TABLES(database), async () => {
    quietPlacement();
    const all = await database.folders.toArray();
    const taken = all.filter((f) => f.teamId === teamId && (f.deletedAt === 0 || f.deletedAt >= options.since)).sort((a, b) => a.order - b.order);
    let order = all.filter((f) => !f.teamId && !f.deletedAt).reduce((max, f) => Math.max(max, f.order + 1), 0);
    const ids = new Map<string, string>();
    const copies: FolderRecord[] = taken.map((folder) => {
      const id = copyFolderId(teamId, folder.id);
      ids.set(folder.id, id);
      const { teamId: _team, shareId: _share, shareLive: _live, ...rest } = folder;
      return { ...rest, id, order: order++, createdAt: now, updatedAt: now, deletedAt: 0 };
    });
    if (copies.length) await database.folders.bulkPut(copies);

    const sessions = (await teamSessions(teamId, database)).filter((s) => s.deletedAt === 0 || s.deletedAt >= options.since);
    const rows = sessions.length ? await database.tabs.where('sessionId').anyOf(sessions.map((s) => s.id)).toArray() : [];
    if (rows.length) {
      const dest = await findOrCreatePersonalSession(database, `From ${options.name}`, options.deviceId, now);
      let next = dest.nextOrder;
      const tabs: TabRecord[] = rows
        .sort((a, b) => a.order - b.order)
        .map((row) => {
          const folderId = row.folderId ? ids.get(row.folderId) : undefined;
          return {
            ...bare(row),
            id: copyTabId(teamId, row.id),
            sessionId: dest.session.id,
            windowId: dest.windowId,
            order: next++,
            savedAt: now,
            placedAt: now,
            ...(folderId ? { folderId } : {}),
          };
        });
      await database.tabs.bulkPut(tabs);
      await settleSessions([dest.session.id], database, now);
    }
    return { folders: copies.length, tabs: rows.length };
  });
  await purgeTeam(teamId, database);
  return result;
}

/**
 * A team's folders, fold and tabs leave this computer for good. Tabfold deleted them itself, so the
 * wipe guard follows (a list that held only the team's fold mustn't look erased from outside).
 */
export async function purgeTeam(teamId: string, database: TabfoldDB = db): Promise<void> {
  const purged = await database.transaction('rw', TABLES(database), async () => {
    const sessions = await teamSessions(teamId, database);
    const ids = sessions.map((s) => s.id);
    if (ids.length) {
      await database.tabs.where('sessionId').anyOf(ids).delete();
      await database.windows.where('sessionId').anyOf(ids).delete();
      await database.sessions.bulkDelete(ids);
    }
    const folders = (await database.folders.toArray()).filter((f) => f.teamId === teamId).map((f) => f.id);
    if (folders.length) await database.folders.bulkDelete(folders);
    if (ids.length || folders.length) await bumpSearchVersion(database);
    return ids.length > 0;
  });
  if (purged) await resetDataGuard(database).catch(() => undefined);
}

/** For Undo of a team folder's deletion: what its tabs were. */
export function patchesOf(rows: TabRecord[]): TabPatch[] {
  return rows.map(patchOf);
}
