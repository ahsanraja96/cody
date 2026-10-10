import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Archive, ArrowUpDown, Check, LayoutGrid, List } from 'lucide-react';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { plural } from '@/lib/format';
import { listLiveSessions, renameSession } from '@/lib/repo';
import type { SessionRecord } from '@/lib/types';
import { Button } from '@/ui/components/Button';
import { tagColor } from '@/ui/components/Chips';
import { Menu } from '@/ui/components/Menu';
import { showProInfo } from '@/ui/components/ProDialog';
import { useOpenWindows } from '@/ui/hooks';
import { ImportPanel } from '@/ui/ImportPanel';
import { duplicate, restoreSession, togglePin, trashWithUndo } from './actions';
import { openExportDialog, openRestoreDialog } from './flows';
import type { Route } from './router';
import { SessionCard, SessionListRow, sessionMenuItems } from './SessionCard';
import { TagsDialog } from './TagsDialog';
import { BackupBanner, LimitBanner } from './views/Banners';
import { BulkBar } from './views/BulkBar';
import { SelectBox, ToggleGroup } from './views/parts';

type Sort = 'recent' | 'name' | 'size';
type Layout = 'cards' | 'list';

const CARD_MIN = 300;
const GAP = 12;
const CARD_HEIGHT = 138;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SORT_LABELS: Record<Sort, string> = { recent: 'Recent', name: 'Name', size: 'Most tabs' };

function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are a convenience.
  }
}

type Row =
  | { type: 'header'; key: string; label: string; first: boolean }
  | { type: 'cards'; key: string; sessions: SessionRecord[] }
  | { type: 'item'; key: string; session: SessionRecord; last: boolean };

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable;
}

