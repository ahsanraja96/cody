import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { Archive, ChevronDown, ChevronRight, Clock, Ellipsis, ExternalLink } from 'lucide-react';
import { categorize, type SiteKinds } from '@/lib/categories';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { Favicon } from '@/ui/components/Favicon';
import { FaviconStrip } from '@/ui/components/FoldedList';
import { ColorDot, FolderIcon } from '@/ui/components/FolderIcon';
import { IncognitoMark } from '@/ui/components/IncognitoMark';
import { anchorBelow, type MenuAnchor } from '@/ui/components/Menu';
import { NoteField } from '@/ui/components/NoteField';
import { StarMark } from '@/ui/components/Star';
import { cx } from '@/ui/cx';
import { groupTabs, type TabGroup } from '@/ui/folders';
import { formatSnoozeTime } from '@/ui/snooze';
import { ago } from '../library/format';
import { fold, foldTabToKind, moveTabs, moveTabToKind, openAll, openFolded, wakeTabs } from './actions';
import { PANEL_DRAG_TYPE, useDrag } from './drag';
import { DIVIDER, PanelLabel, ShowMore } from './parts';

/**
 * "Folded" in the side panel (Fi-Panel, Fi-Panel-States): starred folders first, three folders then
 * "Show 6 more folders", each with its note under the name (click to edit); then three kinds of
 * site and "Show 6 more kinds of site"; then Snoozed. A folder opens in place: its tabs (click to
 * open, it stays in the folder; ↗ in the background; ⋯ for Move to, Snooze, Remove), with Open all
 * and ⋯. Drop an open tab on a folder or kind of site to fold it there, a folded tab to move it.
 */

/** Folders and kinds of site listed before "Show N more". */
const FIRST_GROUPS = 3;
/** Tabs listed in an opened folder before "Show N more". */
const FIRST_TABS = 4;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export interface FoldedActions {
  onFolderMenu: (folder: FolderRecord, anchor: MenuAnchor, button: HTMLElement) => void;
  onTabMenu: (tab: TabRecord, anchor: MenuAnchor, button: HTMLElement) => void;
  onFoldThisWindow: () => void;
}

