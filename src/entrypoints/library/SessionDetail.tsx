import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, AppWindow, Check, ChevronDown, ChevronRight, Copy, ExternalLink, GripVertical, Hash, MoreHorizontal, Pin, Plus, X } from 'lucide-react';
import { formatDateTime, plural } from '@/lib/format';
import { suggestKeywords } from '@/lib/keywords';
import { send } from '@/lib/messages';
import { getSessionGraph, keywordVocabulary, moveTab, removeTabs, renameSession, renameWindow, setTabKeywords } from '@/lib/repo';
import { parseQuery, tokenize } from '@/lib/search/engine';
import type { TabRecord, WindowRecord } from '@/lib/types';
import { displayHost, MAX_URL_LENGTH } from '@/lib/urls';
import { Button, IconButton } from '@/ui/components/Button';
import { Checkbox } from '@/ui/components/Controls';
import { KeywordChip, TagChip } from '@/ui/components/Chips';
import { Favicon, SPECIAL_PAGE_LABEL, specialPage } from '@/ui/components/Favicon';
import { Highlight } from '@/ui/components/Highlight';
import { KeywordEditor } from '@/ui/components/KeywordEditor';
import { Menu } from '@/ui/components/Menu';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { copyText, useSettings } from '@/ui/hooks';
import { cancelRestore, duplicate, restoreSession, togglePin, trashWithUndo } from './actions';
import { TAB_DRAG_TYPE } from './dnd';
import { openExportDialog } from './flows/index';
import { useRestoreProgress, windowStatuses, type WindowRestoreStatus } from './flows/progress';
import { RestoreFailuresCard } from './flows/RestoreDialogs';
import { flows, useFlows } from './flows/store';
import { Tooltip } from './flows/Tooltip';
import { RestoreProgressBlock } from './RestoreProgress';
import { sessionMenuItems } from './SessionCard';
import { TagsDialog } from './TagsDialog';

type SavedWindow = WindowRecord & { tabs: TabRecord[] };

type Item =
  | { type: 'window'; window: SavedWindow; index: number; first: boolean; open: boolean }
  | { type: 'tab'; tab: TabRecord; windowId: string; last: boolean }
  | { type: 'editor'; tab: TabRecord; last: boolean }
  | { type: 'more'; windowId: string; hidden: number };

/** Rows shown per window before "Show N more". */
const INITIAL_ROWS = 5;

const PART_SAVED_TIP = `Address was longer than ${MAX_URL_LENGTH.toLocaleString()} characters; the first ${MAX_URL_LENGTH.toLocaleString()} were kept. It may not reopen exactly.`;

function TabKeywordEditor({ tab, onDone }: { tab: TabRecord; onDone: () => void }) {
  const [settings] = useSettings();
  const [keywords, setKeywords] = useState<string[]>(tab.keywords);
  const vocabulary = useLiveQuery(() => keywordVocabulary(16), []) ?? [];
  const suggestions = useMemo(
    () => (settings.suggestKeywords ? suggestKeywords(tab.title, tab.url) : []),
    [tab.title, tab.url, settings.suggestKeywords],
  );
  const save = async () => {
    await setTabKeywords(tab.id, keywords);
    onDone();
  };
  return (
    <div className="mx-2 my-2 rounded-card border border-accent-line bg-bg p-3">
      <KeywordEditor value={keywords} onChange={setKeywords} suggestions={suggestions} vocabulary={vocabulary} autoFocus compact onSubmit={save} />
      <div className="mt-3 flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" onClick={save}>
          Save keywords
        </Button>
      </div>
    </div>
  );
}

function markdownLinks(name: string, windows: SavedWindow[]): string {
  const body = windows
    .map((w, i) => [`## ${w.name || `Window ${i + 1}`}`, ...w.tabs.map((t) => `- [${t.title.replace(/[[\]]/g, '')}](${t.url})`)].join('\n'))
    .join('\n\n');
  return `# ${name}\n\n${body}\n`;
}

