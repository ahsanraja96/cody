import { useState, type ReactNode } from 'react';
import type { Browser } from 'wxt/browser';
import { Archive, ChevronDown, ChevronRight, Ellipsis, X } from 'lucide-react';
import type { OpenCopies } from '@/lib/openCopies';
import { Favicon } from '@/ui/components/Favicon';
import { anchorBelow, type MenuAnchor } from '@/ui/components/Menu';
import { SiteStrip } from '@/ui/components/WindowBits';
import { cx } from '@/ui/cx';
import { switchTo, type TabGroups } from '@/ui/openTabs';
import type { WindowInfo } from '@/ui/windows';
import { CopiesLine, WindowNameField } from '@/ui/components/WindowParts';
import { closeTab } from './actions';
import { PANEL_DRAG_TYPE, useDrag } from './drag';
import { PanelLabel } from './parts';

/**
 * "Open now" in the side panel (Fi-Panel): each window (this one first, open), its tabs (click to
 * switch, × to close, the active one highlighted, Chrome's tab groups as coloured labels), with
 * Fold and ⋯ (Fold into…, Tidy into groups, Rename window, Close the copies). Click a window's name
 * to rename it. Drag a tab onto a folder below to fold it there (or right-click it for a menu).
 */

/** A window with more tabs than this shows its first few, then "Show N more". */
const LONG_WINDOW = 10;
const FIRST_TABS = 3;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export interface OpenNowActions {
  onFold: (info: WindowInfo) => void;
  onMenu: (info: WindowInfo, anchor: MenuAnchor, button: HTMLElement) => void;
  onRename: (info: WindowInfo, name: string) => void;
  onCloseCopies: () => void;
  /** Right-click or Shift+F10 on an open tab: Fold this tab, Fold into…, Close. */
  onTabMenu: (tab: Browser.tabs.Tab, anchor: MenuAnchor, from: HTMLElement) => void;
}

