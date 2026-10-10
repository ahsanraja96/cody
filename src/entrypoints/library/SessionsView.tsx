import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Archive, ArrowUpDown, LayoutGrid, List } from 'lucide-react';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { listLiveSessions } from '@/lib/repo';
import { backup, limitBanner } from '@/lib/state';
import type { SessionRecord } from '@/lib/types';
import { Banner } from '@/ui/components/Banner';
import { Button } from '@/ui/components/Button';
import { Segmented, Select } from '@/ui/components/Controls';
import { plural } from '@/lib/format';
import { duplicate, exportSessions, restoreSession, togglePin, trashWithUndo } from './actions';
import type { Route } from './router';
import { SessionCard, SessionListRow, sessionMenuItems } from './SessionCard';
import { TagsDialog } from './TagsDialog';
import { ImportPanel } from '@/ui/ImportPanel';

type Sort = 'recent' | 'name' | 'size';
type Layout = 'cards' | 'list';

const CARD_MIN = 280;
const GAP = 12;
const CARD_HEIGHT = 142;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
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

type Row = { type: 'header'; label: string } | { type: 'cards'; sessions: SessionRecord[] } | { type: 'item'; session: SessionRecord };

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
  const [sort, setSort] = useState<Sort>(() => readPref('tabfold.sort', 'recent'));
  const [layout, setLayout] = useState<Layout>(() => readPref('tabfold.layout', 'cards'));
  const [tagging, setTagging] = useState<SessionRecord | null>(null);
  const [columns, setColumns] = useState(2);
  const [backupDue, setBackupDue] = useState(false);
  const [limitDismissed, setLimitDismissed] = useState(true);
  const [importing, setImporting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const limits = limitsFor(CURRENT_PLAN);

  useEffect(() => {
    backup.isDue().then(setBackupDue);
    limitBanner.dismissedAt().then((at) => setLimitDismissed(!!at && Date.now() - at < 7 * 24 * 60 * 60 * 1000));
    return backup.watchDue((v) => setBackupDue(v === true));
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth - 48;
      setColumns(Math.max(1, Math.floor((width + GAP) / (CARD_MIN + GAP))));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const filtered = useMemo(() => {
    let list = sessions ?? [];
    if (route.view === 'pinned') list = list.filter((s) => s.pinned);
    if (route.view === 'recent') list = list.filter((s) => Date.now() - s.updatedAt < RECENT_MS);
    if (route.view === 'tag' && route.tag) list = list.filter((s) => s.tags.includes(route.tag!));
    const sorted = [...list];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'size') sorted.sort((a, b) => b.tabCount - a.tabCount);
    return sorted;
  }, [sessions, route.view, route.tag, sort]);

  const rows: Row[] = useMemo(() => {
    const groups: Array<{ label: string; sessions: SessionRecord[] }> =
      route.view === 'all'
        ? [
            { label: 'Pinned', sessions: filtered.filter((s) => s.pinned) },
            { label: filtered.some((s) => s.pinned) ? 'Everything else' : '', sessions: filtered.filter((s) => !s.pinned) },
          ]
        : [{ label: '', sessions: filtered }];
    const out: Row[] = [];
    for (const group of groups) {
      if (group.sessions.length === 0) continue;
      if (group.label) out.push({ type: 'header', label: group.label });
      if (layout === 'cards') {
        for (let i = 0; i < group.sessions.length; i += columns) out.push({ type: 'cards', sessions: group.sessions.slice(i, i + columns) });
      } else {
        for (const session of group.sessions) out.push({ type: 'item', session });
      }
    }
    return out;
  }, [filtered, layout, columns, route.view]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === 'header' ? 40 : rows[index]?.type === 'cards' ? CARD_HEIGHT + GAP : 52),
    overscan: 6,
  });

  const flatOrder = useMemo(() => {
    const order: SessionRecord[] = [];
    for (const row of rows) {
      if (row.type === 'cards') order.push(...row.sessions);
      if (row.type === 'item') order.push(row.session);
    }
    return order;
  }, [rows]);

  const select = (id: string | undefined) => navigate({ ...route, sessionId: id }, { replace: true });

  // Arrow keys move between sessions; Delete moves the selected one to Trash (with Undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.closest('dialog,[role=menu]')) return;
      const index = flatOrder.findIndex((s) => s.id === route.sessionId);
      const step = layout === 'cards' ? columns : 1;
      let next = -1;
      if (e.key === 'ArrowRight') next = index + 1;
      else if (e.key === 'ArrowLeft') next = index - 1;
      else if (e.key === 'ArrowDown') next = index === -1 ? 0 : index + step;
      else if (e.key === 'ArrowUp') next = index - step;
      else if ((e.key === 'Delete' || e.key === 'Backspace') && index >= 0) {
        const session = flatOrder[index]!;
        trashWithUndo([session.id], `“${session.name}”`);
        select(flatOrder[index + 1]?.id ?? flatOrder[index - 1]?.id);
        return;
      } else if (e.key === 'Escape' && route.sessionId) {
        select(undefined);
        return;
      }
      if (next < 0 || next >= flatOrder.length) return;
      e.preventDefault();
      select(flatOrder[next]!.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const menuFor = (session: SessionRecord) =>
    sessionMenuItems(session, {
      onRename: () => select(session.id),
      onTags: () => setTagging(session),
      onPin: () => togglePin(session.id, !session.pinned),
      onDuplicate: () => duplicate(session.id),
      onExport: () => exportSessions([session.id]),
      onTrash: () => trashWithUndo([session.id], `“${session.name}”`),
    });

  const title =
    route.view === 'pinned' ? 'Pinned' : route.view === 'recent' ? 'Recent' : route.view === 'tag' ? `#${route.tag}` : 'All sessions';
  const totalTabs = filtered.reduce((n, s) => n + s.tabCount, 0);
  const named = (sessions ?? []).filter((s) => s.kind !== 'unsorted').length;
  const atLimit = named >= limits.namedSessions;

  if (sessions && sessions.length === 0) {
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
          Save all open tabs
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

  return (
    <div ref={scrollRef} className="scroll-thin h-full overflow-y-auto bg-bg-subtle">
      <div className="px-6 pt-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-[200px] flex-1 items-baseline gap-2.5">
            <h1 className="text-page font-semibold">{title}</h1>
            <span className="text-text-3">
              {plural(filtered.length, 'session')} · {plural(totalTabs, 'tab')}
            </span>
          </div>
          <Segmented
            label="Layout"
            value={layout}
            onChange={(v) => {
              setLayout(v);
              writePref('tabfold.layout', v);
            }}
            options={[
              { value: 'cards', label: <LayoutGrid size={16} aria-label="Cards" />, title: 'Cards' },
              { value: 'list', label: <List size={16} aria-label="List" />, title: 'List' },
            ]}
          />
          <span className="inline-flex items-center gap-1.5 text-text-2">
            <ArrowUpDown size={14} aria-hidden />
            <Select
              label="Sort sessions"
              value={sort}
              onChange={(v) => {
                setSort(v);
                writePref('tabfold.sort', v);
              }}
              options={[
                { value: 'recent', label: 'Recent' },
                { value: 'name', label: 'Name' },
                { value: 'size', label: 'Most tabs' },
              ]}
            />
          </span>
        </div>

        <div className="mt-4 flex flex-col gap-2.5">
          {atLimit && !limitDismissed && (
            <Banner
              tone="neutral"
              icon={null}
              title={`You've reached ${limits.namedSessions} named sessions`}
              actions={
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    limitBanner.dismiss();
                    setLimitDismissed(true);
                  }}
                >
                  Dismiss
                </Button>
              }
            >
              Everything you've saved stays here and keeps working. New saves go into “Unsorted” until you merge or delete a
              session. Pro (coming soon) removes the limit.
            </Banner>
          )}
          {backupDue && (
            <Banner
              tone="neutral"
              title="Time for a backup"
              actions={
                <>
                  <Button size="xs" variant="primary" onClick={() => exportSessions()}>
                    Export now
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => backup.setDue(false)}>
                    Not now
                  </Button>
                </>
              }
            >
              Chrome deletes extension data if Tabfold is removed. A monthly HTML export keeps your sessions safe.
            </Banner>
          )}
        </div>
      </div>

      {sessions === undefined ? (
        <div className="grid grid-cols-2 gap-3 px-6 pt-5" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex h-[142px] flex-col gap-3 rounded-card border border-border bg-surface p-3.5">
              <span className="h-2.5 w-3/5 rounded bg-skeleton" />
              <span className="h-4 w-4/5 rounded bg-skeleton" />
              <span className="h-2 w-2/5 rounded bg-skeleton" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="px-6 py-10 text-center text-text-2">No sessions here yet.</p>
      ) : (
        <div className="relative mx-6 mt-3 mb-8" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                className="absolute inset-x-0"
                style={{ transform: `translateY(${item.start}px)`, height: item.size }}
              >
                {row.type === 'header' ? (
                  <h2 className="flex h-10 items-end pb-2.5 label-caps">{row.label}</h2>
                ) : row.type === 'cards' ? (
                  <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: GAP, height: CARD_HEIGHT }}>
                    {row.sessions.map((session) => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        selected={session.id === route.sessionId}
                        onSelect={() => select(session.id)}
                        onRestore={() => restoreSession(session.id, 'original')}
                        menu={menuFor(session)}
                      />
                    ))}
                  </div>
                ) : (
                  <SessionListRow
                    session={row.session}
                    selected={row.session.id === route.sessionId}
                    onSelect={() => select(row.session.id)}
                    onRestore={() => restoreSession(row.session.id, 'original')}
                    menu={menuFor(row.session)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      <TagsDialog session={tagging} onClose={() => setTagging(null)} />
    </div>
  );
}
