import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Clock, Ellipsis, ExternalLink, FolderPlus, GripVertical, Radio, RotateCcw, Users, X } from 'lucide-react';
import { categorize, siteKey, type SiteKinds } from '@/lib/categories';
import type { PlanState } from '@/lib/pro/types';
import type { LiveFolder } from '@/lib/state';
import { displayName, latestActivity } from '@/lib/teams';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { displayHost } from '@/lib/urls';
import { Avatar, AvatarStack } from '@/ui/components/Avatars';
import { Chip } from '@/ui/components/ProBits';
import { Favicon } from '@/ui/components/Favicon';
import { ColorDot, FolderIcon } from '@/ui/components/FolderIcon';
import { IncognitoMark } from '@/ui/components/IncognitoMark';
import { NoteField } from '@/ui/components/NoteField';
import { StarMark } from '@/ui/components/Star';
import { anchorBelow, Menu, type MenuAnchor, type MenuEntry } from '@/ui/components/Menu';
import { cx } from '@/ui/cx';
import { groupTabs, type TabGroup } from '@/ui/folders';
import { modKey, useNow, useTeam, type TeamView } from '@/ui/hooks';
import { formatSnoozeTime } from '@/ui/snooze';
import { openFolded, openGroup, removeOne, undoRemoval, useRemovals, type Removal } from './actions';
import { dropOnGroup, focusLive, foldLive, renameFolder, wakeTabs } from './folderActions';
import { ago, count } from './format';
import { folderMenu, siteGroupMenu, tabMenu, type MenuContext } from './menus';
import { dropHandlers, Sidebar, type DropTarget } from './Sidebar';
import { openDialog, TAB_DRAG_TYPE, useDrag, useLibraryUi } from './uiStore';

/** Rows a group shows before "Show N more". */
const FIRST_ROWS = 6;

const SIZE = { head: 48, row: 34, more: 32, end: 8, label: 36, live: 30, empty: 34, activity: 30, note: 24, noteEditing: 62 } as const;

type Item =
  | { type: 'snooze-head'; key: string; n: number; expanded: boolean; first: boolean }
  | { type: 'snoozed'; key: string; tab: TabRecord }
  | { type: 'head'; key: string; group: TabGroup; live: TabRecord[]; first: boolean; expanded: boolean }
  | { type: 'live-line'; key: string; group: TabGroup }
  /** A folder's one-line note under its header (1.0), or the field editing it. */
  | { type: 'note'; key: string; group: TabGroup; editing: boolean }
  | { type: 'empty'; key: string; group: TabGroup }
  | { type: 'label'; key: string }
  /** "Team · Truewidgets" above the team's folders (Mx-Share). */
  | { type: 'team-label'; key: string }
  /** The team has no folders yet. */
  | { type: 'team-empty'; key: string }
  /** "Sara added 3 tabs · 2 h ago" under a team folder's header (from the tabs still in the list). */
  | { type: 'activity'; key: string; group: TabGroup; tabs: TabRecord[] }
  | { type: 'row'; key: string; tab: TabRecord; group: TabGroup }
  | { type: 'removed'; key: string; removal: Removal; group: TabGroup }
  | { type: 'more'; key: string; group: TabGroup; hidden: number }
  | { type: 'end'; key: string; group?: TabGroup };

function sizeOf(item: Item): number {
  switch (item.type) {
    case 'snooze-head':
    case 'head':
      return SIZE.head + (item.first ? 0 : 1);
    case 'row':
    case 'removed':
    case 'snoozed':
      return SIZE.row;
    case 'more':
      return SIZE.more;
    case 'end':
      return SIZE.end;
    case 'label':
    case 'team-label':
      return SIZE.label;
    case 'team-empty':
      return SIZE.empty;
    case 'activity':
      return SIZE.activity;
    case 'live-line':
      return SIZE.live;
    case 'note':
      return item.editing ? SIZE.noteEditing : SIZE.note;
    case 'empty':
      return SIZE.empty;
  }
}

