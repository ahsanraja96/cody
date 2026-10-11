import type { TeamDetails } from './pro/types';
import type { FolderRecord, SessionRecord, TabGroupColor, TabRecord } from './types';

/**
 * Teams in the extension (Mx-Share): the small rules every part shares. A team folder is a
 * `FolderRecord` with `teamId`; its tabs live in one fold per team, the team's fold
 * (`deviceId: 'team:<id>'`, named "Team · <name>"), which isn't shown in Recent folds and doesn't
 * count toward the free list. The team's folders and tabs travel through the team's copy on the
 * Tabfold server (src/lib/sync/team.ts), never through Chrome sync or the person's own account.
 * Pure: no database or storage here, so the repo, the worker and the pages can all use it.
 */

export const TEAM_DEVICE_PREFIX = 'team:';

/** The `deviceId` of a team's fold. */
export function teamDeviceId(teamId: string): string {
  return `${TEAM_DEVICE_PREFIX}${teamId}`;
}

/** The fold that holds a team's tabs. */
export function isTeamSession(session: Pick<SessionRecord, 'deviceId'> | null | undefined): boolean {
  return !!session && session.deviceId.startsWith(TEAM_DEVICE_PREFIX);
}

/** Which team a team fold belongs to (null for any other fold). */
export function teamOfSession(session: Pick<SessionRecord, 'deviceId'> | null | undefined): string | null {
  return isTeamSession(session) ? session!.deviceId.slice(TEAM_DEVICE_PREFIX.length) || null : null;
}

/** "Team · Truewidgets": the team fold's name. */
export function teamSessionName(teamName: string): string {
  return `Team · ${teamName}`;
}

export function isTeamFolder(folder: Pick<FolderRecord, 'teamId'> | null | undefined): boolean {
  return !!folder?.teamId;
}

/** The person's own folders (not a team's): the ones Free counts, and the only ones personal sync carries. */
export function personalFolders<T extends Pick<FolderRecord, 'teamId'>>(folders: readonly T[]): T[] {
  return folders.filter((f) => !f.teamId);
}

/** A team's folders, in the order given. */
export function teamFolders<T extends Pick<FolderRecord, 'teamId'>>(folders: readonly T[], teamId?: string | null): T[] {
  return folders.filter((f) => !!f.teamId && (teamId === undefined || teamId === null || f.teamId === teamId));
}

// ---------------------------------------------------------------------------------------------
// People: initials, names and avatar colours from emails (the server knows only emails)

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/** Who added a tab, as records carry it: an email address (trimmed, lower-cased), or null. */
export function cleanAddedBy(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return EMAIL.test(email) && email.length <= 254 ? email : null;
}

function localPart(email: string): string {
  return email.split('@')[0] ?? '';
}

/** "SA" for sara@…, "MK" for mike.k@… or mike-k@…: two letters from the part before the @. */
export function initials(email: string): string {
  const parts = localPart(email)
    .split(/[._+-]+/)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  const letters = parts.length >= 2 ? `${Array.from(parts[0]!)[0]}${Array.from(parts[1]!)[0]}` : Array.from(parts[0] ?? email).slice(0, 2).join('');
  return letters.toUpperCase() || '?';
}

/** "Sara" for sara@truewidgets.com, "Mike" for mike.k@…: what the activity line calls someone. */
export function displayName(email: string): string {
  const first = localPart(email).split(/[._+-]+/).find(Boolean) ?? email;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Avatar colours, in turn (Chrome's tab group colours; the board's first three). */
export const AVATAR_COLORS: readonly TabGroupColor[] = ['blue', 'pink', 'orange', 'green', 'purple', 'cyan', 'yellow', 'red'];

/** Everyone's avatar colour: members in the team's order, then open invitations; anyone else grey. */
export function avatarColors(details: Pick<TeamDetails, 'members' | 'invites'> | null | undefined): Map<string, TabGroupColor> {
  const colors = new Map<string, TabGroupColor>();
  const people = [...(details?.members ?? []).map((m) => m.email), ...(details?.invites ?? []).map((i) => i.email)];
  for (const email of people) {
    const key = email.toLowerCase();
    if (!colors.has(key)) colors.set(key, AVATAR_COLORS[colors.size % AVATAR_COLORS.length]!);
  }
  return colors;
}

// ---------------------------------------------------------------------------------------------
// "Sara added 3 tabs · 2 h ago"

/** Tabs one person added within this long of their newest count as one batch. */
const BATCH_MS = 60 * 60_000;

export interface TeamActivity {
  /** Who added the newest tab. */
  email: string;
  /** How many they added in that go (within an hour of it). */
  tabs: number;
  /** When the newest was added (ms). */
  at: number;
}

/** The newest addition to a team folder, from its tabs' `addedBy` and `savedAt` (when they were added). Null when none says who. */
export function latestActivity(tabs: readonly Pick<TabRecord, 'addedBy' | 'savedAt'>[]): TeamActivity | null {
  let newest: Pick<TabRecord, 'addedBy' | 'savedAt'> | null = null;
  for (const tab of tabs) if (tab.addedBy && (!newest || tab.savedAt > newest.savedAt)) newest = tab;
  if (!newest?.addedBy) return null;
  const email = newest.addedBy;
  const at = newest.savedAt;
  const count = tabs.filter((t) => t.addedBy === email && t.savedAt > at - BATCH_MS && t.savedAt <= at).length;
  return { email, tabs: count, at };
}
