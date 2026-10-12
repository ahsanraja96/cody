import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, X } from 'lucide-react';
import type { Category, SiteKinds } from '@/lib/categories';
import { putBackTabs, removeTabsWithSnapshot, type RemovedTabs } from '@/lib/repo';
import type { FolderRecord, TabGroupColor, TabRecord } from '@/lib/types';
import { groupTabs } from '../folders';
import { FolderIcon } from './FolderIcon';
import { displayHost } from '@/lib/urls';
import { IncognitoMark } from './IncognitoMark';
import { cx } from '../cx';
import { Favicon } from './Favicon';
import { StarMark } from './Star';
import './FoldedList.css';

/**
 * The folded list (Min-Popup, Fo-Popup): the person's folders first (folder icon, name, count),
 * then the other tabs by kind of site (colour dot). Group rows have a favicon strip when collapsed
 * and "Open all" on hover or focus; rows open the tab (it stays in the list) and × removes it at
 * once, leaving an Undo line in its place for 10 seconds. Kinds are ordered by their newest tab,
 * newest first inside each group. Snoozed tabs wait in the full list.
 */

export const REMOVE_UNDO_MS = 10_000;
/** Rows shown in an expanded group before "Show N more". */
const FIRST_ROWS = 3;
/** "Show N more" reveals at most this many rows at a time, so huge groups stay fast. */
const MORE_ROWS = 100;

export function tabTitle(tab: Pick<TabRecord, 'title' | 'url'>): string {
  return tab.title.trim() || displayHost(tab.url) || tab.url;
}

export function siteName(url: string): string {
  return displayHost(url).replace(/^www\./, '');
}

/** Compact age for list rows: "now", "12m", "3h", "2d", "3w", "5mo", "2y". */
export function shortAgo(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 35) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function CategoryDot({ category, size = 10 }: { category: Category; size?: number }) {
  return <span aria-hidden="true" className={cx('tf-cg-dot', `tf-cg-${category.color}`)} style={{ width: size, height: size }} />;
}

/** Up to three favicons of different sites from a group, newest first. */
export function FaviconStrip({ tabs, size = 14, max = 3 }: { tabs: TabRecord[]; size?: number; max?: number }) {
  const picked: TabRecord[] = [];
  const hosts = new Set<string>();
  for (const tab of tabs) {
    const host = siteName(tab.url);
    if (hosts.has(host)) continue;
    hosts.add(host);
    picked.push(tab);
    if (picked.length >= max) break;
  }
  return (
    <span aria-hidden="true" className="flex flex-none gap-[3px]">
      {picked.map((tab) => (
        <Favicon key={tab.id} url={tab.url} size={size} />
      ))}
    </span>
  );
}

interface Removal {
  tab: TabRecord;
  snapshot: Promise<RemovedTabs | null>;
  at: number;
  /** Undo was pressed; the row shows again while the tab is put back. */
  restoring?: boolean;
}

export interface RemoveWithUndo {
  /** Removed tabs still offering Undo, by id. */
  removed: Map<string, Removal>;
  remove: (tab: TabRecord) => void;
  undo: (tabId: string) => void;
  /** Undo the most recent removal still on screen (⌘Z). */
  undoLast: () => boolean;
}