export const SECONDARY_SM =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover';

const ICON_BTN = 'inline-flex size-7 items-center justify-center rounded-md text-text-2 hover:bg-border hover:text-text';

interface OpenMenu {
  key: string;
  anchor: MenuAnchor;
  entries: MenuEntry[];
  label: string;
  width?: number;
  returnFocus: HTMLElement | null;
}

/**
 * Every folded tab (Fo-List): snoozed tabs first when there are any, then the person's folders,
 * then "By site" with the kinds of site (groups ordered by their newest tab, newest first inside
 * a group). A left column jumps to a group and takes dropped tabs. Rows have a grip to drag them
 * onto another group and a ⋯ menu (also right-click and Shift+F10) with Move to, Snooze, Open in
 * background and Remove. The list is virtualised (only the rows on screen exist), so 10,000+
 * tabs scroll smoothly.
 */
export function GroupedList({
  tabs,
  folders,
  siteKinds,
  liveFolders,
  plan,
  windowLabel,
  scrollRef,
  canCopyContext = false,
  isStarred,
}: {
  tabs: TabRecord[];
  folders: FolderRecord[];
  siteKinds: SiteKinds;
  liveFolders: Record<string, LiveFolder>;
  plan: PlanState;
  /** "Window 2" for a browser window id. */
  windowLabel: (windowId: number) => string;
  scrollRef: RefObject<HTMLElement | null>;
  canCopyContext?: boolean;
  /** Is this folder starred (1.0)? Pass the folders starred first, too. */
  isStarred?: (folder: FolderRecord) => boolean;
}) {
  const removals = useRemovals((s) => s.removals);
  const team = useTeam(plan);
  const [expanded, setExpanded] = useState<Partial<Record<string, boolean>>>({});
  const [showAll, setShowAll] = useState<Partial<Record<string, boolean>>>({});
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const now = useNow(true, 60_000);

  // Removed rows stay in place (as "Removed … · Undo") until their undo runs out.
  const { shown, counted, liveIds } = useMemo(() => {
    const live = new Set(tabs.map((t) => t.id));
    const ghosts = [...removals.values()].filter((r) => !live.has(r.tab.id)).map((r) => r.tab);
    return {
      shown: groupTabs(ghosts.length ? [...tabs, ...ghosts] : tabs, folders, siteKinds),
      counted: ghosts.length ? groupTabs(tabs, folders, siteKinds) : null,
      liveIds: live,
    };
  }, [tabs, removals, folders, siteKinds]);
  const real = counted ?? shown;

  const ctx: MenuContext = useMemo(
    () => ({ folders, siteKinds, plan, liveFolders, canCopyContext, isStarred }),
    [folders, siteKinds, plan, liveFolders, canCopyContext, isStarred],
  );
  const editingNote = useLibraryUi((s) => s.editingNote);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const hasTeam = !!team.team;
  const { items, heads, order } = useMemo(() => {
    const out: Item[] = [];
    const headIndex = new Map<string, number>();
    const ids: string[] = [];
    if (shown.snoozed.length) {
      const open = expanded.snoozed ?? true;
      headIndex.set('snoozed', 0);
      ids.push('snoozed');
      out.push({ type: 'snooze-head', key: 'h:snoozed', n: shown.snoozed.length, expanded: open, first: true });
      if (open) for (const tab of shown.snoozed) out.push({ type: 'snoozed', key: `z:${tab.id}`, tab });
      out.push({ type: 'end', key: 'e:snoozed' });
    }
    const push = (group: TabGroup, openByDefault: boolean) => {
      const id = group.id;
      const live = group.items.filter((t) => liveIds.has(t.id));
      const isOpen = expanded[id] ?? openByDefault;
      const previous = out[out.length - 1];
      headIndex.set(id, out.length);
      ids.push(id);
      out.push({
        type: 'head',
        key: `h:${id}`,
        group,
        live,
        first: !previous || previous.type === 'label' || previous.type === 'team-label',
        expanded: isOpen,
      });
      const editing = !!group.folder && editingNote === group.folder.id;
      if (group.folder && (group.folder.note?.trim() || editing)) out.push({ type: 'note', key: `o:${id}`, group, editing });
      if (!isOpen) return;
      if (group.folder && liveFolders[group.folder.id]) out.push({ type: 'live-line', key: `l:${id}`, group });
      if (group.folder?.teamId && latestActivity(live)) out.push({ type: 'activity', key: `a:${id}`, group, tabs: live });
      if (group.items.length === 0) out.push({ type: 'empty', key: `n:${id}`, group });
      const visible = showAll[id] ? group.items : group.items.slice(0, FIRST_ROWS);
      for (const tab of visible) {
        const removal = removals.get(tab.id);
        out.push(removal ? { type: 'removed', key: `x:${tab.id}`, removal, group } : { type: 'row', key: tab.id, tab, group });
      }
      const hidden = group.items.length - visible.length;
      if (hidden > 0) out.push({ type: 'more', key: `m:${id}`, group, hidden });
      out.push({ type: 'end', key: `e:${id}`, group });
    };
    const own = shown.folders.filter((g) => !g.folder?.teamId);
    const teams = shown.folders.filter((g) => !!g.folder?.teamId);
    own.forEach((group, index) => push(group, index < 2));
    // The team's folders after the person's own, under "Team · Truewidgets" (Mx-Share).
    if (teams.length || hasTeam) {
      out.push({ type: 'team-label', key: 'team-label' });
      if (teams.length === 0) out.push({ type: 'team-empty', key: 'team-empty' });
      teams.forEach((group, index) => push(group, index < 2));
    }
    if ((shown.folders.length || hasTeam) && shown.sites.length) out.push({ type: 'label', key: 'label' });
    shown.sites.forEach((group, index) => push(group, index < (shown.folders.length || hasTeam ? 1 : 2)));
    return { items: out, heads: headIndex, order: ids };
  }, [shown, liveIds, expanded, showAll, removals, liveFolders, hasTeam, editingNote]);

  const listRef = useRef<HTMLDivElement>(null);
  const [listTop, setListTop] = useState(0);
  useLayoutEffect(() => {
    const top = listRef.current?.offsetTop ?? 0;
    if (top !== listTop) setListTop(top);
  });

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => sizeOf(items[index]!),
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 12,
    scrollMargin: listTop,
  });

  // The group at the top of the screen is the current one in the left column; scrolled to the
  // end, the last group whose header is on screen (short groups at the end can't reach the top).
  const scroller = scrollRef.current;
  const atEnd = !!scroller && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  const offset = (virtualizer.scrollOffset ?? 0) - listTop + (atEnd ? (scroller?.clientHeight ?? 0) - 48 : 32);
  let current: string | undefined = order[0];
  for (const id of order) {
    const start = virtualizer.measurementsCache[heads.get(id) ?? 0]?.start;
    if (start !== undefined && start - listTop <= offset) current = id;
  }

  const jump = useCallback(
    (id: string) => {
      setExpanded((e) => ({ ...e, [id]: true }));
      const index = heads.get(id);
      if (index !== undefined) requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: 'start' }));
    },
    [heads, virtualizer],
  );

  // "See snoozed tabs" and the like ask for a group from elsewhere on the page.
  const jumpTo = useLibraryUi((s) => s.jumpTo);
  useEffect(() => {
    if (!jumpTo) return;
    jump(jumpTo);
    useLibraryUi.getState().setJumpTo(null);
  }, [jumpTo, jump]);

  // Dragging ends however it ends (dropped outside, the row scrolled away, Esc).
  useEffect(() => {
    const end = () => useDrag.getState().end();
    document.addEventListener('dragend', end);
    document.addEventListener('drop', end);
    return () => {
      document.removeEventListener('dragend', end);
      document.removeEventListener('drop', end);
    };
  }, []);

  const target: DropTarget = useMemo(
    () => ({
      canDrop: (group) => {
        const tab = useDrag.getState().tab;
        if (!tab) return false;
        if (group.kind === 'folder') return !!group.folder && tab.folderId !== group.folder.id;
        return !!tab.folderId || categorize(tab.url, ctxRef.current.siteKinds) !== group.categoryId;
      },
      onDrop: (group, tab) => void dropOnGroup(tab, group, ctxRef.current.siteKinds, ctxRef.current.folders),
    }),
    [],
  );

  const openTabMenu = useCallback((tab: TabRecord, anchor: MenuAnchor, returnFocus: HTMLElement | null) => {
    setMenu({ key: tab.id, anchor, entries: tabMenu(tab, ctxRef.current), label: `More for ${tab.title || tab.url}`, returnFocus });
  }, []);
  const openGroupMenu = useCallback((group: TabGroup, anchor: MenuAnchor, returnFocus: HTMLElement | null) => {
    const entries = group.kind === 'folder' ? folderMenu(group, ctxRef.current) : siteGroupMenu(group, ctxRef.current);
    setMenu({ key: group.id, anchor, entries, label: `More for ${group.name}`, width: group.kind === 'folder' ? 320 : 280, returnFocus });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <>
      <Sidebar
        snoozed={real.snoozed.length}
        folders={folders}
        folderGroups={real.folders.filter((g) => !g.folder?.teamId)}
        teamGroups={real.folders.filter((g) => !!g.folder?.teamId)}
        sites={real.sites}
        current={current}
        liveFolders={liveFolders}
        plan={plan}
        team={team}
        target={target}
        onJump={jump}
        isStarred={isStarred}
      />

      <div ref={listRef} className="relative col-start-2 row-start-2" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const item = items[v.index]!;
          const menuOpen = !!menu && (item.type === 'head' ? menu.key === item.group.id : item.type === 'row' && menu.key === item.tab.id);
          const groupOf = 'group' in item ? item.group : undefined;
          return (
            <div
              key={v.key}
              className={cx('absolute inset-x-0 top-0', menuOpen ? 'z-20' : 'hover:z-10 focus-within:z-10')}
              style={{ transform: `translateY(${v.start - listTop}px)`, height: v.size }}
              {...(groupOf ? dropHandlers(groupOf, target) : {})}
            >
              {item.type === 'head' ? (
                <GroupHead
                  item={item}
                  starred={!!item.group.folder && !!isStarred?.(item.group.folder)}
                  menuOpen={menuOpen}
                  live={item.group.folder ? liveFolders[item.group.folder.id] : undefined}
                  windowLabel={windowLabel}
                  siteKinds={siteKinds}
                  team={item.group.folder?.teamId ? team : undefined}
                  onToggle={() => setExpanded((e) => ({ ...e, [item.group.id]: !item.expanded }))}
                  onMenu={openGroupMenu}
                />
              ) : item.type === 'row' ? (
                <Row tab={item.tab} now={now} menuOpen={menuOpen} onMenu={openTabMenu} />
              ) : item.type === 'removed' ? (
                <RemovedRow removal={item.removal} />
              ) : item.type === 'snooze-head' ? (
                <SnoozeHead
                  n={item.n}
                  expanded={item.expanded}
                  first={item.first}
                  onToggle={() => setExpanded((e) => ({ ...e, snoozed: !item.expanded }))}
                />
              ) : item.type === 'snoozed' ? (
                <SnoozedRow tab={item.tab} now={now} />
              ) : item.type === 'label' ? (
                <div className="flex h-9 items-end justify-between border-t border-border px-2 pb-1.5">
                  <h2 className="label-caps m-0">By site</h2>
                  <span className="text-small text-text-3">Tabs not in a folder</span>
                </div>
              ) : item.type === 'team-label' ? (
                <TeamLabel team={team} />
              ) : item.type === 'team-empty' ? (
                <div className="flex h-[34px] items-center px-2 text-small text-text-3">
                  No team folders yet. Make one, then move tabs into it: everyone in the team sees them.
                </div>
              ) : item.type === 'activity' ? (
                <ActivityLine tabs={item.tabs} team={team} now={now} />
              ) : item.type === 'live-line' ? (
                <LiveLine group={item.group} />
              ) : item.type === 'note' ? (
                <NoteLine group={item.group} editing={item.editing} />
              ) : item.type === 'empty' ? (
                <div className="flex h-[34px] items-center pr-2 pl-[62px] text-small text-text-3">
                  No tabs yet. Drag tabs here, or use a tab’s ⋯ › Move to.
                </div>
              ) : item.type === 'more' ? (
                <button
                  type="button"
                  onClick={() => setShowAll((s) => ({ ...s, [item.group.id]: true }))}
                  className="flex h-8 items-center rounded-control pr-2 pl-[62px] text-small text-text-2 hover:text-text hover:underline"
                >
                  Show {item.hidden.toLocaleString()} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {menu && <Menu anchor={menu.anchor} entries={menu.entries} label={menu.label} width={menu.width} onClose={closeMenu} returnFocus={menu.returnFocus} />}
    </>
  );
}

function SnoozeHead({ n, expanded, first, onToggle }: { n: number; expanded: boolean; first: boolean; onToggle: () => void }) {
  return (
    <div className={cx('flex h-12 items-center gap-2 px-2', !first && 'border-t border-border')}>
      <h2 className="m-0 flex h-full min-w-0 flex-1 text-body font-semibold">
        <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left">
          {expanded ? (
            <ChevronDown size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
          ) : (
            <ChevronRight size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
          )}
          <Clock size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-2" />
          <span>Snoozed</span>
          <span className="shrink-0 font-normal text-text-3">{count(n, 'tab')} · come back on their own</span>
        </button>
      </h2>
    </div>
  );
}

/** A snoozed tab (Mx-Auto "Snoozed tabs"): when it comes back, and Wake now. */
function SnoozedRow({ tab, now }: { tab: TabRecord; now: number }) {
  const title = tab.title || tab.url;
  const when = tab.snoozeUntil ?? now;
  return (
    <div role="listitem" className="flex h-[34px] items-center gap-2.5 rounded-control px-2 hover:bg-hover">
      <span className="w-4 shrink-0" />
      <button
        type="button"
        aria-label={`Open ${title} (stays snoozed)`}
        title={tab.url}
        onClick={() => void openFolded(tab, true)}
        className="flex h-full min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Favicon url={tab.url} size={16} />
        <span dir="auto" className="min-w-0 flex-1 truncate">
          {title}
        </span>
      </button>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-small text-text-2" title={when < now ? 'Comes back on the computer that snoozed it' : undefined}>
        <Clock size={13} strokeWidth={1.75} aria-hidden className="text-text-3" />
        {formatSnoozeTime(when, now)}
      </span>
      <button type="button" onClick={() => void wakeTabs([tab])} className={cx(SECONDARY_SM, 'ml-1.5 h-[26px]')}>
        Wake now
      </button>
    </div>
  );
}

/** "Team · Truewidgets" above the team's folders, with "New team folder". */
function TeamLabel({ team }: { team: TeamView }) {
  const name = team.team?.name ?? 'your team';
  return (
    <div className="flex h-9 items-end justify-between gap-3 border-t border-border px-2 pb-1.5">
      <h2 className="label-caps m-0 min-w-0 truncate">Team · {name}</h2>
      {team.team && (
        <button
          type="button"
          onClick={() => {
            // The left column's field when it shows (wide windows); a small dialog otherwise.
            if (window.matchMedia('(min-width: 1320px)').matches) useLibraryUi.getState().setCreatingTeam(true);
            else openDialog({ kind: 'new-folder', teamId: team.team!.id });
          }}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-small text-text-2 hover:bg-hover hover:text-text"
        >
          <FolderPlus size={14} strokeWidth={1.75} aria-hidden className="text-text-3" />
          New team folder
        </button>
      )}
    </div>
  );
}

/** "Sara added 3 tabs · 2 h ago" (Mx-Share "A team folder"): the newest addition, from who added each tab. */
function ActivityLine({ tabs, team, now }: { tabs: TabRecord[]; team: TeamView; now: number }) {
  const activity = latestActivity(tabs);
  if (!activity) return null;
  const you = !!team.email && activity.email === team.email;
  const when = ago(activity.at, now).replace(/^(Just now|Yesterday|Last week)/, (w) => w.toLowerCase());
  return (
    <div className="flex h-[30px] items-center gap-2 pr-2 pl-[34px] text-small text-text-3">
      <Avatar email={activity.email} color={team.colorOf(activity.email)} size={18} />
      <span className="min-w-0 truncate">
        <b className="font-semibold text-text-2">{you ? 'You' : displayName(activity.email)}</b> added {count(activity.tabs, 'tab')} · {when}
      </span>
    </div>
  );
}

/** A folder's note under its header (Fi-List): click it to edit it in place. */
function NoteLine({ group, editing }: { group: TabGroup; editing: boolean }) {
  const folder = group.folder!;
  const setEditing = useLibraryUi((s) => s.setEditingNote);
  if (editing) {
    return <NoteField folder={folder} onDone={() => setEditing(null)} className="mr-2 ml-[60px] max-w-[520px]" />;
  }
  return (
    <div className="flex h-6 items-start pr-2 pl-[60px]">
      <button
        type="button"
        dir="auto"
        title="Click to edit the note"
        aria-label={`Note: ${folder.note}. Edit the note`}
        onClick={() => setEditing(folder.id)}
        className="-mt-1.5 max-w-full cursor-text truncate text-left text-small text-text-3 hover:text-text-2"
      >
        {folder.note}
      </button>
    </div>
  );
}

/** Under a live folder's header (Mx-Live): a quiet line instead of the board's tab-strip picture. */
function LiveLine({ group }: { group: TabGroup }) {
  return (
    <div className="flex h-[30px] items-center gap-2 pr-2 pl-[34px] text-small text-text-3">
      <Radio size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-green" />
      <span>Open as a Chrome tab group · changes save here ·</span>
      <button type="button" onClick={() => void foldLive(group.folder!)} className="font-semibold text-accent-text hover:underline">
        Fold the group
      </button>
    </div>
  );
}

function GroupHead({
  item,
  starred,
  menuOpen,
  live,
  windowLabel,
  siteKinds,
  team,
  onToggle,
  onMenu,
}: {
  item: Extract<Item, { type: 'head' }>;
  /** A starred folder: a small star after its name (1.0). */
  starred: boolean;
  menuOpen: boolean;
  live: LiveFolder | undefined;
  windowLabel: (windowId: number) => string;
  siteKinds: SiteKinds;
  /** A team folder's team: the Team chip and its people. */
  team?: TeamView;
  onToggle: () => void;
  onMenu: (group: TabGroup, anchor: MenuAnchor, returnFocus: HTMLElement | null) => void;
}) {
  const { group, live: tabs, expanded, first } = item;
  const folder = group.folder;
  const trigger = useRef<HTMLButtonElement>(null);
  const renaming = useLibraryUi((s) => (folder && s.renaming?.id === folder.id && s.renaming.where === 'list' ? true : false));
  const setRenaming = useLibraryUi((s) => s.setRenaming);
  const dragTab = useDrag((s) => (s.over === group.id ? s.tab : null));
  const n = tabs.length;
  const hosts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const tab of tabs) {
      const host = displayHost(tab.url);
      if (!seen.has(host)) seen.set(host, tab.url);
      if (seen.size >= 4) break;
    }
    return [...seen.values()];
  }, [tabs]);

  let dropText = '';
  if (dragTab) {
    const sameKind = group.kind === 'site' && categorize(dragTab.url, siteKinds) === group.categoryId;
    dropText = group.kind === 'folder' || sameKind ? 'Drop to move this tab here' : `Drop to move ${siteKey(dragTab.url)} here`;
  }

  return (
    <div className={cx('h-12', !first && 'border-t border-border')}>
      <div
        className={cx(
          'flex h-full items-center gap-2 px-2',
          dragTab && 'rounded-card bg-accent-soft outline-2 outline-offset-[-2px] outline-accent outline-dashed',
        )}
      >
        <h2 className="m-0 flex h-full min-w-0 flex-1 text-body font-semibold">
          {renaming && folder ? (
            <span className="flex h-full min-w-0 flex-1 items-center gap-2.5">
              <span className="w-4 shrink-0" />
              <FolderIcon color={group.color} />
              <RenameInput folder={folder} onDone={() => setRenaming(null)} />
            </span>
          ) : (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={onToggle}
              onDoubleClick={folder ? () => setRenaming({ id: folder.id, where: 'list' }) : undefined}
              className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left"
            >
              {expanded ? (
                <ChevronDown size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
              ) : (
                <ChevronRight size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
              )}
              {folder ? <FolderIcon color={group.color} /> : <ColorDot color={group.color} />}
              <span dir="auto" className="truncate">
                {group.name}
              </span>
              {folder && starred && <StarMark size={12} />}
              <span className="shrink-0 font-normal text-text-3">{count(n, 'tab')}</span>
              {team && (
                <Chip tone="neutral">
                  <Users size={11} strokeWidth={2} aria-hidden />
                  Team
                </Chip>
              )}
              {live && (
                <span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-green-soft px-2 text-meta font-semibold text-green">
                  <span aria-hidden className="size-1.5 rounded-full bg-green" />
                  Live · {windowLabel(live.windowId)}
                </span>
              )}
            </button>
          )}
        </h2>
        {dragTab ? (
          <span role="status" className="shrink-0 text-small font-semibold text-accent-text">
            {dropText}
          </span>
        ) : null}
        {team && !dragTab && team.people.length > 0 && (
          <AvatarStack people={team.people} label={`${team.people.length} ${team.people.length === 1 ? 'person' : 'people'} in ${team.team?.name ?? 'the team'}`} className="mr-1" />
        )}
        {expanded || menuOpen ? (
          <>
            {!dragTab &&
              (live && folder ? (
                <button type="button" onClick={() => void focusLive(folder)} className={SECONDARY_SM}>
                  Go to window
                </button>
              ) : (
                <button
                  type="button"
                  title={
                    folder
                      ? `Opens all ${count(n, 'tab')} as a “${group.name}” tab group. They stay in the folder.`
                      : `Opens all ${count(n, 'tab')} in this window. They stay in the list.`
                  }
                  disabled={n === 0}
                  onClick={() => void openGroup(tabs, group, folder?.id)}
                  className={cx(SECONDARY_SM, 'disabled:cursor-default disabled:text-text-3')}
                >
                  Open all
                </button>
              ))}
            <button
              ref={trigger}
              type="button"
              aria-label={`More for ${group.name}`}
              title={`More for ${group.name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(e) => onMenu(group, anchorBelow(e.currentTarget), e.currentTarget)}
              className={cx('inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text', menuOpen && 'bg-hover')}
            >
              <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </>
        ) : (
          !dragTab &&
          !team && (
            <span aria-hidden className="flex shrink-0 gap-[3px]">
              {hosts.map((url) => (
                <Favicon key={url} url={url} size={14} />
              ))}
            </span>
          )
        )}
      </div>
    </div>
  );
}

function RenameInput({ folder, onDone }: { folder: FolderRecord; onDone: () => void }) {
  const [name, setName] = useState(folder.name);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) void renameFolder(folder, name);
    onDone();
  };
  return (
    <input
      autoFocus
      aria-label={`Rename ${folder.name}`}
      value={name}
      maxLength={60}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className="h-8 min-w-0 max-w-[360px] flex-1 rounded-control border border-accent bg-surface px-2 font-semibold text-text shadow-[0_0_0_3px_var(--tf-accent-line)] outline-none"
    />
  );
}

const Row = memo(function Row({
  tab,
  now,
  menuOpen,
  onMenu,
}: {
  tab: TabRecord;
  now: number;
  menuOpen: boolean;
  onMenu: (tab: TabRecord, anchor: MenuAnchor, returnFocus: HTMLElement | null) => void;
}) {
  const title = tab.title || tab.url;
  const more = useRef<HTMLButtonElement>(null);
  const dragging = useDrag((s) => s.tab?.id === tab.id);
  const openMenuFromKeys = (e: React.KeyboardEvent) => {
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault();
      const el = more.current ?? (e.target as HTMLElement);
      onMenu(tab, anchorBelow(el), e.target as HTMLElement);
    }
  };
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
        e.dataTransfer.setData('text/uri-list', tab.url);
        e.dataTransfer.setData('text/plain', tab.url);
        e.dataTransfer.effectAllowed = 'copyMove';
        useDrag.getState().start(tab);
      }}
      onDragEnd={() => useDrag.getState().end()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(tab, { x: e.clientX, y: e.clientY }, (e.target as HTMLElement).closest('button') ?? more.current);
      }}
      onKeyDown={openMenuFromKeys}
      className={cx(
        'tf-row flex h-[34px] items-center gap-2.5 rounded-control px-2 hover:bg-hover focus-within:bg-hover',
        menuOpen && 'tf-row-on bg-hover',
        dragging && 'opacity-35 outline-[1.5px] outline-offset-[-2px] outline-border-strong outline-dashed',
      )}
    >
      <span title="Drag to another group" aria-hidden className="tf-row-grip flex w-4 shrink-0 cursor-grab justify-center text-text-3">
        <GripVertical size={14} strokeWidth={2} />
      </span>
      <button
        type="button"
        aria-label={`Open ${title}${tab.incognito ? ' in Incognito' : ''} (stays in the list)`}
        aria-keyshortcuts="Shift+F10"
        title={tab.url}
        onClick={(e) => void openFolded(tab, !(e.metaKey || e.ctrlKey))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void openFolded(tab, false);
          }
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-offset-0"
      >
        <Favicon url={tab.url} size={16} />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span dir="auto" className="min-w-0 truncate">
            {title}
          </span>
          {tab.incognito && <IncognitoMark />}
        </span>
        <span className="w-[180px] shrink-0 truncate text-small text-text-2 max-[720px]:hidden">{displayHost(tab.url)}</span>
      </button>
      <span className="tf-row-time w-24 shrink-0 text-right text-small text-text-3">{ago(tab.savedAt, now)}</span>
      <span className="tf-row-actions w-24 shrink-0 justify-end gap-0.5">
        <span className="tf-tip">
          <button type="button" aria-label="Open in background" onClick={() => void openFolded(tab, false)} className={ICON_BTN}>
            <ExternalLink size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <span role="tooltip">Open in background · {modKey}↵</span>
        </span>
        <button
          ref={more}
          type="button"
          aria-label={`More for ${title}`}
          title="Move to, snooze and more"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => onMenu(tab, anchorBelow(e.currentTarget), e.currentTarget)}
          className={cx(ICON_BTN, menuOpen && 'bg-border text-text')}
        >
          <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" aria-label="Remove from list" title="Remove from list" onClick={() => void removeOne(tab)} className={ICON_BTN}>
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </span>
    </div>
  );
});

function RemovedRow({ removal }: { removal: Removal }) {
  return (
    <div role="status" className="flex h-[34px] items-center gap-2 rounded-control bg-bg-subtle pr-1 pl-[34px] text-small text-text-3">
      <span dir="auto" className="min-w-0 flex-1 truncate">
        Removed “{removal.tab.title || removal.tab.url}”
      </span>
      <button
        type="button"
        onClick={() => void undoRemoval(removal.tab.id)}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-small font-semibold text-accent-text hover:bg-hover"
      >
        <RotateCcw size={12} strokeWidth={2} aria-hidden />
        Undo
      </button>
    </div>
  );
}
