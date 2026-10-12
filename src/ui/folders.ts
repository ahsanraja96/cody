import { categorize, category, groupByCategory, type CategoryId, type SiteKinds } from '@/lib/categories';
import { TAB_GROUP_COLORS, type FolderRecord, type TabGroupColor, type TabRecord } from '@/lib/types';

/**
 * How the pages put folded tabs together in 0.6 (Fo-* boards): snoozed tabs on their own, then the
 * person's folders in their order, then every other tab by kind of site (with the sites they
 * moved). Pure functions, shared by the full list, the popup and the Ctrl+K palette.
 */

/** The colour swatches in a folder's menu, in Chrome's order. */
export const FOLDER_COLORS: readonly TabGroupColor[] = TAB_GROUP_COLORS;

/** Colours handed to new folders, most distinct first; grey only when every other is taken. */
const NEW_FOLDER_ORDER: TabGroupColor[] = ['purple', 'green', 'cyan', 'blue', 'orange', 'pink', 'yellow', 'red', 'grey'];

export function nextFolderColor(folders: readonly Pick<FolderRecord, 'color'>[]): TabGroupColor {
  const used = new Set(folders.map((f) => f.color));
  return NEW_FOLDER_ORDER.find((c) => !used.has(c)) ?? NEW_FOLDER_ORDER[folders.length % NEW_FOLDER_ORDER.length]!;
}

/** Folder names: trimmed, at most 60 characters (FolderRecord). */
export const FOLDER_NAME_MAX = 60;

export function cleanFolderName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX);
}

/** A snoozed tab waits in "Snoozed" until its time (it may be overdue on another computer). */
export function isSnoozed(tab: Pick<TabRecord, 'snoozeUntil'>): boolean {
  return typeof tab.snoozeUntil === 'number' && tab.snoozeUntil > 0;
}

export interface TabGroup {
  /** `folder:<id>` or `site:<kind>`. */
  id: string;
  kind: 'folder' | 'site';
  name: string;
  color: TabGroupColor;
  /** Newest first. */
  items: TabRecord[];
  folder?: FolderRecord;
  categoryId?: CategoryId;
}

export interface GroupedTabs {
  /** Soonest first. */
  snoozed: TabRecord[];
  /** Every live folder in its order, empty ones too. */
  folders: TabGroup[];
  /** Tabs in no (live) folder, by kind of site, groups with the newest tabs first. */
  sites: TabGroup[];
}

const newestFirst = (a: TabRecord, b: TabRecord) => b.savedAt - a.savedAt || a.order - b.order;

export function groupTabs(tabs: readonly TabRecord[], folders: readonly FolderRecord[], siteKinds: SiteKinds = {}): GroupedTabs {
  const snoozed: TabRecord[] = [];
  const byFolder = new Map<string, TabRecord[]>(folders.map((f) => [f.id, []]));
  const loose: TabRecord[] = [];
  for (const tab of tabs) {
    if (isSnoozed(tab)) snoozed.push(tab);
    else if (tab.folderId && byFolder.has(tab.folderId)) byFolder.get(tab.folderId)!.push(tab);
    else loose.push(tab);
  }
  snoozed.sort((a, b) => (a.snoozeUntil ?? 0) - (b.snoozeUntil ?? 0));
  return {
    snoozed,
    folders: folders.map((folder) => ({
      id: `folder:${folder.id}`,
      kind: 'folder',
      name: folder.name,
      color: folder.color,
      items: byFolder.get(folder.id)!.sort(newestFirst),
      folder,
    })),
    sites: groupByCategory(loose, (t) => t.url, (t) => t.savedAt, siteKinds).map((g) => ({
      id: `site:${g.category.id}`,
      kind: 'site',
      name: g.category.name,
      color: g.category.color,
      items: g.items,
      categoryId: g.category.id,
    })),
  };
}

/** The kind of site a tab shows under (its site's move wins over the built-in list). */
export function kindOf(tab: Pick<TabRecord, 'url'>, siteKinds: SiteKinds = {}): CategoryId {
  return categorize(tab.url, siteKinds);
}

export function kindName(kind: CategoryId): string {
  return category(kind).name;
}

/**
 * Starred folders first (1.0), each part in the folders' own order. `teamStars`: team folders this
 * person starred (a personal folder carries `starredAt`).
 */
export function starredFirst<T extends Pick<FolderRecord, 'id' | 'teamId' | 'starredAt'>>(
  folders: readonly T[],
  teamStars: Readonly<Record<string, number>>,
): T[] {
  const starred = (f: T) => (f.teamId ? !!teamStars[f.id] : !!f.starredAt);
  return [...folders.filter(starred), ...folders.filter((f) => !starred(f))];
}

/** Tabs in each folder (snoozed ones wait in Snoozed), by folder id. */
export function folderCounts(tabs: readonly TabRecord[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tabs ?? []) if (t.folderId && !isSnoozed(t)) map.set(t.folderId, (map.get(t.folderId) ?? 0) + 1);
  return map;
}
