import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GripVertical,
  Hash,
  MoreHorizontal,
  Pin,
  Plus,
  X,
} from 'lucide-react';
import { formatDateTime, plural } from '@/lib/format';
import { suggestKeywords } from '@/lib/keywords';
import { send } from '@/lib/messages';
import { getSessionGraph, keywordVocabulary, moveTab, removeTabs, renameSession, renameWindow, setTabKeywords } from '@/lib/repo';
import { parseQuery, tokenize } from '@/lib/search/engine';
import type { TabRecord, WindowRecord } from '@/lib/types';
import { displayHost } from '@/lib/urls';
import { Button, IconButton } from '@/ui/components/Button';
import { Checkbox } from '@/ui/components/Controls';
import { KeywordChip, TagChip } from '@/ui/components/Chips';
import { Favicon } from '@/ui/components/Favicon';
import { Highlight } from '@/ui/components/Highlight';
import { KeywordEditor } from '@/ui/components/KeywordEditor';
import { Menu } from '@/ui/components/Menu';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { copyText, useSettings } from '@/ui/hooks';
import { duplicate, exportSessions, restoreSession, togglePin, trashWithUndo } from './actions';
import { TAB_DRAG_TYPE } from './dnd';
import { sessionMenuItems } from './SessionCard';
import { TagsDialog } from './TagsDialog';

type Item =
  | { type: 'window'; window: WindowRecord & { tabs: TabRecord[] }; index: number }
  | { type: 'tab'; tab: TabRecord; windowId: string }
  | { type: 'editor'; tab: TabRecord }
  | { type: 'more'; windowId: string; hidden: number };

const INITIAL_ROWS = 12;

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
    <div className="mx-2 mb-2 rounded-card border border-accent-line bg-bg p-3">
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