/** Drag and drop onto one group (a folder or a kind of site). */
function useDropTarget(group: TabGroup, siteKinds: SiteKinds, folders: readonly FolderRecord[]) {
  const dragged = useDrag((s) => s.dragged);
  const over = useDrag((s) => !!s.dragged && s.over === group.id);
  const accepts = (): boolean => {
    const d = useDrag.getState().dragged;
    if (!d) return false;
    if (d.kind === 'open') return true;
    if (group.kind === 'folder') return !!group.folder && d.tab.folderId !== group.folder.id;
    return !!d.tab.folderId || categorize(d.tab.url, siteKinds) !== group.categoryId;
  };
  const handlers = {
    onDragOver: (e: DragEvent) => {
      if (!accepts()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      useDrag.getState().setOver(group.id);
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      const { over: now, setOver } = useDrag.getState();
      if (now === group.id) setOver(null);
    },
    onDrop: (e: DragEvent) => {
      const d = useDrag.getState().dragged;
      if (!d || !accepts()) return;
      e.preventDefault();
      useDrag.getState().end();
      if (d.kind === 'open') {
        const url = d.tab.url || d.tab.pendingUrl || '';
        if (group.folder) void fold({ tabIds: [d.tab.id!], intoFolderId: group.folder.id, keepWindowOpen: true });
        else if (group.categoryId) void foldTabToKind({ id: d.tab.id!, url }, group.categoryId, siteKinds);
      } else if (group.folder) {
        const from = d.tab.folderId ? (folders.find((f) => f.id === d.tab.folderId) ?? null) : null;
        void moveTabs([d.tab], group.folder, from);
      } else if (group.categoryId) void moveTabToKind(d.tab, group.categoryId, siteKinds);
    },
  };
  const dropText = over && dragged ? (dragged.kind === 'open' ? `Drop to fold into ${group.name}` : `Drop to move this tab to ${group.name}`) : null;
  return { handlers, over, dropText };
}

function FoldedTabRow({
  tab,
  inFolder,
  now,
  windowId,
  onMenu,
}: {
  tab: TabRecord;
  inFolder: boolean;
  now: number;
  windowId?: number;
  onMenu: FoldedActions['onTabMenu'];
}) {
  const title = tab.title || tab.url;
  const dragging = useDrag((s) => s.dragged?.kind === 'folded' && s.dragged.tab.id === tab.id);
  return (
    <div
      role="listitem"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PANEL_DRAG_TYPE, tab.id);
        e.dataTransfer.setData('text/uri-list', tab.url);
        e.dataTransfer.effectAllowed = 'move';
        useDrag.getState().start({ kind: 'folded', tab });
      }}
      onDragEnd={() => useDrag.getState().end()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(tab, { x: e.clientX, y: e.clientY }, e.currentTarget);
      }}
      onKeyDown={(e) => {
        if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
          e.preventDefault();
          onMenu(tab, anchorBelow(e.target as Element, false), e.target as HTMLElement);
        }
      }}
      className={cx(
        'group/ft flex h-7 items-center gap-2 rounded-md pr-1 pl-[30px] focus-within:bg-hover hover:bg-hover',
        dragging && 'opacity-40 outline-[1.5px] outline-offset-[-2px] outline-border-strong outline-dashed',
      )}
    >
      <button
        type="button"
        aria-label={`Open ${title} (stays in the ${inFolder ? 'folder' : 'list'})`}
        aria-keyshortcuts="Shift+F10"
        title={tab.url}
        onClick={(e) => void openFolded(tab, !(e.metaKey || e.ctrlKey), windowId)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
      >
        <Favicon url={tab.url} size={14} />
        <span dir="auto" className="min-w-0 flex-1 truncate">
          {title}
        </span>
        {tab.incognito && <IncognitoMark size={12} />}
      </button>
      <span className="flex-none text-meta text-text-3 group-focus-within/ft:hidden group-hover/ft:hidden">{ago(tab.savedAt, now)}</span>
      <span className="hidden flex-none gap-0.5 group-focus-within/ft:flex group-hover/ft:flex">
        <button
          type="button"
          aria-label={`Open ${title} in the background`}
          title="Open in the background"
          onClick={() => void openFolded(tab, false, windowId)}
          className="inline-flex size-[22px] items-center justify-center rounded-md text-text-2 hover:bg-border hover:text-text"
        >
          <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`More for ${title}`}
          title="Move to, snooze and more"
          aria-haspopup="menu"
          onClick={(e) => onMenu(tab, anchorBelow(e.currentTarget), e.currentTarget)}
          className="inline-flex size-[22px] items-center justify-center rounded-md text-text-2 hover:bg-border hover:text-text"
        >
          <Ellipsis size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </span>
    </div>
  );
}

function GroupTabs({
  group,
  now,
  windowId,
  actions,
}: {
  group: TabGroup;
  now: number;
  windowId?: number;
  actions: FoldedActions;
}) {
  const [shown, setShown] = useState(FIRST_TABS);
  const visible = group.items.slice(0, shown);
  const hidden = group.items.length - visible.length;
  if (group.items.length === 0) {
    return <p className="m-0 py-1 pr-2 pl-[30px] text-small text-text-3">No tabs yet. Drag a tab here to fold it in.</p>;
  }
  return (
    <>
      <div role="list" aria-label={`Tabs in ${group.name}`}>
        {visible.map((tab) => (
          <FoldedTabRow key={tab.id} tab={tab} inFolder={group.kind === 'folder'} now={now} windowId={windowId} onMenu={actions.onTabMenu} />
        ))}
      </div>
      {hidden > 0 && <ShowMore onClick={() => setShown((n) => n + 100)}>Show {Math.min(hidden, 100).toLocaleString()} more</ShowMore>}
    </>
  );
}

