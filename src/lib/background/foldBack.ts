import type { Browser } from 'wxt/browser';
import { modeKey, type CapturePlan, type GroupLike } from '../capture';
import { db } from '../db';
import { folderForGroup } from '../foldBack';
import { listLiveFolders, noteRecentFolders, setTabsFolder, type TabPatch } from '../folders';
import type { FoldOutcome } from '../messages';
import { planState } from '../pro/state';
import { findSavedCopies, type RemovedTabs, type SaveResult } from '../repo';
import { getDeviceId, groupFolders, liveFolders, type LastAction } from '../state';
import { placeTabs } from '../teamFolders';
import { teamOfSession } from '../teams';
import type { FolderRecord, TabRecord } from '../types';

/**
 * Where a fold's tabs go (1.0): "Fold into a folder" (every saved tab into that folder), or, for a
 * tab in a Chrome tab group opened from a folder ("Open all" as a group, `groupFolders`, or after a
 * restart a group with the folder's name), back into that folder. A live folder's group is left to
 * live.ts. A page that was folded already: on "Fold into" its copy moves there too; on fold back
 * only a copy in no folder does. A copy in a team's fold never leaves the team this way. Into a team
 * folder, tabs are shared with the team (new copies in the team's fold, as added by this person).
 */

// ---------------------------------------------------------------------------------------------
// Groups opened from a folder

/** "Open all" from a folder made these groups: folding them puts their tabs back into it. */
export async function rememberGroupFolders(groupIds: number[], folderId: string): Promise<void> {
  if (groupIds.length === 0) return;
  const current = await groupFolders.get();
  const next = { ...current };
  for (const id of groupIds) next[String(id)] = folderId;
  await groupFolders.set(next);
}

/** tabGroups.onRemoved: the group is gone, and so is its link. Cheap when there's none. */
export async function forgetGroupFolder(groupId: number): Promise<void> {
  const current = await groupFolders.get();
  if (!(String(groupId) in current)) return;
  const next = { ...current };
  delete next[String(groupId)];
  await groupFolders.set(next);
}

// ---------------------------------------------------------------------------------------------
// Placing a fold's tabs

/** The copies already in the list of the tabs a fold skipped as duplicates (in the same mode). */
export async function copiesOf(result: SaveResult): Promise<TabRecord[]> {
  if (result.skippedTabs.length === 0) return [];
  const normal = result.skippedTabs.filter((s) => !s.incognito).map((s) => s.tab.url);
  const incognito = result.skippedTabs.filter((s) => s.incognito).map((s) => s.tab.url);
  const found = [
    ...(normal.length ? (await findSavedCopies(normal, undefined, db, false)).values() : []),
    ...(incognito.length ? (await findSavedCopies(incognito, undefined, db, true)).values() : []),
  ];
  return [...new Map(found.map((c) => [c.tab.id, c.tab])).values()];
}


export interface PlaceInput {
  plan: CapturePlan;
  /** The windows (with tabs) as read before saving. */
  windows: Browser.windows.Window[];
  /** Chrome's tab groups as read before saving. */
  groups: Map<number, GroupLike>;
  result: SaveResult;
  /** Copies already in the list of the tabs the fold skipped as duplicates. */
  existingCopies: TabRecord[];
  /** "Fold into": every saved tab goes here (fold back doesn't apply). */
  intoFolderId?: string;
  /** A rule's tabs never go into a team folder, by "Fold into" or folding back (a rule can't share tabs with a team). */
  source?: 'person' | 'rule';
  /** Tabs from a folder's tab group go back into it (unless false). */
  foldBack?: boolean;
  now: number;
}

export interface PlaceOutcome {
  /** Folder changes on copies already folded: Undo puts these back. */
  patches: TabPatch[];
  /** Copies already folded that moved into a team folder (their old rows): Undo puts them back. */
  putBack: RemovedTabs;
  /** New copies in a team's fold: Undo removes them. */
  alsoRemove: string[];
  /** Saved tabs that went on into a team's fold: Undo reopens them from these (their saved rows moved). */
  reopenOnly: NonNullable<LastAction['reopenOnly']>;
  backIntoFolders: NonNullable<FoldOutcome['backIntoFolders']>;
  intoFolder?: NonNullable<FoldOutcome['intoFolder']>;
}

const empty = (): PlaceOutcome => ({ patches: [], putBack: { tabs: [], windows: [] }, alsoRemove: [], reopenOnly: [], backIntoFolders: [] });

interface Bucket {
  folder: FolderRecord;
  saved: string[];
  copies: TabRecord[];
}

/** The folder each tab group folds back into (live folders' groups and untitled ones have none). */
async function groupTargets(groups: Map<number, GroupLike>, folders: FolderRecord[]): Promise<Map<number, FolderRecord>> {
  const targets = new Map<number, FolderRecord>();
  if (groups.size === 0 || folders.length === 0) return targets;
  const [links, live] = await Promise.all([groupFolders.get(), liveFolders.get()]);
  const liveGroups = new Set(Object.values(live).map((l) => l.groupId));
  for (const group of groups.values()) {
    if (liveGroups.has(group.id)) continue;
    const folder = folderForGroup(group, links, folders);
    if (folder) targets.set(group.id, folder);
  }
  return targets;
}