/** × on a row: remove at once (no question) and offer Undo in place for 10 seconds. */
export function useRemoveWithUndo(): RemoveWithUndo {
  const [removed, setRemoved] = useState<Map<string, Removal>>(() => new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const current = useRef(removed);
  current.current = removed;

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const drop = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setRemoved((map) => {
      if (!map.has(id)) return map;
      const next = new Map(map);
      next.delete(id);
      return next;
    });
  }, []);

  const remove = useCallback(
    (tab: TabRecord) => {
      const snapshot = removeTabsWithSnapshot([tab.id]).catch(() => {
        drop(tab.id);
        return null;
      });
      setRemoved((map) => new Map(map).set(tab.id, { tab, snapshot, at: Date.now() }));
      clearTimeout(timers.current.get(tab.id));
      timers.current.set(tab.id, setTimeout(() => drop(tab.id), REMOVE_UNDO_MS));
    },
    [drop],
  );

  const undo = useCallback(
    (id: string) => {
      const entry = current.current.get(id);
      if (!entry || entry.restoring) return;
      clearTimeout(timers.current.get(id));
      setRemoved((map) => new Map(map).set(id, { ...entry, restoring: true }));
      void entry.snapshot
        .then((snapshot) => (snapshot ? putBackTabs(snapshot) : undefined))
        .catch(() => undefined)
        .finally(() => drop(id));
    },
    [drop],
  );

  const undoLast = useCallback(() => {
    let last: Removal | undefined;
    for (const entry of current.current.values()) if (!entry.restoring && (!last || entry.at > last.at)) last = entry;
    if (!last) return false;
    undo(last.tab.id);
    return true;
  }, [undo]);

  return useMemo(() => ({ removed, remove, undo, undoLast }), [removed, remove, undo, undoLast]);
}

/** A group "Open all" opens as a Chrome tab group of the same name and colour. */
export interface OpenableGroup {
  name: string;
  color: TabGroupColor;
  items: TabRecord[];
  /** A folder's group (1.0): passed to `open-tabs` so the group folds back into it. */
  folderId?: string;
}

interface ListGroup extends OpenableGroup {
  id: string;
  folder: boolean;
  items: ListedTab[];
  /** A starred folder (1.0): a small star after its name. */
  starred?: boolean;
  /** Opened from this folder ("Open all"): its group folds back into it. */
  folderId?: string;
}

export interface FoldedListProps {
  tabs: TabRecord[];
  /** The person's folders, in their order (shown first when they have tabs). */
  folders?: FolderRecord[];
  /** Sites moved to another kind. */
  siteKinds?: SiteKinds;
  removal: RemoveWithUndo;
  /** Tabs saved at or after this time are new: "+N" on their group and a dot on their row. */
  newSince?: number;
  /** A fold is still adding tabs: groups start collapsed and the group receiving tabs pulses. */
  live?: boolean;
  onOpen: (tab: TabRecord, background: boolean) => void;
  onOpenAll: (group: OpenableGroup) => void;
  /** Is this folder starred (1.0)? Pass the folders starred first, too. */
  isStarred?: (folder: FolderRecord) => boolean;
}

interface ListedTab extends TabRecord {
  removedPlaceholder?: boolean;
}

const NO_FOLDERS: FolderRecord[] = [];

export function FoldedList({ tabs, folders = NO_FOLDERS, siteKinds, removal, newSince, live = false, onOpen, onOpenAll, isStarred }: FoldedListProps) {
  const { groups, folderCount } = useMemo(() => {
    const { removed } = removal;
    const items: ListedTab[] = removed.size ? tabs.filter((t) => !removed.has(t.id)) : [...tabs];
    for (const entry of removed.values()) items.push(entry.restoring ? entry.tab : { ...entry.tab, removedPlaceholder: true });
    // Tabs folded together share a time; a fixed tie-break keeps a removed row's Undo line in its place.
    items.sort((a, b) => b.savedAt - a.savedAt || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const grouped = groupTabs(items, folders, siteKinds);
    const inFolders: ListGroup[] = grouped.folders
      .filter((g) => g.items.length > 0)
      .map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        folder: true,
        items: g.items as ListedTab[],
        starred: !!g.folder && !!isStarred?.(g.folder),
        folderId: g.folder?.id,
      }));
    const bySite: ListGroup[] = grouped.sites.map((g) => ({ id: g.id, name: g.name, color: g.color, folder: false, items: g.items as ListedTab[] }));
    return { groups: [...inFolders, ...bySite], folderCount: inFolders.length };
  }, [tabs, folders, siteKinds, removal, isStarred]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, number>>({});
  const now = Date.now();

  return (
    <div>
      {groups.map((group, index) => {
        const id = group.id;
        // Folders start closed (the board's popup); the newest kind of site opens when there are no folders.
        const isOpen = expanded[id] ?? (index === 0 && !live && folderCount === 0);
        const real = group.items.filter((t) => !t.removedPlaceholder);
        const fresh = newSince === undefined ? 0 : real.filter((t) => t.savedAt >= newSince).length;
        const firstSite = index === folderCount && folderCount > 0;
        return (
          <div key={id}>
            {firstSite && <div aria-hidden className="mx-2 my-1 h-px bg-border" />}
            <FoldedGroup
              group={group}
              tabs={real}
              fresh={fresh}
              receiving={live && fresh > 0 && groups.findIndex((g) => g.items.some((t) => newSince !== undefined && t.savedAt >= newSince)) === index}
              expanded={isOpen}
              shown={shown[id] ?? FIRST_ROWS}
              newSince={newSince}
              now={now}
              removal={removal}
              onToggle={() => setExpanded((e) => ({ ...e, [id]: !isOpen }))}
              onMore={(count) => setShown((s) => ({ ...s, [id]: (s[id] ?? FIRST_ROWS) + count }))}
              onOpen={onOpen}
              onOpenAll={() => onOpenAll({ name: group.name, color: group.color, items: real, folderId: group.folderId })}
            />
          </div>
        );
      })}
    </div>
  );
}

