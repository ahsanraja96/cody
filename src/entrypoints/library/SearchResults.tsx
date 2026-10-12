import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AppWindow, ChevronDown, ChevronRight, Search, Tag } from 'lucide-react';
import type { SiteKinds } from '@/lib/categories';
import { send } from '@/lib/messages';
import type { SearchDoc, SearchHit } from '@/lib/search/engine';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { displayHost } from '@/lib/urls';
import { Kbd } from '@/ui/components/Chips';
import { Favicon } from '@/ui/components/Favicon';
import { ColorDot, FolderIcon } from '@/ui/components/FolderIcon';
import { Highlight } from '@/ui/components/Highlight';
import { IncognitoMark } from '@/ui/components/IncognitoMark';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { category } from '@/lib/categories';
import { isSnoozed, kindOf } from '@/ui/folders';
import { useTabSearch } from '@/ui/hooks';
import { matchingFolders, openHitsFirstHere, switchTo } from '@/ui/openTabs';
import { errorText } from './actions';
import { ago, count } from './format';

/** Rows a folded group shows before "Show N more". */
const FIRST_ROWS = 3;

interface Row {
  key: string;
  doc: SearchDoc;
  hit?: SearchHit;
  open: boolean;
}

interface Group {
  id: string;
  name: string;
  icon: ReactNode;
  /** The name matched the search (a folder): highlighted. */
  nameTerms?: string[];
  rows: Row[];
  open: boolean;
}

