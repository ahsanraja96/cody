import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Ellipsis, ExternalLink, RotateCcw, Trash, X } from 'lucide-react';
import { groupByCategory, type CategoryGroup, type CategoryId } from '@/lib/categories';
import type { TabRecord } from '@/lib/types';
import { displayHost } from '@/lib/urls';
import { Favicon } from '@/ui/components/Favicon';
import { IncognitoMark } from '@/ui/components/IncognitoMark';
import { cx } from '@/ui/cx';
import { modKey, useNow } from '@/ui/hooks';
import { openFolded, openGroup, removeGroup, removeOne, undoRemoval, useRemovals, type Removal } from './actions';
import { ago, count } from './format';

/** Rows a group shows before "Show N more". */
const FIRST_ROWS = 6;
/** The newest groups start open; the rest start collapsed. */
const OPEN_GROUPS = 2;

const SIZE = { head: 48, row: 34, more: 32, end: 8 } as const;

type Item =
  | { type: 'head'; key: string; group: CategoryGroup<TabRecord>; live: TabRecord[]; first: boolean; expanded: boolean }
  | { type: 'row'; key: string; tab: TabRecord }
  | { type: 'removed'; key: string; removal: Removal }
  | { type: 'more'; key: string; id: CategoryId; hidden: number }
  | { type: 'end'; key: string };

function sizeOf(item: Item): number {
  switch (item.type) {
    case 'head':
      return SIZE.head + (item.first ? 0 : 1);
    case 'row':
    case 'removed':
      return SIZE.row;
    case 'more':
      return SIZE.more;
    case 'end':
      return SIZE.end;
  }
}

export const SECONDARY_SM =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover';

/**
 * Every folded tab, grouped by kind of site (Min-List): groups ordered by their newest tab, newest
 * first inside a group, the two newest groups open. A slim index on the left jumps to a group. The
 * list is virtualised (only the rows on screen exist), so 10,000+ tabs scroll smoothly.
 */