function FoldedGroup({
  group,
  tabs,
  fresh,
  receiving,
  expanded,
  shown,
  newSince,
  now,
  removal,
  onToggle,
  onMore,
  onOpen,
  onOpenAll,
}: {
  group: ListGroup;
  /** The group's tabs without Undo lines. */
  tabs: TabRecord[];
  fresh: number;
  receiving: boolean;
  expanded: boolean;
  shown: number;
  newSince?: number;
  now: number;
  removal: RemoveWithUndo;
  onToggle: () => void;
  onMore: (count: number) => void;
  onOpen: (tab: TabRecord, background: boolean) => void;
  onOpenAll: () => void;
}) {
  const { items } = group;
  const name = group.name;
  const count = tabs.length;
  const visible = expanded ? items.slice(0, shown) : [];
  const more = expanded ? Math.min(items.length - visible.length, MORE_ROWS) : 0;
  return (
    <div role="group" aria-label={`${name}, ${count} ${count === 1 ? 'tab' : 'tabs'}${expanded ? '' : ', collapsed'}`} className="group/fold">
      <div className={cx('flex h-9 items-center gap-2 rounded-control px-2', receiving && 'bg-accent-soft')}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
          onClick={onToggle}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-control text-left"
        >
          {expanded ? (
            <ChevronDown size={14} strokeWidth={2} aria-hidden className="flex-none text-text-3" />
          ) : (
            <ChevronRight size={14} strokeWidth={2} aria-hidden className="flex-none text-text-3" />
          )}
          {group.folder ? <FolderIcon color={group.color} size={15} /> : <span aria-hidden="true" className={cx('tf-cg-dot', `tf-cg-${group.color}`)} style={{ width: 10, height: 10 }} />}
          <span dir="auto" className="truncate font-semibold">
            {name}
          </span>
          {group.starred && <StarMark size={11} />}
          <span className="tabular-nums flex-none text-text-3">· {count.toLocaleString()}</span>
          {fresh > 0 && <NewBadge count={fresh} receiving={receiving} />}
        </button>
        {!expanded && count > 0 && (
          <span className="flex flex-none group-focus-within/fold:hidden group-hover/fold:hidden">
            <FaviconStrip tabs={tabs} />
          </span>
        )}
        {count > 0 && (
          <button
            type="button"
            onClick={onOpenAll}
            title={
              group.folder
                ? `Opens all ${count} tabs as a “${name}” tab group. They stay in the folder.`
                : `Opens all ${count} tabs. They stay in the list.`
            }
            className="hidden h-6 flex-none items-center rounded-md border border-border-strong bg-surface px-2 text-small font-semibold text-text group-focus-within/fold:inline-flex group-hover/fold:inline-flex hover:bg-hover"
          >
            Open all
          </button>
        )}
      </div>
      {expanded && (
        <div role="list">
          {visible.map((tab) =>
            tab.removedPlaceholder ? (
              <RemovedRow key={tab.id} tab={tab} onUndo={() => removal.undo(tab.id)} />
            ) : (
              <FoldedRow
                key={tab.id}
                tab={tab}
                isNew={newSince !== undefined && tab.savedAt >= newSince}
                age={shortAgo(tab.savedAt, now)}
                onOpen={onOpen}
                onRemove={removal.remove}
              />
            ),
          )}
        </div>
      )}
      {more > 0 && (
        <button
          type="button"
          onClick={() => onMore(more)}
          className="flex h-7 w-full items-center rounded-control pr-2 pl-14 text-left text-small text-text-3 hover:bg-hover hover:text-text-2"
        >
          Show {more.toLocaleString()} more
        </button>
      )}
    </div>
  );
}