async function openRow(row: Row, background: boolean): Promise<void> {
  const doc = row.doc;
  if (row.open && doc.tabId !== undefined) {
    if (!(await switchTo(doc.tabId, doc.windowId))) toast('That tab was closed.', { tone: 'error' });
    return;
  }
  if (!doc.tabRecordId) return;
  try {
    const { opened, reason } = await send({ type: 'open-saved-tab', tabRecordId: doc.tabRecordId, active: !background });
    if (!opened) toast(reason ?? 'Chrome would not open this page.', { tone: 'error' });
    else if (background) toast('Opened in a background tab. It stays in the list.');
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

/** A folded tab as a search document (a matching folder's tabs that didn't match on their own). */
function savedDoc(tab: TabRecord): SearchDoc {
  return {
    id: `saved:${tab.id}`,
    kind: 'saved',
    title: tab.title || tab.url,
    url: tab.url,
    keywords: tab.keywords,
    favIconUrl: '',
    tabRecordId: tab.id,
    sessionId: tab.sessionId,
    savedAt: tab.savedAt,
    incognito: tab.incognito,
  };
}

/**
 * Search results replace the list while there is a query (Fi-Search): "17 results for “lisbon”",
 * then "Open now" with each tab's window and a Switch button, then the folded matches by folder
 * (folders whose name matches first) and kind of site, three rows each before "Show N more". ↑↓
 * move, ↵ switches to an open tab or opens a folded one, ⌘↵ opens in the background, Esc clears.
 */
export function SearchResults({
  query,
  openDocs,
  currentWindowId,
  tabs,
  folders,
  siteKinds,
  onClear,
  onActive,
  top,
  onShiftEnter,
}: {
  query: string;
  /** Open tabs with their window's name (`openSearchDocs`). */
  openDocs: SearchDoc[];
  currentWindowId?: number;
  tabs: TabRecord[];
  folders: readonly FolderRecord[];
  siteKinds: SiteKinds;
  scrollRef?: RefObject<HTMLElement | null>;
  onClear: () => void;
  onActive: (id: string | undefined) => void;
  /** Shown above the results: "Best matches" from Ask your tabs (Pro AI). */
  top?: ReactNode;
  /** Shift+Enter in the search box (Ask). */
  onShiftEnter?: () => void;
}) {
  const { result } = useTabSearch(query, openDocs, { limit: 1000 });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, number>>({});
  useEffect(() => {
    setCollapsed({});
    setShown({});
  }, [query]);

  const byId = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
  const groups = useMemo<Group[]>(() => {
    if (!result) return [];
    const out: Group[] = [];
    const open = openHitsFirstHere(result.open, currentWindowId);
    if (open.length) {
      out.push({
        id: 'open',
        name: 'Open now',
        icon: <AppWindow size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-text" />,
        rows: open.map((hit) => ({ key: hit.doc.id, doc: hit.doc, hit, open: true })),
        open: true,
      });
    }
    const terms = query.toLowerCase().split(/\s+/).filter((w) => w && !w.startsWith('#'));
    const named = matchingFolders(folders, query);
    const folderGroups = new Map<string, Group>();
    for (const folder of named) {
      const hits = new Map(result.saved.filter((h) => h.doc.tabRecordId && byId.get(h.doc.tabRecordId)?.folderId === folder.id).map((h) => [h.doc.tabRecordId!, h]));
      const inFolder = tabs.filter((t) => t.folderId === folder.id && !isSnoozed(t)).sort((a, b) => Number(hits.has(b.id)) - Number(hits.has(a.id)) || b.savedAt - a.savedAt);
      const group: Group = {
        id: `folder:${folder.id}`,
        name: folder.name,
        nameTerms: terms,
        icon: <FolderIcon color={folder.color} />,
        rows: inFolder.map((t) => ({ key: `saved:${t.id}`, doc: hits.get(t.id)?.doc ?? savedDoc(t), hit: hits.get(t.id), open: false })),
        open: false,
      };
      folderGroups.set(folder.id, group);
      out.push(group);
    }
    const others = new Map<string, Group>();
    for (const hit of result.saved) {
      const tab = hit.doc.tabRecordId ? byId.get(hit.doc.tabRecordId) : undefined;
      if (tab?.folderId && folderGroups.has(tab.folderId)) continue;
      const folder = tab?.folderId ? folders.find((f) => f.id === tab.folderId) : undefined;
      const kind = category(kindOf(tab ?? { url: hit.doc.url }, siteKinds));
      const id = folder ? `folder:${folder.id}` : `site:${kind.id}`;
      let group = others.get(id);
      if (!group) {
        group = {
          id,
          name: folder ? folder.name : kind.name,
          icon: folder ? <FolderIcon color={folder.color} /> : <ColorDot color={kind.color} />,
          rows: [],
          open: false,
        };
        others.set(id, group);
        out.push(group);
      }
      group.rows.push({ key: hit.doc.id, doc: hit.doc, hit, open: false });
    }
    return out;
  }, [result, currentWindowId, folders, query, byId, tabs, siteKinds]);

  // The rows on screen, in order: ↑↓ move over these.
  const options = useMemo(() => {
    const list: Array<{ row: Row; id: string }> = [];
    for (const group of groups) {
      if (collapsed[group.id]) continue;
      const limit = group.open ? group.rows.length : (shown[group.id] ?? FIRST_ROWS);
      group.rows.slice(0, limit).forEach((row) => list.push({ row, id: `result-${list.length}` }));
    }
    return list;
  }, [groups, collapsed, shown]);
  const optionIndex = useMemo(() => new Map(options.map((o, i) => [o.row.key, i])), [options]);

  const openCount = result?.open.length ?? 0;
  const foldedCount = groups.filter((g) => !g.open).reduce((n, g) => n + g.rows.length, 0);
  const total = openCount + foldedCount;

  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);
  const activeId = options[active] ? `result-${active}` : undefined;
  useEffect(() => onActive(activeId), [activeId, onActive]);
  useEffect(() => () => onActive(undefined), [onActive]);
  const listRef = useRef<HTMLDivElement>(null);

  const move = (to: number) => {
    if (!options.length) return;
    const next = Math.max(0, Math.min(options.length - 1, to));
    setActive(next);
    listRef.current?.querySelector(`#result-${next}`)?.scrollIntoView({ block: 'nearest' });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inBox = target instanceof HTMLInputElement && target.type === 'search';
      if (!inBox && !target.closest?.('[data-search-results]')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        move(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' && inBox && e.shiftKey && onShiftEnter) {
        e.preventDefault();
        onShiftEnter();
      } else if (e.key === 'Enter' && inBox && options[active]) {
        e.preventDefault();
        void openRow(options[active]!.row, e.metaKey || e.ctrlKey);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const trimmed = query.trim();
  if (result && groups.length === 0 && top) {
    // Ask your tabs answered; the word search found nothing, which is the usual case for a question.
    return (
      <>
        {top}
        <p role="status" className="m-0 px-2 text-small text-text-3">
          No tab has all of those words in its title or address.
        </p>
      </>
    );
  }
  if (result && groups.length === 0) {
    return (
      <div role="status" className="flex flex-col items-center gap-2 px-3 pt-16 pb-3 text-center">
        <Search size={24} strokeWidth={1.75} aria-hidden className="text-text-3" />
        <div className="text-section font-semibold">No tabs match “{trimmed}”</div>
        <p className="m-0 max-w-[320px] text-text-2">
          Searched {openDocs.length.toLocaleString()} open and {count(tabs.length, 'folded tab')} by title, address and keyword.
        </p>
        <div className="mt-1.5">
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-8 items-center rounded-control border border-border-strong bg-surface px-3.5 text-text hover:bg-hover"
          >
            Clear search
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2.5 px-0.5">
        <h1 className="m-0 truncate text-page leading-[1.45] font-semibold">
          {result ? `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'} for “${trimmed}”` : 'Search'}
        </h1>
        {result && (
          <span role="status" className="shrink-0 text-text-3">
            {openCount.toLocaleString()} open · {foldedCount.toLocaleString()} folded
          </span>
        )}
      </div>
      {top}
      <div ref={listRef} id="search-results" data-search-results role="listbox" aria-label={`Results for ${trimmed}`}>
        {groups.map((group, index) => {
          const isCollapsed = !!collapsed[group.id];
          const limit = group.open ? group.rows.length : (shown[group.id] ?? FIRST_ROWS);
          const visible = isCollapsed ? [] : group.rows.slice(0, limit);
          const hidden = isCollapsed ? 0 : group.rows.length - visible.length;
          return (
            <div key={group.id} role="group" aria-label={`${group.name}, ${count(group.rows.length, 'tab')}`} className={cx(index > 0 && 'border-t border-border')}>
              <h2 className="m-0 text-body font-semibold">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((c) => ({ ...c, [group.id]: !isCollapsed }))}
                  className="flex h-11 w-full items-center gap-2.5 px-2 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
                  ) : (
                    <ChevronDown size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
                  )}
                  {group.icon}
                  <span dir="auto" className="truncate">
                    {group.nameTerms ? <Highlight text={group.name} terms={group.nameTerms} /> : group.name}
                  </span>
                  <span className="shrink-0 font-normal text-text-3">{count(group.rows.length, 'tab')}</span>
                </button>
              </h2>
              {visible.map((row) => {
                const i = optionIndex.get(row.key) ?? -1;
                return (
                  <Result
                    key={row.key}
                    id={`result-${i}`}
                    row={row}
                    active={i === active}
                    onHover={() => setActive(i)}
                    onOpen={(background) => void openRow(row, background)}
                  />
                );
              })}
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => setShown((s) => ({ ...s, [group.id]: limit + 100 }))}
                  className="flex h-[30px] items-center rounded-control pr-2 pl-[62px] text-small text-text-2 hover:text-text hover:underline"
                >
                  Show {Math.min(hidden, 100).toLocaleString()} more
                </button>
              )}
              {!isCollapsed && <div className="h-2" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Result({ id, row, active, onHover, onOpen }: { id: string; row: Row; active: boolean; onHover: () => void; onOpen: (background: boolean) => void }) {
  const { doc, hit } = row;
  const terms = hit?.terms ?? [];
  const host = displayHost(doc.url);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-label={row.open ? `${doc.title}, open in ${doc.windowLabel ?? 'a window'}` : undefined}
      onMouseMove={onHover}
      onClick={(e) => onOpen(e.metaKey || e.ctrlKey)}
      className={cx('flex cursor-pointer items-center gap-2.5 rounded-control px-2', row.open ? 'h-9' : 'h-[34px]', active && 'bg-hover')}
    >
      <span className="w-4 shrink-0" />
      <Favicon url={doc.url} size={16} />
      <span className="ml-0.5 flex min-w-0 flex-1 items-center gap-2.5">
        <span dir="auto" className="min-w-0 truncate" title={doc.title}>
          <Highlight text={doc.title || doc.url} terms={terms} />
        </span>
        {doc.incognito && <IncognitoMark />}
        {row.open && (
          <span className="inline-flex shrink-0 items-center gap-[5px] text-small text-text-3">
            <AppWindow size={13} strokeWidth={1.75} aria-hidden />
            {doc.windowLabel}
          </span>
        )}
        {(hit?.matchedKeywords ?? []).slice(0, 3).map((keyword) => (
          <span
            key={keyword}
            title="Matched your keyword"
            className="inline-flex h-[18px] shrink-0 items-center gap-[3px] rounded bg-accent-soft px-1.5 text-meta font-semibold text-accent-text"
          >
            <Tag size={11} strokeWidth={2} aria-hidden />
            {keyword}
          </span>
        ))}
      </span>
      <span className="w-[180px] shrink-0 truncate text-small text-text-2 max-[720px]:hidden">
        <Highlight text={host} terms={terms} />
      </span>
      <span className="flex w-[110px] shrink-0 items-center justify-end gap-1.5 text-small text-text-3">
        {row.open ? (
          active && (
            <>
              <Kbd>↵</Kbd>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Switch to ${doc.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(false);
                }}
                className="inline-flex h-7 items-center rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover"
              >
                Switch
              </button>
            </>
          )
        ) : doc.savedAt ? (
          ago(doc.savedAt)
        ) : null}
      </span>
    </div>
  );
}