function TabRow({ tab, onMenu }: { tab: Browser.tabs.Tab; onMenu: OpenNowActions['onTabMenu'] }) {
  const title = tab.title || tab.url || 'New tab';
  const url = tab.url || tab.pendingUrl || '';
  const dragging = useDrag((s) => s.dragged?.kind === 'open' && s.dragged.tab.id === tab.id);
  return (
    <div
      role="listitem"
      aria-current={tab.active ? 'page' : undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PANEL_DRAG_TYPE, String(tab.id));
        e.dataTransfer.setData('text/uri-list', url);
        e.dataTransfer.effectAllowed = 'move';
        useDrag.getState().start({ kind: 'open', tab });
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
        'group/tab flex h-7 items-center gap-2 rounded-md pr-[3px] pl-7',
        tab.active ? 'bg-accent-soft' : 'focus-within:bg-hover hover:bg-hover',
        dragging && 'opacity-40 outline-[1.5px] outline-offset-[-2px] outline-border-strong outline-dashed',
      )}
    >
      <button
        type="button"
        aria-label={`Switch to ${title}`}
        aria-keyshortcuts="Shift+F10"
        title={url}
        onClick={() => void switchTo(tab.id!, tab.windowId)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
      >
        <Favicon url={url} size={14} dim={tab.discarded} />
        <span dir="auto" className={cx('min-w-0 flex-1 truncate', tab.active && 'font-semibold')}>
          {title}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Close ${title}`}
        title="Close tab"
        onClick={() => closeTab(tab.id!)}
        className="hidden size-[22px] flex-none items-center justify-center rounded-md text-text-2 group-focus-within/tab:flex group-hover/tab:flex hover:bg-border hover:text-text"
      >
        <X size={13} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

function GroupBlock({ group, tabs, children }: { group: Browser.tabGroups.TabGroup | undefined; tabs: number; children: ReactNode }) {
  const color = group?.color ?? 'grey';
  const name = group?.title?.trim() || 'Group';
  return (
    <div role="group" aria-label={`Tab group ${name}, ${plural(tabs, 'tab')}`} className={cx('relative', `tf-cg-${color}`)}>
      <span aria-hidden className="absolute top-[13px] bottom-[7px] left-[18px] w-0.5 rounded-[1px]" style={{ background: 'var(--tf-cg)' }} />
      <div className="flex h-6 items-center gap-1.5 pl-7">
        <span
          dir="auto"
          className="inline-flex h-[18px] max-w-[60%] items-center truncate rounded-[5px] px-[7px] text-meta font-semibold"
          style={{ background: 'var(--tf-cg)', color: 'var(--tf-cg-on)' }}
        >
          {name}
        </span>
        <span className="text-meta text-text-3">{plural(tabs, 'tab')}</span>
      </div>
      {children}
    </div>
  );
}

/** A window's tabs, Chrome's tab groups as blocks. */
function WindowTabs({ info, groups, limit, onMenu }: { info: WindowInfo; groups: TabGroups; limit: number; onMenu: OpenNowActions['onTabMenu'] }) {
  const shown = info.tabs.slice(0, limit);
  const blocks: Array<{ groupId: number; tabs: Browser.tabs.Tab[] }> = [];
  for (const tab of shown) {
    const id = tab.groupId ?? -1;
    const last = blocks[blocks.length - 1];
    if (last && last.groupId === id && id >= 0) last.tabs.push(tab);
    else blocks.push({ groupId: id, tabs: [tab] });
  }
  return (
    <div role="list" aria-label={`Tabs in ${info.name}`}>
      {blocks.map((block) =>
        block.groupId >= 0 ? (
          <GroupBlock key={`g${block.groupId}:${block.tabs[0]!.id}`} group={groups.get(block.groupId)} tabs={info.tabs.filter((t) => t.groupId === block.groupId).length}>
            {block.tabs.map((tab) => (
              <TabRow key={tab.id} tab={tab} onMenu={onMenu} />
            ))}
          </GroupBlock>
        ) : (
          block.tabs.map((tab) => <TabRow key={tab.id} tab={tab} onMenu={onMenu} />)
        ),
      )}
    </div>
  );
}

function WindowBlock({
  info,
  groups,
  expanded,
  folding,
  menuOpen,
  renaming,
  hint,
  actions,
  onToggle,
  onRenaming,
}: {
  info: WindowInfo;
  groups: TabGroups;
  expanded: boolean;
  folding: boolean;
  menuOpen: boolean;
  renaming: boolean;
  hint?: ReactNode;
  actions: OpenNowActions;
  onToggle: () => void;
  onRenaming: (on: boolean) => void;
}) {
  const [all, setAll] = useState(false);
  const n = info.tabs.length;
  const activeAt = info.tabs.findIndex((t) => t.active);
  const limit = all || n <= LONG_WINDOW ? n : Math.max(FIRST_TABS, activeAt + 1);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const count = <span className="flex-none text-small text-text-3 tabular-nums">{plural(n, 'tab')}</span>;
  const canFold = info.folds && info.foldable.length > 0 && !folding;
  return (
    <section aria-label={`${info.name}, ${plural(n, 'tab')}`}>
      <div className="flex h-[34px] items-center gap-1.5 pr-0.5 pl-2">
        {renaming ? (
          <div className="flex h-full min-w-0 flex-1 items-center gap-1.5">
            <Chevron size={14} strokeWidth={2} aria-hidden className="flex-none text-text-3" />
            <WindowNameField
              info={info}
              onDone={(value) => {
                onRenaming(false);
                if (value !== null && value.trim() !== info.given) actions.onRename(info, value);
              }}
            />
            {count}
          </div>
        ) : (
          <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left">
            <Chevron size={14} strokeWidth={2} aria-hidden className="flex-none text-text-3" />
            <span
              title={info.incognito ? undefined : 'Click to rename'}
              onClick={(e) => {
                if (info.incognito) return;
                e.stopPropagation();
                onRenaming(true);
              }}
              className={cx('min-w-0 truncate font-semibold', !info.incognito && 'cursor-text')}
            >
              {info.name}
            </span>
            {count}
            <span className="flex-1" />
            {!expanded && <SiteStrip tabs={info.tabs} size={12} />}
          </button>
        )}
        {info.folds ? (
          <button
            type="button"
            disabled={!canFold}
            onClick={() => actions.onFold(info)}
            aria-label={`Fold ${info.name}, ${plural(info.foldable.length, 'tab')}`}
            title={info.foldable.length ? `Saves and closes its ${plural(info.foldable.length, 'tab')}` : 'Nothing to fold: only pinned, playing or new tab pages are open here.'}
            className="inline-flex h-6 flex-none items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2 text-small font-semibold text-text hover:bg-hover disabled:cursor-default disabled:text-text-3"
          >
            <Archive size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
            Fold
          </button>
        ) : (
          <span className="flex-none text-small text-text-3">Stays open</span>
        )}
        <button
          type="button"
          aria-label={`More for ${info.name}`}
          title={`More for ${info.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => actions.onMenu(info, anchorBelow(e.currentTarget), e.currentTarget)}
          className={cx(
            'inline-flex size-6 flex-none items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text',
            menuOpen && 'bg-hover text-text',
          )}
        >
          <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {renaming && (
        <p id="window-name-hint" className="m-0 mt-0.5 mb-1.5 pl-7 text-meta text-text-3">
          Enter to save · Esc to cancel
        </p>
      )}
      {!renaming && hint}
      {expanded && (
        <>
          <WindowTabs info={info} groups={groups} limit={limit} onMenu={actions.onTabMenu} />
          {limit < n && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="flex h-[26px] w-full items-center rounded-control pr-2 pl-7 text-left text-small text-text-3 hover:text-text"
            >
              Show {(n - limit).toLocaleString()} more
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function OpenNow({
  windows,
  groups,
  copies,
  folding,
  menuFor,
  renaming,
  hints,
  actions,
  onRenaming,
}: {
  windows: WindowInfo[];
  groups: TabGroups;
  copies: OpenCopies;
  folding: boolean;
  menuFor?: number;
  renaming: number | null;
  hints: ReadonlyMap<number, ReactNode>;
  actions: OpenNowActions;
  onRenaming: (windowId: number | null) => void;
}) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  if (windows.length === 0) return null;
  return (
    <section aria-label="Open now">
      <PanelLabel count={plural(windows.length, 'window')}>Open now</PanelLabel>
      {windows.map((info) => (
        <WindowBlock
          key={info.id}
          info={info}
          groups={groups}
          expanded={expanded[info.id] ?? info.current}
          folding={folding}
          menuOpen={menuFor === info.id}
          renaming={renaming === info.id}
          hint={hints.get(info.id)}
          actions={actions}
          onToggle={() => setExpanded((e) => ({ ...e, [info.id]: !(e[info.id] ?? info.current) }))}
          onRenaming={(on) => onRenaming(on ? info.id : null)}
        />
      ))}
      <CopiesLine copies={copies} onClose={actions.onCloseCopies} className="px-2" />
    </section>
  );
}