/**
 * Put a fold's tabs in their folders (see the top of this file). Runs after the save is written
 * and before the tabs close. Returns what Undo needs and what the outcome says.
 */
export async function placeFoldedTabs(input: PlaceInput): Promise<PlaceOutcome> {
  const out = empty();
  const { plan, result } = input;
  const captured = plan.windows.flatMap((w) => w.tabs.map((tab) => ({ tab, incognito: w.incognito === true })));
  if (captured.length === 0) return out;

  let into: FolderRecord | null = null;
  let targets = new Map<number, FolderRecord>();
  if (input.intoFolderId) {
    const folder = await db.folders.get(input.intoFolderId);
    // A folder deleted meanwhile: the tabs stay by kind of site.
    if (!folder || folder.deletedAt) return out;
    if (folder.teamId && input.source === 'rule') return out;
    into = folder;
    out.intoFolder = { folderId: folder.id, name: folder.name };
  } else {
    if (input.foldBack === false || !captured.some(({ tab }) => tab.groupName !== null)) return out;
    targets = await groupTargets(input.groups, await listLiveFolders());
    // A rule never shares tabs with a team: a team folder's group folds by kind of site then.
    if (input.source === 'rule') for (const [groupId, target] of targets) if (target.teamId) targets.delete(groupId);
    if (targets.size === 0) return out;
  }

  const groupOf = new Map<number, number>();
  for (const window of input.windows) for (const tab of window.tabs ?? []) if (tab.id !== undefined && tab.groupId !== undefined && tab.groupId >= 0) groupOf.set(tab.id, tab.groupId);
  const copyByKey = new Map(input.existingCopies.map((c) => [modeKey(c.url, c.incognito), c]));
  const sessions = new Map(
    (await db.sessions.bulkGet([...new Set(input.existingCopies.map((c) => c.sessionId))])).filter((s) => !!s).map((s) => [s!.id, s!]),
  );

  const buckets = new Map<string, Bucket>();
  const bucket = (folder: FolderRecord) => {
    let b = buckets.get(folder.id);
    if (!b) buckets.set(folder.id, (b = { folder, saved: [], copies: [] }));
    return b;
  };
  for (const { tab, incognito } of captured) {
    const groupId = tab.sourceTabId !== undefined ? groupOf.get(tab.sourceTabId) : undefined;
    const folder = into ?? (groupId !== undefined ? targets.get(groupId) : undefined);
    if (!folder) continue;
    const savedId = tab.sourceTabId !== undefined ? result.tabIdMap.get(tab.sourceTabId) : undefined;
    if (savedId) {
      bucket(folder).saved.push(savedId);
      continue;
    }
    const copy = copyByKey.get(modeKey(tab.url, incognito));
    if (!copy || copy.folderId === folder.id) continue;
    // Fold back leaves a copy that's in another folder where it is; "Fold into" moves it.
    if (!into && copy.folderId) continue;
    // A team's copy stays with the team (unless it only changes folder within that team).
    const copyTeam = teamOfSession(sessions.get(copy.sessionId));
    if (copyTeam && copyTeam !== (folder.teamId ?? null)) continue;
    if (!bucket(folder).copies.some((c) => c.id === copy.id)) bucket(folder).copies.push(copy);
  }

  const windowSources = result.windowSources;
  const used: string[] = [];
  for (const { folder, saved, copies } of buckets.values()) {
    let count = 0;
    if (!folder.teamId) {
      if (saved.length) count += (await setTabsFolder(saved, folder.id, { now: input.now })).found;
      if (copies.length) {
        const moved = await setTabsFolder(copies.map((c) => c.id), folder.id, { now: input.now });
        out.patches.push(...moved.before);
        count += moved.moved;
      }
    } else {
      const plan = await planState.get();
      // Not in that team (any more): the tabs stay by kind of site.
      if (!plan.email || plan.team?.id !== folder.teamId) continue;
      const context = { email: plan.email, teamName: plan.team.name, deviceId: await getDeviceId(), now: input.now };
      if (saved.length) {
        const rows = (await db.tabs.bulkGet(saved)).filter((t): t is TabRecord => !!t);
        const placed = await placeTabs(saved, folder, context);
        out.alsoRemove.push(...placed.newIds);
        const gone = new Set((await db.tabs.bulkGet(saved)).map((t, i) => (t ? null : saved[i])).filter((id): id is string => !!id));
        for (const row of rows) {
          if (!gone.has(row.id)) continue;
          out.reopenOnly.push({
            url: row.url,
            title: row.title,
            pinned: row.pinned,
            sourceWindowId: windowSources.get(row.windowId),
            ...(row.incognito ? { incognito: true as const } : {}),
          });
        }
        count += placed.moved;
      }
      if (copies.length) {
        const placed = await placeTabs(copies.map((c) => c.id), folder, context);
        out.patches.push(...placed.before);
        out.putBack.tabs.push(...placed.putBack.tabs);
        out.putBack.windows.push(...placed.putBack.windows);
        out.alsoRemove.push(...placed.newIds);
        count += placed.moved;
      }
    }
    if (count > 0 || into) used.push(folder.id);
    if (!into && count > 0) out.backIntoFolders.push({ folderId: folder.id, name: folder.name, tabs: count });
  }
  await noteRecentFolders(used, input.now);
  return out;
}
