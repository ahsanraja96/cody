import type { FolderRecord } from './types';

/**
 * Starred folders and "Fold into" order (1.0), for the worker and the pages alike (pure; no React,
 * no storage). `src/ui/hooks.ts` re-exports it for the screens, so both use the same order.
 */

/** Is this folder starred for this person: a personal folder's `starredAt`, or a team folder's own star? */
export function folderStarred(folder: Pick<FolderRecord, 'id' | 'teamId' | 'starredAt'>, teamStars: Readonly<Record<string, number>>): boolean {
  return folder.teamId ? (teamStars[folder.id] ?? 0) > 0 : (folder.starredAt ?? 0) > 0;
}

/**
 * The folders "Fold into" offers, in order: starred first, then used lately (newest first), then
 * the rest by their order. Personal and team folders alike (a team folder shares what goes in).
 */
export function foldIntoOrder(
  folders: readonly FolderRecord[],
  teamStars: Readonly<Record<string, number>>,
  recent: Readonly<Record<string, number>>,
): FolderRecord[] {
  const live = folders.filter((f) => !f.deletedAt);
  return [...live].sort(
    (a, b) =>
      Number(folderStarred(b, teamStars)) - Number(folderStarred(a, teamStars)) ||
      (recent[b.id] ?? 0) - (recent[a.id] ?? 0) ||
      a.order - b.order ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
