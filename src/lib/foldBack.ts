import type { FolderRecord } from './types';

/** A Chrome tab group, as much as folding back needs (a `chrome.tabGroups.TabGroup` fits). */
export interface GroupLike {
  id: number;
  title?: string;
}

/**
 * The folder a Chrome tab group folds back into (1.0): the folder it was opened from
 * (`groupFolders`, this browser session), else a live folder with the group's exact name (any case;
 * after a restart group ids change, and Chrome keeps the title). Two folders with that name: the one
 * changed last. Null when the group isn't a folder's.
 */
export function folderForGroup(
  group: GroupLike,
  groupFolders: Readonly<Record<string, string>>,
  folders: readonly FolderRecord[],
): FolderRecord | null {
  const live = folders.filter((f) => !f.deletedAt);
  const linked = groupFolders[String(group.id)];
  if (linked) {
    const folder = live.find((f) => f.id === linked);
    if (folder) return folder;
  }
  const title = (group.title ?? '').trim().toLocaleLowerCase();
  if (!title) return null;
  const named = live.filter((f) => f.name.trim().toLocaleLowerCase() === title);
  if (named.length === 0) return null;
  return named.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
}
