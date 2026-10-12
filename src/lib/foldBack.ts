import { CATEGORIES, KIND_GROUP_COLORS } from './categories';
import type { FolderRecord } from './types';

/** A Chrome tab group, as much as folding back needs (a `chrome.tabGroups.TabGroup` fits). */
export interface GroupLike {
  id: number;
  title?: string;
  /** Its colour, when known: a group titled and coloured like a kind of site is Tidy into groups'. */
  color?: string;
}

/**
 * A group "Tidy into groups" makes (or looks just like one): titled like a kind of site ("Docs")
 * in that kind's colour. It isn't a folder's group, whatever its name.
 */
export function isKindGroup(group: GroupLike): boolean {
  const title = (group.title ?? '').trim();
  return CATEGORIES.some((c) => c.name === title && KIND_GROUP_COLORS[c.id] === group.color);
}

/**
 * The folder a Chrome tab group folds back into (1.0): the folder it was opened from
 * (`groupFolders`, this browser session; a team folder only this way), else one of the person's
 * own live folders with the group's exact name (any case; after a restart group ids change, and
 * Chrome keeps the title). Two folders with that name: the one changed last. Never by name: a team
 * folder (that would share the tabs with the team), a group Tidy into groups made (`tidyGroups`,
 * this browser session), or a group titled and coloured like a kind of site. Null when the group
 * isn't a folder's.
 */
export function folderForGroup(
  group: GroupLike,
  groupFolders: Readonly<Record<string, string>>,
  folders: readonly FolderRecord[],
  tidyGroups: Iterable<number> = [],
): FolderRecord | null {
  const live = folders.filter((f) => !f.deletedAt);
  const linked = groupFolders[String(group.id)];
  if (linked) {
    const folder = live.find((f) => f.id === linked);
    if (folder) return folder;
  }
  const title = (group.title ?? '').trim().toLocaleLowerCase();
  if (!title) return null;
  if (new Set(tidyGroups).has(group.id) || isKindGroup(group)) return null;
  const named = live.filter((f) => !f.teamId && f.name.trim().toLocaleLowerCase() === title);
  if (named.length === 0) return null;
  return named.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
}