function NewBadge({ count, receiving }: { count: number; receiving: boolean }) {
  return (
    <span
      aria-label={receiving ? `${count} new, still folding` : `${count} new`}
      className={cx(
        'tabular-nums inline-flex h-[18px] flex-none items-center rounded-full px-1.5 text-meta font-semibold',
        receiving ? 'tf-pulse bg-accent text-on-accent' : 'bg-accent-soft text-accent-text',
      )}
    >
      +{count.toLocaleString()}
    </span>
  );
}

const FoldedRow = memo(function FoldedRow({
  tab,
  isNew,
  age,
  onOpen,
  onRemove,
}: {
  tab: TabRecord;
  isNew: boolean;
  age: string;
  onOpen: (tab: TabRecord, background: boolean) => void;
  onRemove: (tab: TabRecord) => void;
}) {
  const title = tabTitle(tab);
  return (
    <div role="listitem" className="group/row flex h-8 items-center gap-2 rounded-control px-2 focus-within:bg-hover hover:bg-hover">
      <span className="flex w-3.5 flex-none justify-center">
        {isNew && <span aria-label="New" role="img" className="size-1.5 rounded-full bg-accent" />}
      </span>
      <button
        type="button"
        aria-label={`Open ${title}${tab.incognito ? ' in Incognito' : ''} (stays in the list)`}
        onClick={(e) => onOpen(tab, e.metaKey || e.ctrlKey || e.shiftKey)}
        onAuxClick={(e) => {
          if (e.button === 1) onOpen(tab, true);
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-control text-left"
      >
        <Favicon url={tab.url} size={16} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span dir="auto" className="min-w-0 truncate">
            {title}
          </span>
          {tab.incognito && <IncognitoMark size={13} />}
        </span>
        <span className="max-w-[45%] flex-none truncate text-meta text-text-3">{siteName(tab.url)}</span>
      </button>
      <span className="w-6 flex-none text-right text-meta text-text-3 group-focus-within/row:hidden group-hover/row:hidden">{age}</span>
      <button
        type="button"
        aria-label="Remove from list"
        title="Remove from list"
        onClick={() => onRemove(tab)}
        className="hidden size-6 flex-none items-center justify-center rounded-md text-text-2 group-focus-within/row:flex group-hover/row:flex hover:bg-border hover:text-text"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
});

function RemovedRow({ tab, onUndo }: { tab: TabRecord; onUndo: () => void }) {
  return (
    <div role="status" className="flex h-8 items-center gap-2 rounded-control bg-bg-subtle pr-1 pl-[30px] text-small text-text-3">
      <span dir="auto" className="min-w-0 flex-1 truncate">
        Removed “{tabTitle(tab)}”
      </span>
      <button
        type="button"
        onClick={onUndo}
        className="inline-flex h-6 flex-none items-center gap-1 rounded-md px-2 text-small font-semibold text-accent-text hover:bg-hover"
      >
        <RotateCcw size={12} strokeWidth={2} aria-hidden />
        Undo
      </button>
    </div>
  );
}