export function SessionDetail({
  sessionId,
  highlightQuery,
  overlay = false,
  onClose,
}: {
  sessionId: string;
  highlightQuery?: string;
  /** Narrow windows: a panel over the dimmed library instead of a column beside it. */
  overlay?: boolean;
  onClose: () => void;
}) {
  const graph = useLiveQuery(() => getSessionGraph(sessionId), [sessionId]);
  const [settings, updateSettings] = useSettings();
  const progress = useRestoreProgress();
  const failures = useFlows((s) => s.failures);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedAll, setExpandedAll] = useState<Record<string, boolean>>({});
  const [editingKeywords, setEditingKeywords] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [tagging, setTagging] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const terms = useMemo(() => (highlightQuery ? tokenize(parseQuery(highlightQuery).text) : []), [highlightQuery]);
  const queryKeywords = useMemo(() => {
    if (!highlightQuery) return [] as string[];
    const parsed = parseQuery(highlightQuery);
    return [...parsed.keywords, ...tokenize(parsed.text)];
  }, [highlightQuery]);

  const restoring = progress && progress.sessionId === sessionId ? progress : undefined;
  const statuses = useMemo(
    () => windowStatuses(graph?.windows.map((w) => ({ id: w.id, tabCount: w.tabs.length })) ?? [], restoring),
    [graph, restoring],
  );
  const myFailures = failures && failures.sessionId === sessionId ? failures : null;

  const items: Item[] = useMemo(() => {
    if (!graph) return [];
    const out: Item[] = [];
    graph.windows.forEach((window, index) => {
      const open = !collapsed[window.id];
      out.push({ type: 'window', window, index, first: index === 0, open });
      if (!open) return;
      const showAll = expandedAll[window.id] || window.tabs.length <= INITIAL_ROWS + 1 || !!highlightQuery;
      const tabs = showAll ? window.tabs : window.tabs.slice(0, INITIAL_ROWS);
      tabs.forEach((tab, i) => {
        const lastRow = showAll && i === tabs.length - 1;
        const editing = editingKeywords === tab.id;
        out.push({ type: 'tab', tab, windowId: window.id, last: lastRow && !editing });
        if (editing) out.push({ type: 'editor', tab, last: lastRow });
      });
      if (!showAll) out.push({ type: 'more', windowId: window.id, hidden: window.tabs.length - tabs.length });
    });
    return out;
  }, [graph, collapsed, expandedAll, editingKeywords, highlightQuery]);

  // The windows list shares the panel's scroll with the header above it.
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = scrollRef.current;
    if (!list || !scroller) return;
    const measure = () => setScrollMargin(list.offsetTop);
    measure();
    const observer = new ResizeObserver(measure);
    for (const child of [...scroller.children]) observer.observe(child);
    return () => observer.disconnect();
  }, [graph === undefined, graph === null]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = items[index];
      if (item?.type === 'window') return item.first ? 36 : 46;
      return item?.type === 'editor' ? 260 : item?.type === 'more' ? 30 : 32;
    },
    overscan: 8,
    scrollMargin,
  });

  // In the overlay, keyboard focus moves into the panel so Escape and Tab work from there.
  useEffect(() => {
    if (overlay) closeRef.current?.focus({ preventScroll: true });
  }, [overlay, sessionId]);

  const shell = cx(
    'flex shrink-0 flex-col border-l border-border bg-bg',
    overlay ? 'anim-in fixed inset-y-0 right-0 z-30 w-[min(440px,100vw)] shadow-pop' : 'w-[400px]',
  );
  const shellProps = overlay ? ({ role: 'dialog', 'aria-modal': false } as const) : {};

  if (graph === undefined) return <aside className={shell} aria-busy="true" {...shellProps} aria-label="Session details" />;
  if (graph === null) {
    return (
      <aside className={cx(shell, 'items-start gap-3 p-5')} {...shellProps} aria-label="Session details">
        <p className="text-text-2">This session no longer exists.</p>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </aside>
    );
  }

  const { session } = graph;
  const inTrash = session.deletedAt > 0;

  const onDropOn = async (e: React.DragEvent, target: { windowId: string; beforeTabId?: string }) => {
    setDropTarget(null);
    const tabId = e.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!tabId || tabId === target.beforeTabId) return;
    e.preventDefault();
    await moveTab(tabId, { windowId: target.windowId, beforeTabId: target.beforeTabId ?? null });
  };

  const allowDrop = (e: React.DragEvent, key: string) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget !== key) setDropTarget(key);
  };

  const commitName = () => {
    setEditingName(false);
    if (name.trim() && name.trim() !== session.name) renameSession(session.id, name);
  };

  const openTab = async (tab: TabRecord) => {
    try {
      const result = await send({ type: 'open-saved-tab', tabRecordId: tab.id, active: true });
      if (!result.opened && result.reason) toast(result.reason, { tone: 'error', action: { label: 'Copy link', onClick: () => void copyText(tab.url) } });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not open the tab.', { tone: 'error' });
    }
  };

  return (
    <aside
      aria-label={`Session details: ${session.name}`}
      className={shell}
      {...shellProps}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !editingKeywords && !editingName && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div ref={scrollRef} className={cx('scroll-thin relative min-h-0 flex-1 overflow-y-auto px-5 pb-6', overlay ? 'pt-3' : 'pt-4')}>
        <div className="flex flex-col gap-4 pb-4">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-meta text-text-3">
              {inTrash ? `In Trash · deleted ${formatDateTime(session.deletedAt)}` : `Saved ${formatDateTime(session.updatedAt).replace(/^Today/, 'today').replace(/^Yesterday/, 'yesterday')}`}
            </span>
            {!inTrash && (
              <Menu
                label={`Actions for ${session.name}`}
                items={sessionMenuItems(session, {
                  onRename: () => {
                    setName(session.name);
                    setEditingName(true);
                  },
                  onTags: () => setTagging(true),
                  onPin: () => togglePin(session.id, !session.pinned),
                  onDuplicate: () => duplicate(session.id),
                  onExport: () => openExportDialog([session.id]),
                  onTrash: () => {
                    void trashWithUndo([session.id], `“${session.name}”`);
                    onClose();
                  },
                })}
                trigger={(props) => (
                  <IconButton label="More session actions" size="lg" {...props}>
                    <MoreHorizontal size={18} aria-hidden />
                  </IconButton>
                )}
              />
            )}
            <IconButton ref={closeRef} label="Close details" size="lg" onClick={onClose}>
              <X size={18} aria-hidden />
            </IconButton>
          </div>

          <div className="flex flex-col gap-2">
            {editingName ? (
              <input
                autoFocus
                value={name}
                dir="auto"
                aria-label="Session name"
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName();
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditingName(false);
                  }
                }}
                className="h-9 rounded-control border border-accent bg-surface px-2 text-page font-semibold outline-none"
              />
            ) : (
              <h2 className="flex min-w-0 items-center gap-2 text-page font-semibold">
                <Tooltip content={<span dir="auto">{session.name}</span>}>
                  <button
                    type="button"
                    className="min-w-0 cursor-text truncate text-left disabled:cursor-default"
                    disabled={inTrash}
                    dir="auto"
                    aria-label={inTrash ? session.name : `${session.name}, click to rename`}
                    onClick={() => {
                      setName(session.name);
                      setEditingName(true);
                    }}
                  >
                    {session.name}
                  </button>
                </Tooltip>
                {session.pinned === 1 && <Pin size={14} aria-label="Pinned" className="shrink-0 text-text-3" />}
              </h2>
            )}
            <p className="text-text-2">
              {plural(session.tabCount, 'tab')} in {plural(session.windowCount, 'window')}
            </p>
            {!inTrash && (
              <div className="mt-0.5 flex flex-wrap gap-1.5">
                {session.tags.map((tag) => (
                  <TagChip key={tag} tag={tag} size="md" />
                ))}
                <button
                  type="button"
                  onClick={() => setTagging(true)}
                  className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed border-border-strong px-2 text-meta text-text-3 hover:bg-hover"
                >
                  <Plus size={11} strokeWidth={2} aria-hidden />
                  Tag
                </button>
              </div>
            )}
          </div>

          {!inTrash &&
            (restoring ? (
              <RestoreProgressBlock progress={restoring} onCancel={() => cancelRestore(restoring.restoreId)} />
            ) : (
              <div className="flex flex-col gap-2.5">
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    className="min-w-0 flex-1"
                    icon={<AppWindow size={16} aria-hidden />}
                    onClick={() => restoreSession(session.id, 'original')}
                  >
                    Restore as original windows
                  </Button>
                  <Button onClick={() => restoreSession(session.id, 'current')}>Into this window</Button>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Checkbox
                    checked={settings.afterRestore === 'keep'}
                    onChange={(keep) => updateSettings({ afterRestore: keep ? 'keep' : 'trash' })}
                  >
                    <span className="text-text-2">Keep session after restoring</span>
                  </Checkbox>
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-small font-semibold text-accent-text hover:bg-hover"
                    onClick={async () => {
                      if (await copyText(markdownLinks(session.name, graph.windows))) toast('Links copied as Markdown.');
                    }}
                  >
                    <Copy size={14} aria-hidden />
                    Copy links
                  </button>
                </div>
              </div>
            ))}
          {myFailures && !restoring && <RestoreFailuresCard failures={myFailures} onDismiss={() => flows().setFailures(null)} />}
        </div>

        <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = items[v.index]!;
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0"
                style={{ transform: `translateY(${v.start - scrollMargin}px)` }}
              >
                {item.type === 'window' ? (
                  <div className={item.first ? '' : 'pt-2.5'}>
                    <WindowHeader
                      window={item.window}
                      index={item.index}
                      collapsed={!item.open}
                      status={statuses.get(item.window.id) ?? null}
                      isDropTarget={dropTarget === `w:${item.window.id}`}
                      readOnly={inTrash}
                      onToggle={() => setCollapsed((c) => ({ ...c, [item.window.id]: !c[item.window.id] }))}
                      onOpen={() => restoreSession(session.id, 'original', item.window.id, true)}
                      onDragOver={(e) => allowDrop(e, `w:${item.window.id}`)}
                      onDragLeave={() => setDropTarget(null)}
                      onDrop={(e) => onDropOn(e, { windowId: item.window.id })}
                    />
                  </div>
                ) : item.type === 'more' ? (
                  <button
                    type="button"
                    onClick={() => setExpandedAll((e) => ({ ...e, [item.windowId]: true }))}
                    className="flex h-[30px] w-full items-center rounded-b-card border border-border bg-surface pr-2.5 pl-[52px] text-left text-small text-text-2 hover:bg-hover hover:text-text"
                  >
                    Show {item.hidden.toLocaleString()} more
                  </button>
                ) : item.type === 'editor' ? (
                  <div className={cx('border-x border-border bg-surface', item.last && 'rounded-b-card border-b pb-0.5')}>
                    <TabKeywordEditor tab={item.tab} onDone={() => setEditingKeywords(null)} />
                  </div>
                ) : (
                  <SavedTabRow
                    tab={item.tab}
                    last={item.last}
                    terms={terms}
                    queryKeywords={queryKeywords}
                    readOnly={inTrash}
                    editing={editingKeywords === item.tab.id}
                    isDropTarget={dropTarget === `t:${item.tab.id}`}
                    onEditKeywords={() => setEditingKeywords((id) => (id === item.tab.id ? null : item.tab.id))}
                    onOpen={() => openTab(item.tab)}
                    onRemove={async () => {
                      await removeTabs([item.tab.id]);
                      toast('Removed the tab from this session.');
                    }}
                    onDragOver={(e) => allowDrop(e, `t:${item.tab.id}`)}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(e) => onDropOn(e, { windowId: item.windowId, beforeTabId: item.tab.id })}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {tagging && <TagsDialog session={session} onClose={() => setTagging(false)} />}
    </aside>
  );
}