export function GroupedList({ tabs, scrollRef }: { tabs: TabRecord[]; scrollRef: RefObject<HTMLElement | null> }) {
  const removals = useRemovals((s) => s.removals);
  const [expanded, setExpanded] = useState<Partial<Record<CategoryId, boolean>>>({});
  const [showAll, setShowAll] = useState<Partial<Record<CategoryId, boolean>>>({});
  const [menuFor, setMenuFor] = useState<CategoryId | null>(null);
  // Times ("2 min ago") refresh every minute.
  const now = useNow(true, 60_000);

  // Removed rows stay in place (as "Removed … · Undo") until their undo runs out.
  const { groups, liveIds } = useMemo(() => {
    const live = new Set(tabs.map((t) => t.id));
    const ghosts = [...removals.values()].filter((r) => !live.has(r.tab.id)).map((r) => r.tab);
    return { groups: groupByCategory([...tabs, ...ghosts], (t) => t.url, (t) => t.savedAt), liveIds: live };
  }, [tabs, removals]);

  const { items, heads } = useMemo(() => {
    const out: Item[] = [];
    const headIndex = new Map<CategoryId, number>();
    groups.forEach((group, index) => {
      const id = group.category.id;
      const live = group.items.filter((t) => liveIds.has(t.id));
      const isOpen = expanded[id] ?? index < OPEN_GROUPS;
      headIndex.set(id, out.length);
      out.push({ type: 'head', key: `h:${id}`, group, live, first: index === 0, expanded: isOpen });
      if (!isOpen) return;
      const visible = showAll[id] ? group.items : group.items.slice(0, FIRST_ROWS);
      for (const tab of visible) {
        const removal = removals.get(tab.id);
        out.push(removal ? { type: 'removed', key: `x:${tab.id}`, removal } : { type: 'row', key: tab.id, tab });
      }
      const hidden = group.items.length - visible.length;
      if (hidden > 0) out.push({ type: 'more', key: `m:${id}`, id, hidden });
      out.push({ type: 'end', key: `e:${id}` });
    });
    return { items: out, heads: headIndex };
  }, [groups, liveIds, expanded, showAll, removals]);

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

  // The group at the top of the screen is the current one in the index; scrolled to the end, the
  // last group whose header is on screen (short groups at the end can't reach the top).
  const scroller = scrollRef.current;
  const atEnd = !!scroller && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  const offset = (virtualizer.scrollOffset ?? 0) - listTop + (atEnd ? (scroller?.clientHeight ?? 0) - 48 : 32);
  let current: CategoryId | undefined = groups[0]?.category.id;
  for (const group of groups) {
    const index = heads.get(group.category.id) ?? 0;
    const start = virtualizer.measurementsCache[index]?.start;
    if (start !== undefined && start - listTop <= offset) current = group.category.id;
  }

  const jump = (id: CategoryId) => {
    setExpanded((e) => ({ ...e, [id]: true }));
    const index = heads.get(id);
    if (index !== undefined) requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: 'start' }));
  };

  // A click outside or Escape closes the group menu.
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && (e.target as HTMLElement).closest?.('[data-group-menu]')) return;
      setMenuFor(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuFor]);

  return (
    <>
      <nav aria-label="Jump to a group" className="sticky top-6 col-start-1 row-start-2 mt-[9px] flex w-44 flex-col gap-0.5 self-start max-[1319px]:hidden">
        {groups.map((group) => {
          const id = group.category.id;
          const head = items[heads.get(id) ?? -1];
          const n = head?.type === 'head' ? head.live.length : 0;
          const active = id === current;
          return (
            <a
              key={id}
              href={`#/`}
              aria-current={active ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault();
                jump(id);
              }}
              className={cx(
                'flex h-[30px] items-center gap-2.5 rounded-control px-2.5 no-underline hover:bg-hover',
                active ? 'bg-hover font-semibold text-text' : 'text-text-2',
              )}
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: `var(--cg-${group.category.color})` }} />
              <span className="min-w-0 flex-1 truncate">{group.category.name}</span>
              <span className="text-small font-normal text-text-3">{n.toLocaleString()}</span>
            </a>
          );
        })}
      </nav>

      <div ref={listRef} className="relative col-start-2 row-start-2" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const item = items[v.index]!;
          const menuOpen = item.type === 'head' && menuFor === item.group.category.id;
          return (
            <div
              key={v.key}
              className={cx('absolute inset-x-0 top-0', menuOpen ? 'z-20' : 'hover:z-10 focus-within:z-10')}
              style={{ transform: `translateY(${v.start - listTop}px)`, height: v.size }}
            >
              {item.type === 'head' ? (
                <GroupHead
                  item={item}
                  menuOpen={menuOpen}
                  onToggle={() => setExpanded((e) => ({ ...e, [item.group.category.id]: !item.expanded }))}
                  onMenu={(open) => setMenuFor(open ? item.group.category.id : null)}
                />
              ) : item.type === 'row' ? (
                <Row tab={item.tab} now={now} />
              ) : item.type === 'removed' ? (
                <RemovedRow removal={item.removal} />
              ) : item.type === 'more' ? (
                <button
                  type="button"
                  onClick={() => setShowAll((s) => ({ ...s, [item.id]: true }))}
                  className="flex h-8 items-center rounded-control pr-2 pl-[62px] text-small text-text-2 hover:text-text hover:underline"
                >
                  Show {item.hidden.toLocaleString()} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

function GroupHead({
  item,
  menuOpen,
  onToggle,
  onMenu,
}: {
  item: Extract<Item, { type: 'head' }>;
  menuOpen: boolean;
  onToggle: () => void;
  onMenu: (open: boolean) => void;
}) {
  const { group, live, expanded, first } = item;
  const name = group.category.name;
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Closing the menu with Escape (or after its action) puts focus back on ⋯.
  useEffect(() => {
    if (wasOpen.current && !menuOpen && (document.activeElement === document.body || !document.activeElement)) trigger.current?.focus();
    wasOpen.current = menuOpen;
  }, [menuOpen]);
  const n = live.length;
  const hosts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const tab of live) {
      const host = displayHost(tab.url);
      if (!seen.has(host)) seen.set(host, tab.url);
      if (seen.size >= 4) break;
    }
    return [...seen.values()];
  }, [live]);
  return (
    <div className={cx('flex h-12 items-center gap-2 px-2', !first && 'border-t border-border')}>
      <h2 className="m-0 flex h-full min-w-0 flex-1 text-body font-semibold">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          {expanded ? (
            <ChevronDown size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
          ) : (
            <ChevronRight size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
          )}
          <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: `var(--cg-${group.category.color})` }} />
          <span className="truncate">{name}</span>
          <span className="shrink-0 font-normal text-text-3">{count(n, 'tab')}</span>
        </button>
      </h2>
      {expanded ? (
        <>
          <button
            type="button"
            title={`Opens all ${count(n, 'tab')} in this window. They stay in the list.`}
            disabled={n === 0}
            onClick={() => void openGroup(live, group.category)}
            className={SECONDARY_SM}
          >
            Open all
          </button>
          <span className="relative flex" data-group-menu>
            <button
              ref={trigger}
              type="button"
              aria-label={`More for ${name}`}
              title={`More for ${name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => onMenu(!menuOpen)}
              className={cx(
                'inline-flex size-7 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text',
                menuOpen && 'bg-hover',
              )}
            >
              <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
            </button>
            {menuOpen && (
              <div role="menu" aria-label={`More for ${name}`} className="anim-in absolute top-[34px] right-0 z-30 w-[232px] rounded-card border border-border bg-surface p-1 shadow-pop">
                <button
                  type="button"
                  role="menuitem"
                  autoFocus
                  disabled={n === 0}
                  onClick={() => {
                    onMenu(false);
                    void removeGroup(live);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-red hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                >
                  <Trash size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
                  <span className="flex-1">
                    <span className="block font-semibold">Remove all {count(n, 'tab')}</span>
                    <span className="block text-meta text-text-3">You can undo for 10 seconds</span>
                  </span>
                </button>
              </div>
            )}
          </span>
        </>
      ) : (
        <span aria-hidden className="flex shrink-0 gap-[3px]">
          {hosts.map((url) => (
            <Favicon key={url} url={url} size={14} />
          ))}
        </span>
      )}
    </div>
  );
}

const Row = memo(function Row({ tab, now }: { tab: TabRecord; now: number }) {
  const title = tab.title || tab.url;
  return (
    <div className="tf-row flex h-[34px] items-center gap-2.5 rounded-control px-2 hover:bg-hover focus-within:bg-hover">
      <span className="w-4 shrink-0" />
      <button
        type="button"
        aria-label={`Open ${title}${tab.incognito ? ' in Incognito' : ''} (stays in the list)`}
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
          <button
            type="button"
            aria-label="Open in background"
            onClick={() => void openFolded(tab, false)}
            className="inline-flex size-7 items-center justify-center rounded-md text-text-2 hover:bg-border hover:text-text"
          >
            <ExternalLink size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <span role="tooltip">Open in background · {modKey}↵</span>
        </span>
        <button
          type="button"
          aria-label="Remove from list"
          title="Remove from list"
          onClick={() => void removeOne(tab)}
          className="inline-flex size-7 items-center justify-center rounded-md text-text-2 hover:bg-border hover:text-text"
        >
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