export function SessionsView({
  route,
  navigate,
  onSaveAll,
}: {
  route: Route;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  onSaveAll: () => void;
}) {
  const sessions = useLiveQuery(() => listLiveSessions(), []);
  const [sort, setSort] = useState<Sort>(() => readPref('tabfold.sort', 'recent', ['recent', 'name', 'size']));
  const [layout, setLayout] = useState<Layout>(() => readPref('tabfold.layout', 'cards', ['cards', 'list']));
  const [tagging, setTagging] = useState<SessionRecord[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [columns, setColumns] = useState(2);
  const [listTop, setListTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const limits = limitsFor(CURRENT_PLAN);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth - 48;
      setColumns(Math.max(1, Math.floor((width + GAP) / (CARD_MIN + GAP))));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [sessions === undefined, sessions?.length === 0]);

  // A new view starts with nothing selected.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [route.view, route.tag]);

  const filtered = useMemo(() => {
    let list = sessions ?? [];
    if (route.view === 'pinned') list = list.filter((s) => s.pinned);
    if (route.view === 'recent') list = list.filter((s) => Date.now() - s.updatedAt < WEEK_MS);
    if (route.view === 'tag' && route.tag) list = list.filter((s) => s.tags.includes(route.tag!));
    const sorted = [...list];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'size') sorted.sort((a, b) => b.tabCount - a.tabCount);
    return sorted;
  }, [sessions, route.view, route.tag, sort]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (layout === 'list') {
      filtered.forEach((session, i) => out.push({ type: 'item', key: session.id, session, last: i === filtered.length - 1 }));
      return out;
    }
    let groups: Array<{ label: string; sessions: SessionRecord[] }> = [{ label: '', sessions: filtered }];
    if (route.view === 'all' && sort === 'recent') {
      const now = Date.now();
      groups = [
        { label: 'Pinned', sessions: filtered.filter((s) => s.pinned) },
        { label: 'This week', sessions: filtered.filter((s) => !s.pinned && now - s.updatedAt < WEEK_MS) },
        { label: 'Earlier', sessions: filtered.filter((s) => !s.pinned && now - s.updatedAt >= WEEK_MS) },
      ].filter((g) => g.sessions.length > 0);
      if (groups.length === 1 && groups[0]!.label !== 'Pinned') groups[0]!.label = '';
    }
    for (const group of groups) {
      if (group.label) out.push({ type: 'header', key: `h-${group.label}`, label: group.label, first: out.length === 0 });
      for (let i = 0; i < group.sessions.length; i += columns) {
        out.push({ type: 'cards', key: `c-${group.label}-${i}-${columns}`, sessions: group.sessions.slice(i, i + columns) });
      }
    }
    return out;
  }, [filtered, layout, columns, route.view, sort]);

  // Rows sit below the header and banners; the virtualizer needs that offset.
  useLayoutEffect(() => {
    const top = listRef.current?.offsetTop ?? 0;
    if (top !== listTop) setListTop(top);
  });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === 'header' ? 40 : rows[index]?.type === 'cards' ? CARD_HEIGHT + GAP : 48),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 6,
    scrollMargin: listTop,
  });

  const flatOrder = useMemo(() => {
    const order: SessionRecord[] = [];
    for (const row of rows) {
      if (row.type === 'cards') order.push(...row.sessions);
      if (row.type === 'item') order.push(row.session);
    }
    return order;
  }, [rows]);

  const picked = useMemo(() => flatOrder.filter((s) => selected.has(s.id)), [flatOrder, selected]);
  const pickedTabs = picked.reduce((n, s) => n + s.tabCount, 0);

  const open = (id: string | undefined) => navigate({ ...route, sessionId: id }, { replace: true });
  const clearSelection = () => {
    setSelected(new Set());
    anchor.current = null;
  };
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  };
  const selectRange = (id: string) => {
    const from = flatOrder.findIndex((s) => s.id === anchor.current);
    const to = flatOrder.findIndex((s) => s.id === id);
    if (from < 0 || to < 0) return toggle(id);
    const [a, b] = from < to ? [from, to] : [to, from];
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of flatOrder.slice(a, b + 1)) next.add(s.id);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(flatOrder.map((s) => s.id)));

  const onItemClick = (session: SessionRecord) => (e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault();
      selectRange(session.id);
    } else if (e.metaKey || e.ctrlKey) {
      toggle(session.id);
    } else {
      open(session.id);
    }
  };
  const onCheck = (session: SessionRecord) => (e: React.MouseEvent) => (e.shiftKey ? selectRange(session.id) : toggle(session.id));

  const trashPicked = () => {
    const ids = picked.map((s) => s.id);
    if (!ids.length) return;
    void trashWithUndo(ids, ids.length === 1 ? `“${picked[0]!.name}”` : plural(ids.length, 'session'));
    if (route.sessionId && ids.includes(route.sessionId)) open(undefined);
    clearSelection();
  };

  const restorePicked = async () => {
    const ids = picked.map((s) => s.id);
    if (ids.length === 1) return openRestoreDialog(ids[0]!);
    for (const id of ids) await restoreSession(id, 'original');
  };

  // Arrows move between sessions; Delete moves to Trash (with Undo); ⌘/Ctrl+A selects all; Esc clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (isTyping(target) || target.closest?.('dialog,[role=menu],aside')) return;
      if (e.key === 'Escape') {
        if (selected.size) {
          e.preventDefault();
          clearSelection();
        } else if (route.sessionId) {
          open(undefined);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        if (!flatOrder.length) return;
        e.preventDefault();
        selectAll();
        return;
      }
      const index = flatOrder.findIndex((s) => s.id === route.sessionId);
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (picked.length) {
          e.preventDefault();
          trashPicked();
        } else if (index >= 0) {
          const session = flatOrder[index]!;
          void trashWithUndo([session.id], `“${session.name}”`);
          open(flatOrder[index + 1]?.id ?? flatOrder[index - 1]?.id);
        }
        return;
      }
      const step = layout === 'cards' ? columns : 1;
      let next = -1;
      if (e.key === 'ArrowRight' && layout === 'cards') next = index + 1;
      else if (e.key === 'ArrowLeft' && layout === 'cards') next = index - 1;
      else if (e.key === 'ArrowDown') next = index === -1 ? 0 : index + step;
      else if (e.key === 'ArrowUp') next = index - step;
      else return;
      if (next < 0 || next >= flatOrder.length) return;
      e.preventDefault();
      open(flatOrder[next]!.id);
      virtualizer.scrollToIndex(rows.findIndex((r) => (r.type === 'cards' ? r.sessions.some((s) => s.id === flatOrder[next]!.id) : r.type === 'item' && r.session.id === flatOrder[next]!.id)), { align: 'auto' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const menuFor = (session: SessionRecord) =>
    sessionMenuItems(session, {
      onRename: () => setRenamingId(session.id),
      onTags: () => setTagging([session]),
      onPin: () => togglePin(session.id, !session.pinned),
      onDuplicate: () => duplicate(session.id),
      onExport: () => openExportDialog([session.id]),
      onMerge: () => showProInfo('Merging sessions'),
      onTrash: () => {
        void trashWithUndo([session.id], `“${session.name}”`);
        if (route.sessionId === session.id) open(undefined);
      },
    });

  const itemProps = (session: SessionRecord) => ({
    session,
    current: session.id === route.sessionId,
    checked: selected.has(session.id),
    selecting: picked.length > 0,
    renaming: renamingId === session.id,
    onClick: onItemClick(session),
    onCheck: onCheck(session),
    onRestore: () => openRestoreDialog(session.id),
    onRenamed: (name: string | null) => {
      setRenamingId(null);
      if (name) void renameSession(session.id, name);
    },
    menu: menuFor(session),
  });

  const title = route.view === 'pinned' ? 'Pinned' : route.view === 'recent' ? 'Recent' : route.view === 'tag' ? (route.tag ?? '') : 'All sessions';
  const totalTabs = filtered.reduce((n, s) => n + s.tabCount, 0);
  const named = (sessions ?? []).filter((s) => s.kind !== 'unsorted').length;
  const allPicked = flatOrder.length > 0 && picked.length === flatOrder.length;

  if (sessions && sessions.length === 0) return <EmptyLibrary onSaveAll={onSaveAll} />;

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="scroll-thin relative h-full overflow-y-auto bg-bg-subtle">
        <div className={picked.length ? 'px-6 pt-5 pb-28' : 'px-6 pt-5 pb-8'}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-[200px] flex-1 items-baseline gap-2.5">
              {route.view === 'tag' && route.tag && (
                <span aria-hidden className="size-2.5 shrink-0 self-center rounded-full" style={{ background: tagColor(route.tag) }} />
              )}
              <h1 dir="auto" className="text-page font-semibold">
                {title}
              </h1>
              <span className="truncate text-text-3">
                {plural(filtered.length, 'session')} · {plural(totalTabs, 'tab')}
              </span>
            </div>
            <ToggleGroup
              label="View"
              value={layout}
              onChange={(v) => {
                setLayout(v);
                writePref('tabfold.layout', v);
              }}
              options={[
                { value: 'cards', label: <LayoutGrid size={16} aria-hidden />, ariaLabel: 'Card view' },
                { value: 'list', label: <List size={16} aria-hidden />, ariaLabel: 'List view' },
              ]}
            />
            <Menu
              label="Sort sessions"
              items={(Object.keys(SORT_LABELS) as Sort[]).map((value) => ({
                label: SORT_LABELS[value],
                icon: <Check size={14} aria-hidden className={value === sort ? 'text-accent-text' : 'invisible'} />,
                onSelect: () => {
                  setSort(value);
                  writePref('tabfold.sort', value);
                },
              }))}
              trigger={(props) => (
                <Button size="sm" className="gap-1.5 px-2.5 text-text-2" aria-label={`Sort sessions: ${SORT_LABELS[sort]}`} {...props}>
                  <ArrowUpDown size={14} aria-hidden />
                  {SORT_LABELS[sort]}
                </Button>
              )}
            />
          </div>

          <div className="flex flex-col gap-2.5 empty:hidden [&:not(:empty)]:mt-4">
            {Number.isFinite(limits.namedSessions) && <LimitBanner named={named} limit={limits.namedSessions} />}
            <BackupBanner />
          </div>

          {sessions === undefined ? (
            <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex h-[138px] flex-col gap-3 rounded-card border border-border bg-surface p-3.5">
                  <span className="h-2.5 w-3/5 rounded bg-skeleton" />
                  <span className="h-4 w-4/5 rounded bg-skeleton" />
                  <span className="h-2 w-2/5 rounded bg-skeleton" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="mt-5 rounded-card border border-dashed border-border-strong px-4 py-10 text-center text-text-2">
              {route.view === 'pinned'
                ? 'No pinned sessions yet. Pin one from its ⋯ menu to keep it at the top.'
                : route.view === 'recent'
                  ? 'Nothing saved or changed in the last 7 days.'
                  : route.view === 'tag'
                    ? `No sessions are tagged “${route.tag}” right now.`
                    : 'No sessions here yet.'}
            </p>
          ) : layout === 'list' ? (
            <div
              role="grid"
              aria-label="Sessions"
              aria-multiselectable="true"
              aria-rowcount={flatOrder.length + 1}
              className="@container mt-4 rounded-card border border-border bg-surface"
            >
              <div role="row" className="flex h-9 items-center gap-3 rounded-t-card border-b border-border bg-bg-subtle pr-3 pl-4">
                <span role="columnheader" className="flex w-6 shrink-0">
                  <SelectBox
                    checked={allPicked}
                    mixed={picked.length > 0 && !allPicked}
                    label={`Select all ${plural(flatOrder.length, 'session')}`}
                    onToggle={() => (allPicked ? clearSelection() : selectAll())}
                  />
                </span>
                <span role="columnheader" className="label-caps min-w-0 flex-1">
                  Session
                </span>
                <span role="columnheader" className="label-caps w-[200px] shrink-0 @max-[720px]:hidden">
                  Tags
                </span>
                <span role="columnheader" className="label-caps w-14 shrink-0 text-right">
                  Tabs
                </span>
                <span role="columnheader" className="label-caps w-[72px] shrink-0 text-right @max-[860px]:hidden">
                  Windows
                </span>
                <span role="columnheader" className="label-caps w-[184px] shrink-0 pl-4 @max-[980px]:hidden">
                  Sites
                </span>
                <span role="columnheader" className="label-caps w-24 shrink-0 text-right">
                  Updated
                </span>
                <span aria-hidden className="w-[104px] shrink-0" />
              </div>
              <div ref={listRef} role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const row = rows[item.index]!;
                  if (row.type !== 'item') return null;
                  return (
                    <div
                      key={item.key}
                      data-index={item.index}
                      ref={virtualizer.measureElement}
                      className="absolute inset-x-0 focus-within:z-20"
                      style={{ transform: `translateY(${item.start - listTop}px)` }}
                    >
                      <SessionListRow {...itemProps(row.session)} last={row.last} />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div ref={listRef} className="relative mt-5" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]!;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute inset-x-0 focus-within:z-20 hover:z-10"
                    style={{ transform: `translateY(${item.start - listTop}px)` }}
                  >
                    {row.type === 'header' ? (
                      <h2 className={row.first ? 'label-caps -mt-1 pb-2.5' : 'label-caps pt-3 pb-2.5'}>{row.label}</h2>
                    ) : row.type === 'cards' ? (
                      <div className="grid pb-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: GAP }}>
                        {row.sessions.map((session) => (
                          <SessionCard key={session.id} {...itemProps(session)} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {picked.length > 0 && (
        <BulkBar
          count={picked.length}
          tabs={pickedTabs}
          onRestore={() => void restorePicked()}
          onTag={() => setTagging(picked)}
          onExport={() => openExportDialog(picked.map((s) => s.id))}
          onMerge={() => showProInfo('Merging sessions')}
          onTrash={trashPicked}
          onClear={clearSelection}
        />
      )}
      <TagsDialog sessions={tagging} onClose={() => setTagging(null)} />
    </div>
  );
}

/** First run: nothing saved yet (States board). */
function EmptyLibrary({ onSaveAll }: { onSaveAll: () => void }) {
  const [importing, setImporting] = useState(false);
  const { windows } = useOpenWindows();
  const openTabs = windows.flatMap((w) => w.tabs).filter((t) => /^(https?|file):/.test(t.url || t.pendingUrl || '')).length;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto bg-bg-subtle px-6 py-12 text-center">
      <svg aria-hidden width="120" height="84" viewBox="0 0 120 84" className="mb-2">
        <rect x="22" y="0" width="76" height="14" rx="6" fill="var(--tf-border)" />
        <rect x="12" y="8" width="96" height="14" rx="6" fill="var(--tf-border-strong)" />
        <rect x="0.5" y="18.5" width="119" height="65" rx="10" fill="var(--tf-surface)" stroke="var(--tf-border-strong)" />
        <rect x="14" y="32" width="70" height="8" rx="4" fill="var(--tf-accent-soft)" />
        <rect x="14" y="46" width="90" height="8" rx="4" fill="var(--tf-hover)" />
        <rect x="14" y="60" width="55" height="8" rx="4" fill="var(--tf-hover)" />
      </svg>
      <h1 className="text-hero font-semibold">Your saved tabs will live here</h1>
      <p className="max-w-[420px] text-text-2">
        Save every open tab in one click. Each window becomes its own named group, and Chrome gets its memory back.
      </p>
      <Button variant="primary" size="lg" className="mt-2 h-11 px-5" icon={<Archive size={16} aria-hidden />} onClick={onSaveAll}>
        {openTabs > 0 ? `Save all ${plural(openTabs, 'open tab')}` : 'Save all open tabs'}
      </Button>
      <p className="mt-1 text-small text-text-3">
        Coming from OneTab or Session Buddy?{' '}
        <button type="button" className="font-semibold text-accent-text hover:underline" onClick={() => setImporting(true)}>
          Import your tabs
        </button>
      </p>
      {importing && (
        <div className="mt-4 w-full max-w-[560px] text-left">
          <ImportPanel onDone={() => setImporting(false)} />
        </div>
      )}
    </div>
  );
}