export function SessionDetail({
  sessionId,
  highlightQuery,
  onClose,
}: {
  sessionId: string;
  highlightQuery?: string;
  onClose: () => void;
}) {
  const graph = useLiveQuery(() => getSessionGraph(sessionId), [sessionId]);
  const [settings, updateSettings] = useSettings();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedAll, setExpandedAll] = useState<Record<string, boolean>>({});
  const [editingKeywords, setEditingKeywords] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [tagging, setTagging] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const terms = useMemo(() => (highlightQuery ? tokenize(parseQuery(highlightQuery).text) : []), [highlightQuery]);
  const queryKeywords = useMemo(() => {
    if (!highlightQuery) return [] as string[];
    const parsed = parseQuery(highlightQuery);
    return [...parsed.keywords, ...tokenize(parsed.text)];
  }, [highlightQuery]);

  const items: Item[] = useMemo(() => {
    if (!graph) return [];
    const out: Item[] = [];
    graph.windows.forEach((window, index) => {
      out.push({ type: 'window', window, index });
      if (collapsed[window.id]) return;
      const showAll = expandedAll[window.id] || window.tabs.length <= INITIAL_ROWS + 2 || !!highlightQuery;
      const tabs = showAll ? window.tabs : window.tabs.slice(0, INITIAL_ROWS);
      for (const tab of tabs) {
        out.push({ type: 'tab', tab, windowId: window.id });
        if (editingKeywords === tab.id) out.push({ type: 'editor', tab });
      }
      if (!showAll) out.push({ type: 'more', windowId: window.id, hidden: window.tabs.length - tabs.length });
    });
    return out;
  }, [graph, collapsed, expandedAll, editingKeywords, highlightQuery]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = items[index];
      return item?.type === 'window' ? 44 : item?.type === 'editor' ? 260 : 32;
    },
    overscan: 8,
  });

  if (graph === undefined) {
    return <aside className="w-[440px] shrink-0 border-l border-border bg-bg" aria-busy="true" />;
  }
  if (graph === null) {
    return (
      <aside className="flex w-[440px] shrink-0 flex-col items-start gap-3 border-l border-border bg-bg p-5">
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

  return (
    <aside
      aria-label={`Session details: ${session.name}`}
      className="fixed inset-y-0 right-0 z-30 flex w-[min(440px,100vw)] shrink-0 flex-col border-l border-border bg-bg shadow-pop xl:static xl:z-auto xl:shadow-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !editingKeywords && !editingName) onClose();
      }}
    >
      <div className="flex flex-col gap-4 px-5 pt-4 pb-3">
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-meta text-text-3">
            {inTrash ? `In Trash · deleted ${formatDateTime(session.deletedAt)}` : `Saved ${formatDateTime(session.updatedAt)}`}
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
                onExport: () => exportSessions([session.id]),
                onTrash: () => {
                  trashWithUndo([session.id], `“${session.name}”`);
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
          <IconButton label="Close details" size="lg" onClick={onClose}>
            <X size={18} aria-hidden />
          </IconButton>
        </div>

        <div className="flex flex-col gap-2">
          {editingName ? (
            <input
              autoFocus
              value={name}
              aria-label="Session name"
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditingName(false);
                }
              }}
              className="h-9 rounded-control border border-accent bg-surface px-2 text-page font-semibold outline-none"
            />
          ) : (
            <h2 className="flex items-center gap-2 text-page font-semibold">
              <button
                type="button"
                title="Click to rename"
                className="min-w-0 cursor-text truncate text-left"
                disabled={inTrash}
                onClick={() => {
                  setName(session.name);
                  setEditingName(true);
                }}
              >
                {session.name}
              </button>
              {session.pinned === 1 && <Pin size={14} aria-label="Pinned" className="shrink-0 text-text-3" />}
            </h2>
          )}
          <p className="text-text-2">
            {plural(session.tabCount, 'tab')} in {plural(session.windowCount, 'window')}
          </p>
          {!inTrash && (
            <div className="flex flex-wrap gap-1.5">
              {session.tags.map((tag) => (
                <TagChip key={tag} tag={tag} size="md" />
              ))}
              <button
                type="button"
                onClick={() => setTagging(true)}
                className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed border-border-strong px-2 text-meta text-text-3 hover:bg-hover"
              >
                <Plus size={11} aria-hidden />
                Tag
              </button>
            </div>
          )}
        </div>

        {!inTrash && (
          <div className="flex flex-col gap-2.5">
            <div className="flex gap-2">
              <Button
                variant="primary"
                className="flex-1"
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
              <Button
                size="xs"
                variant="ghost"
                className="text-accent-text"
                icon={<Copy size={14} aria-hidden />}
                onClick={async () => {
                  const text = graph.windows
                    .map((w, i) => [`## ${w.name || `Window ${i + 1}`}`, ...w.tabs.map((t) => `- [${t.title.replace(/[[\]]/g, '')}](${t.url})`)].join('\n'))
                    .join('\n\n');
                  if (await copyText(`# ${session.name}\n\n${text}\n`)) toast('Links copied as Markdown.');
                }}
              >
                Copy links
              </Button>
            </div>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = items[v.index]!;
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0"
                style={{ transform: `translateY(${v.start}px)` }}
              >
                {item.type === 'window' ? (
                  <WindowHeader
                    window={item.window}
                    index={item.index}
                    collapsed={!!collapsed[item.window.id]}
                    isDropTarget={dropTarget === `w:${item.window.id}`}
                    readOnly={inTrash}
                    onToggle={() => setCollapsed((c) => ({ ...c, [item.window.id]: !c[item.window.id] }))}
                    onOpen={() => restoreSession(session.id, 'original', item.window.id, true)}
                    onDragOver={(e) => allowDrop(e, `w:${item.window.id}`)}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(e) => onDropOn(e, { windowId: item.window.id })}
                  />
                ) : item.type === 'more' ? (
                  <button
                    type="button"
                    onClick={() => setExpandedAll((e) => ({ ...e, [item.windowId]: true }))}
                    className="flex h-8 w-full items-center pl-[52px] text-left text-small text-text-2 hover:bg-hover"
                  >
                    Show {item.hidden} more
                  </button>
                ) : item.type === 'editor' ? (
                  <TabKeywordEditor tab={item.tab} onDone={() => setEditingKeywords(null)} />
                ) : (
                  <SavedTabRow
                    tab={item.tab}
                    terms={terms}
                    queryKeywords={queryKeywords}
                    readOnly={inTrash}
                    editing={editingKeywords === item.tab.id}
                    isDropTarget={dropTarget === `t:${item.tab.id}`}
                    onEditKeywords={() => setEditingKeywords((id) => (id === item.tab.id ? null : item.tab.id))}
                    onOpen={() => send({ type: 'open-saved-tab', tabRecordId: item.tab.id, active: true }).catch(() => undefined)}
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

function WindowHeader({
  window,
  index,
  collapsed,
  isDropTarget,
  readOnly,
  onToggle,
  onOpen,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  window: WindowRecord & { tabs: TabRecord[] };
  index: number;
  collapsed: boolean;
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
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cx(
        'mt-2 flex h-9 items-center gap-1.5 rounded-control border px-1.5',
        isDropTarget ? 'border-accent bg-accent-soft' : 'border-transparent',
      )}
    >
      <IconButton label={collapsed ? `Expand ${label}` : `Collapse ${label}`} aria-expanded={!collapsed} size="sm" tone="muted" onClick={onToggle}>
        {collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
      </IconButton>
      {editing ? (
        <input
          autoFocus
          value={draft}
          aria-label="Window name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
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
          onClick={() => {
            setDraft(label);
            setEditing(true);
          }}
          className="min-w-0 cursor-text truncate font-semibold"
        >
          {label}
        </button>
      )}
      <span className="shrink-0 text-text-3">· {plural(window.tabs.length, 'tab')}</span>
      <span className="flex-1" />
      {isDropTarget ? (
        <span className="pr-1.5 text-meta text-accent-text">Drop to move here</span>
      ) : (
        !readOnly && (
          <Button size="xs" variant="ghost" onClick={onOpen}>
            Open window
          </Button>
        )
      )}
    </div>
  );
}

function SavedTabRow({
  tab,
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
  const shownKeywords = tab.keywords.slice(0, 3);
  return (
    <div
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
        'group relative flex h-8 items-center gap-2 rounded-md pr-1 pl-1',
        editing ? 'bg-accent-soft' : 'hover:bg-hover focus-within:bg-hover',
        dragging && 'opacity-40',
      )}
    >
      {isDropTarget && <span aria-hidden className="absolute inset-x-2 -top-px h-0.5 rounded bg-accent" />}
      <span aria-hidden className={cx('flex w-4 shrink-0 justify-center text-text-3', readOnly ? 'invisible' : 'invisible group-hover:visible')}>
        <GripVertical size={14} />
      </span>
      <Favicon url={tab.url} />
      <button
        type="button"
        onClick={onOpen}
        title={`${tab.title}\n${tab.url}${tab.urlTruncated ? '\n(address was too long and was shortened)' : ''}`}
        className="min-w-0 flex-1 truncate text-left"
      >
        <Highlight text={tab.title} terms={terms} />
      </button>
      <span className="flex shrink-0 items-center gap-1 group-focus-within:hidden group-hover:hidden">
        {shownKeywords.length > 0 ? (
          <>
            {shownKeywords.map((k) => (
              <KeywordChip key={k} keyword={k} match={queryKeywords.some((q) => k === q || k.startsWith(q))} />
            ))}
            {tab.keywords.length > 3 && <span className="text-meta text-text-3">+{tab.keywords.length - 3}</span>}
          </>
        ) : (
          <span className="text-meta text-text-3">{displayHost(tab.url)}</span>
        )}
      </span>
      {!readOnly && (
        <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
          <IconButton label="Edit keywords" size="sm" onClick={onEditKeywords}>
            <Hash size={14} aria-hidden />
          </IconButton>
          <IconButton label="Open tab (keeps it saved)" size="sm" onClick={onOpen}>
            <ExternalLink size={14} aria-hidden />
          </IconButton>
          <IconButton label="Remove from session" size="sm" onClick={onRemove}>
            <X size={14} aria-hidden />
          </IconButton>
        </span>
      )}
    </div>
  );
}