function StatusLabel({ status }: { status: WindowRestoreStatus }) {
  if (!status) return null;
  if (status.kind === 'opened') {
    return (
      <span className="inline-flex items-center gap-1 pr-1.5 text-meta text-green">
        <Check size={12} strokeWidth={2.2} aria-hidden />
        Opened
      </span>
    );
  }
  if (status.kind === 'opening') {
    return (
      <span className="pr-1.5 text-meta font-semibold text-accent-text">
        Opening {status.opened.toLocaleString()} of {status.total.toLocaleString()}
      </span>
    );
  }
  return <span className="pr-1.5 text-meta text-text-3">Up next</span>;
}

function WindowHeader({
  window,
  index,
  collapsed,
  status,
  isDropTarget,
  readOnly,
  onToggle,
  onOpen,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  window: SavedWindow;
  index: number;
  collapsed: boolean;
  status: WindowRestoreStatus;
  isDropTarget: boolean;
  readOnly: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [editing, setEditing] = useState(false);
  const label = window.name || `Window ${index + 1}`;
  const [draft, setDraft] = useState(label);
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== label) renameWindow(window.id, draft);
  };
  return (
    <div
      role="group"
      aria-label={`${label} window, ${plural(window.tabs.length, 'tab')}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cx(
        'flex h-9 items-center gap-1.5 border bg-surface pr-1.5 pl-1.5',
        collapsed ? 'rounded-card' : 'rounded-t-card',
        isDropTarget ? 'border-accent-line bg-accent-soft' : 'border-border',
      )}
    >
      <IconButton label={collapsed ? `Expand ${label}` : `Collapse ${label}`} aria-expanded={!collapsed} size="sm" tone="muted" onClick={onToggle}>
        {collapsed ? <ChevronRight size={14} strokeWidth={2} aria-hidden /> : <ChevronDown size={14} strokeWidth={2} aria-hidden />}
      </IconButton>
      {editing ? (
        <input
          autoFocus
          value={draft}
          dir="auto"
          aria-label="Window name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }}
          className="h-7 w-40 rounded-md border border-accent bg-surface px-1.5 font-semibold outline-none"
        />
      ) : (
        <button
          type="button"
          title={readOnly ? undefined : 'Click to rename'}
          disabled={readOnly}
          dir="auto"
          onClick={() => {
            setDraft(label);
            setEditing(true);
          }}
          className="min-w-0 cursor-text truncate font-semibold disabled:cursor-default"
        >
          {label}
        </button>
      )}
      <span className="shrink-0 text-text-3">· {plural(window.tabs.length, 'tab')}</span>
      <span className="flex-1" />
      {isDropTarget ? (
        <span className="pr-1.5 text-meta text-accent-text">Drop to move here</span>
      ) : status ? (
        <StatusLabel status={status} />
      ) : collapsed ? (
        <span aria-hidden className="mr-1.5 flex gap-[3px]">
          {window.tabs.slice(0, 3).map((t) => (
            <Favicon key={t.id} url={t.url} size={14} />
          ))}
        </span>
      ) : (
        !readOnly && (
          <button type="button" onClick={onOpen} className="h-[26px] rounded-md px-2 text-small text-text-2 hover:bg-hover hover:text-text">
            Open window
          </button>
        )
      )}
    </div>
  );
}

function SavedTabRow({
  tab,
  last,
  terms,
  queryKeywords,
  readOnly,
  editing,
  isDropTarget,
  onEditKeywords,
  onOpen,
  onRemove,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  tab: TabRecord;
  last: boolean;
  terms: string[];
  queryKeywords: string[];
  readOnly: boolean;
  editing: boolean;
  isDropTarget: boolean;
  onEditKeywords: () => void;
  onOpen: () => void;
  onRemove: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const shownKeywords = tab.keywords.slice(0, 2);
  const special = specialPage(tab.url);
  return (
    <div className={cx('border-x border-border bg-surface', last && 'rounded-b-card border-b')}>
      <div
        role="group"
        aria-label={tab.title}
        draggable={!readOnly}
        onDragStart={(e) => {
          e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
          e.dataTransfer.setData('text/uri-list', tab.url);
          e.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cx(
          'group relative flex h-8 items-center gap-2.5 pr-2.5 pl-[26px]',
          last && 'rounded-b-[9px]',
          editing ? 'bg-accent-soft' : 'hover:bg-hover focus-within:bg-hover',
          dragging && 'opacity-40',
        )}
      >
        {isDropTarget && <span aria-hidden className="absolute inset-x-2 -top-px h-0.5 rounded bg-accent" />}
        {!readOnly && (
          <span aria-hidden className="invisible absolute top-1/2 left-2 flex -translate-y-1/2 text-text-3 group-hover:visible">
            <GripVertical size={14} />
          </span>
        )}
        <Favicon url={tab.url} />
        <Tooltip
          content={
            <span className="flex flex-col gap-1">
              <span className="font-semibold" dir="auto">
                {tab.title}
              </span>
              <span className="font-mono text-meta break-all opacity-80">{tab.url}</span>
            </span>
          }
        >
          <button type="button" onClick={onOpen} dir="auto" className="min-w-0 flex-1 truncate text-left">
            <Highlight text={tab.title} terms={terms} />
          </button>
        </Tooltip>
        <span className="flex shrink-0 items-center gap-1 group-focus-within:hidden group-hover:hidden">
          {tab.urlTruncated && <PartSavedBadge />}
          {shownKeywords.length > 0 ? (
            <>
              {shownKeywords.map((k) => (
                <KeywordChip key={k} keyword={k} match={queryKeywords.some((q) => k === q || k.startsWith(q))} />
              ))}
              {tab.keywords.length > 2 && <span className="text-meta text-text-3">+{tab.keywords.length - 2}</span>}
            </>
          ) : special ? (
            <span className="inline-flex h-[18px] items-center rounded border border-border-strong px-1.5 text-meta font-semibold text-text-2">
              {SPECIAL_PAGE_LABEL[special]}
            </span>
          ) : (
            !tab.urlTruncated && <span className="max-w-[140px] truncate text-meta text-text-3">{displayHost(tab.url)}</span>
          )}
        </span>
        {!readOnly && (
          <span className="hidden shrink-0 items-center gap-1 group-focus-within:flex group-hover:flex">
            {tab.urlTruncated && <PartSavedBadge />}
            <IconButton label="Edit keywords" size="sm" onClick={onEditKeywords}>
              <Hash size={14} aria-hidden />
            </IconButton>
            <button
              type="button"
              onClick={onOpen}
              title="Open tab (keeps it saved)"
              className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2 text-meta font-semibold hover:bg-hover"
            >
              <ExternalLink size={12} strokeWidth={2} aria-hidden />
              Open tab
            </button>
            <IconButton label="Remove tab from session" size="sm" onClick={onRemove}>
              <X size={14} aria-hidden />
            </IconButton>
          </span>
        )}
      </div>
    </div>
  );
}

/** Amber "Saved in part" on a tab whose address was cut to 8,192 characters (Edge-Saving). */
function PartSavedBadge() {
  return (
    <Tooltip content={PART_SAVED_TIP} maxWidth={260}>
      <span
        tabIndex={0}
        aria-label={`Saved in part. ${PART_SAVED_TIP}`}
        className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded border border-amber-line bg-amber-soft px-1.5 text-meta font-semibold text-amber"
      >
        <AlertTriangle size={11} strokeWidth={2.2} aria-hidden />
        Saved in part
      </span>
    </Tooltip>
  );
}