function OpenAllButton({ group, windowId }: { group: TabGroup; windowId?: number }) {
  const n = group.items.length;
  return (
    <button
      type="button"
      disabled={n === 0}
      title={
        group.folder
          ? `Opens all ${plural(n, 'tab')} as a “${group.name}” tab group. They stay in the folder.`
          : `Opens all ${plural(n, 'tab')} as a tab group. They stay in the list.`
      }
      onClick={() => void openAll(group.items, { name: group.name, color: group.color, folderId: group.folder?.id }, windowId)}
      className="inline-flex h-6 flex-none items-center rounded-md border border-border-strong bg-surface px-2 text-small font-semibold text-text hover:bg-hover disabled:text-text-3"
    >
      Open all
    </button>
  );
}

function FolderRow({
  group,
  starred,
  expanded,
  editing,
  menuOpen,
  siteKinds,
  folders,
  now,
  windowId,
  actions,
  onToggle,
  onEditNote,
}: {
  group: TabGroup;
  starred: boolean;
  expanded: boolean;
  editing: boolean;
  menuOpen: boolean;
  siteKinds: SiteKinds;
  folders: readonly FolderRecord[];
  now: number;
  windowId?: number;
  actions: FoldedActions;
  onToggle: () => void;
  onEditNote: (on: boolean) => void;
}) {
  const folder = group.folder!;
  const n = group.items.length;
  const { handlers, over, dropText } = useDropTarget(group, siteKinds, folders);
  const note = folder.note?.trim();
  const two = !!(note && !editing) || !!dropText;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div role="group" aria-label={`${group.name}, ${plural(n, 'tab')}${expanded ? '' : ', collapsed'}`} className="group/fr">
      <div
        {...handlers}
        className={cx(
          'flex min-h-[34px] gap-2 rounded-control pr-1 pl-2',
          two ? 'items-start py-[7px]' : 'items-center',
          over ? 'bg-accent-soft outline-2 outline-offset-[-2px] outline-accent outline-dashed' : menuOpen && 'bg-hover',
        )}
      >
        <button type="button" aria-expanded={expanded} onClick={onToggle} className={cx('flex min-w-0 flex-1 gap-2 text-left', two ? 'items-start' : 'items-center')}>
          <Chevron size={14} strokeWidth={2} aria-hidden className={cx('flex-none text-text-3', two && 'mt-0.5')} />
          <FolderIcon color={group.color} size={15} className={two ? 'mt-0.5' : undefined} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span dir="auto" className="min-w-0 truncate font-semibold">
                {group.name}
              </span>
              {starred && <StarMark size={11} />}
              <span className="flex-none text-text-3 tabular-nums">· {n.toLocaleString()}</span>
            </span>
            {dropText ? (
              <span role="status" className="mt-px block truncate text-small font-semibold text-accent-text">
                {dropText}
              </span>
            ) : (
              note &&
              !editing && (
                <span
                  dir="auto"
                  title="Click to edit the note"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditNote(true);
                  }}
                  className="mt-px block cursor-text truncate text-small text-text-3"
                >
                  {note}
                </span>
              )
            )}
          </span>
        </button>
        <span className={cx('flex flex-none items-center gap-1', two && '-mt-px')}>
          {expanded && !dropText && <OpenAllButton group={group} windowId={windowId} />}
          {!dropText && (
            <button
              type="button"
              aria-label={`More for ${group.name}`}
              title={`More for ${group.name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(e) => actions.onFolderMenu(folder, anchorBelow(e.currentTarget), e.currentTarget)}
              className={cx(
                'size-6 flex-none items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text',
                expanded || menuOpen ? 'inline-flex' : 'hidden group-focus-within/fr:inline-flex group-hover/fr:inline-flex',
                menuOpen && 'bg-hover text-text',
              )}
            >
              <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </span>
      </div>
      {editing && <NoteField folder={folder} onDone={() => onEditNote(false)} className="mt-0.5 mb-1.5 ml-[52px] mr-1" />}
      {expanded && <GroupTabs group={group} now={now} windowId={windowId} actions={actions} />}
    </div>
  );
}

function KindRow({
  group,
  expanded,
  siteKinds,
  folders,
  now,
  windowId,
  actions,
  onToggle,
}: {
  group: TabGroup;
  expanded: boolean;
  siteKinds: SiteKinds;
  folders: readonly FolderRecord[];
  now: number;
  windowId?: number;
  actions: FoldedActions;
  onToggle: () => void;
}) {
  const n = group.items.length;
  const { handlers, over, dropText } = useDropTarget(group, siteKinds, folders);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div role="group" aria-label={`${group.name}, ${plural(n, 'tab')}${expanded ? '' : ', collapsed'}`}>
      <div
        {...handlers}
        className={cx(
          'flex min-h-9 items-center gap-2 rounded-control pr-1 pl-2',
          dropText && 'py-1.5',
          over && 'bg-accent-soft outline-2 outline-offset-[-2px] outline-accent outline-dashed',
        )}
      >
        <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Chevron size={14} strokeWidth={2} aria-hidden className="flex-none text-text-3" />
          <ColorDot color={group.color} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-semibold">{group.name}</span>
              <span className="flex-none text-text-3 tabular-nums">· {n.toLocaleString()}</span>
            </span>
            {dropText && (
              <span role="status" className="block truncate text-small font-semibold text-accent-text">
                {dropText}
              </span>
            )}
          </span>
        </button>
        {expanded ? <OpenAllButton group={group} windowId={windowId} /> : !dropText && <FaviconStrip tabs={group.items} size={14} />}
      </div>
      {expanded && <GroupTabs group={group} now={now} windowId={windowId} actions={actions} />}
    </div>
  );
}

function SnoozedRows({ tabs, now }: { tabs: TabRecord[]; now: number }) {
  const [open, setOpen] = useState(false);
  const next = tabs[0]?.snoozeUntil;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div role="group" aria-label={`Snoozed, ${plural(tabs.length, 'tab')}${open ? '' : ', collapsed'}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex h-[34px] w-full items-center gap-2 rounded-control px-2 text-left hover:bg-hover">
        <Chevron size={14} strokeWidth={2} aria-hidden className="flex-none text-text-3" />
        <Clock size={15} strokeWidth={1.75} aria-hidden className="flex-none text-text-2" />
        <span className="font-semibold">Snoozed</span>
        <span className="text-text-3 tabular-nums">· {tabs.length.toLocaleString()}</span>
        <span className="flex-1" />
        {next && <span className="flex-none text-small text-text-3">next: {formatSnoozeTime(next, now).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}</span>}
      </button>
      {open &&
        tabs.map((tab) => (
          <div key={tab.id} className="flex h-7 items-center gap-2 rounded-md pr-1 pl-[30px] hover:bg-hover">
            <Favicon url={tab.url} size={14} />
            <span dir="auto" className="min-w-0 flex-1 truncate">
              {tab.title || tab.url}
            </span>
            <span className="flex-none text-meta text-text-3">{formatSnoozeTime(tab.snoozeUntil ?? now, now)}</span>
            <button
              type="button"
              onClick={() => void wakeTabs([tab])}
              className="inline-flex h-[22px] flex-none items-center rounded-md border border-border-strong bg-surface px-1.5 text-meta font-semibold hover:bg-hover"
            >
              Wake now
            </button>
          </div>
        ))}
    </div>
  );
}

export function Folded({
  tabs,
  folders,
  isStarred,
  siteKinds,
  countText,
  now,
  windowId,
  canFoldHere,
  menuFolder,
  editing,
  onEditing,
  actions,
}: {
  tabs: TabRecord[];
  folders: readonly FolderRecord[];
  isStarred: (folder: FolderRecord) => boolean;
  siteKinds: SiteKinds;
  /** "2,140", or "488 of 500" (amber from 450) on Free. */
  countText: ReactNode;
  now: number;
  windowId?: number;
  /** This window has tabs to fold (the empty state's button). */
  canFoldHere: boolean;
  /** The folder whose ⋯ menu is open. */
  menuFolder?: string;
  /** The folder whose note is being edited (click the note, or ⋯ › Add a note). */
  editing: string | null;
  onEditing: (folderId: string | null) => void;
  actions: FoldedActions;
}) {
  const [expanded, setExpanded] = useState<Partial<Record<string, boolean>>>({});
  const [allFolders, setAllFolders] = useState(false);
  const [allKinds, setAllKinds] = useState(false);
  const grouped = useMemo(() => groupTabs(tabs, sortStarred(folders, isStarred), siteKinds), [tabs, folders, isStarred, siteKinds]);
  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  if (tabs.length === 0 && folders.length === 0) {
    return (
      <section aria-label="Folded">
        <PanelLabel>Folded</PanelLabel>
        <div className="flex flex-col items-center gap-3 px-5 pt-[18px] pb-[22px] text-center">
          <span aria-hidden className="flex size-10 items-center justify-center rounded-card bg-bg-subtle text-text-3">
            <Archive size={20} strokeWidth={1.75} />
          </span>
          <p className="m-0 max-w-[260px] text-text-2">Nothing folded yet. Fold this window to free its memory; your tabs wait here.</p>
          <button
            type="button"
            disabled={!canFoldHere}
            onClick={actions.onFoldThisWindow}
            className="inline-flex h-8 items-center gap-1.5 rounded-control bg-accent px-3.5 text-small font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            <Archive size={14} strokeWidth={1.75} aria-hidden />
            Fold this window
          </button>
        </div>
      </section>
    );
  }

  const folderGroups = allFolders ? grouped.folders : grouped.folders.slice(0, FIRST_GROUPS);
  const moreFolders = grouped.folders.length - folderGroups.length;
  const kindGroups = allKinds ? grouped.sites : grouped.sites.slice(0, FIRST_GROUPS);
  const moreKinds = grouped.sites.length - kindGroups.length;
  return (
    <section aria-label="Folded">
      <PanelLabel count={countText}>Folded</PanelLabel>
      {folderGroups.map((group) => (
        <FolderRow
          key={group.id}
          group={group}
          starred={isStarred(group.folder!)}
          expanded={!!expanded[group.id]}
          editing={editing === group.folder!.id}
          menuOpen={menuFolder === group.folder!.id}
          siteKinds={siteKinds}
          folders={folders}
          now={now}
          windowId={windowId}
          actions={actions}
          onToggle={() => toggle(group.id)}
          onEditNote={(on) => onEditing(on ? group.folder!.id : null)}
        />
      ))}
      {moreFolders > 0 && (
        <ShowMore onClick={() => setAllFolders(true)}>
          Show {moreFolders.toLocaleString()} more {moreFolders === 1 ? 'folder' : 'folders'}
        </ShowMore>
      )}
      {grouped.folders.length > 0 && grouped.sites.length > 0 && DIVIDER}
      {kindGroups.map((group) => (
        <KindRow
          key={group.id}
          group={group}
          expanded={!!expanded[group.id]}
          siteKinds={siteKinds}
          folders={folders}
          now={now}
          windowId={windowId}
          actions={actions}
          onToggle={() => toggle(group.id)}
        />
      ))}
      {moreKinds > 0 && (
        <ShowMore onClick={() => setAllKinds(true)}>
          Show {moreKinds.toLocaleString()} more {moreKinds === 1 ? 'kind' : 'kinds'} of site
        </ShowMore>
      )}
      {grouped.snoozed.length > 0 && <SnoozedRows tabs={grouped.snoozed} now={now} />}
    </section>
  );
}

/** Starred folders first, each part in the folders' own order. */
function sortStarred(folders: readonly FolderRecord[], isStarred: (folder: FolderRecord) => boolean): FolderRecord[] {
  return [...folders.filter(isStarred), ...folders.filter((f) => !isStarred(f))];
}
