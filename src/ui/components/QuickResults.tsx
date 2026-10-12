import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppWindow, Search, Tag } from 'lucide-react';
import { send } from '@/lib/messages';
import type { SiteKinds } from '@/lib/categories';
import type { SearchHit } from '@/lib/search/engine';
import type { SearchResponse } from '@/lib/search/protocol';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { displayHost } from '@/lib/urls';
import { cx } from '../cx';
import { kindName, kindOf } from '../folders';
import { matchingFolders, openHitsFirstHere, switchTo } from '../openTabs';
import { Favicon } from './Favicon';
import { FolderIcon } from './FolderIcon';
import { Highlight } from './Highlight';
import { IncognitoMark } from './IncognitoMark';

/**
 * Search in the popup and the side panel (Min-Popup-Search, Fi-Search): "Open now" first, this
 * window's tabs first, each with its window's name, then "Folded": folders whose name matches, then
 * folded tabs ("3 days ago · in Holiday in Lisbon", "2 weeks ago · Video"). ↑↓ move, ↵ switches to
 * an open tab or opens a folded one (it stays in the list), Esc clears.
 */

export interface SearchNav {
  move: (delta: number) => void;
  open: (background: boolean) => void;
}

export const RESULTS_ID = 'tf-results';
export const optionId = (index: number) => `tf-result-${index}`;

type Row = { type: 'hit'; hit: SearchHit; open: boolean } | { type: 'folder'; folder: FolderRecord; n: number };

function host(url: string) {
  return displayHost(url).replace(/^www\./, '');
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border-strong bg-surface px-[5px] text-meta text-text-2">
      {children}
    </kbd>
  );
}

function Label({ children, n }: { children: ReactNode; n: number }) {
  return (
    <div className="flex h-9 items-center gap-1.5 px-2">
      <h2 className="text-meta font-semibold tracking-[.04em] text-text-3 uppercase">{children}</h2>
      <span className="text-meta text-text-3 tabular-nums">· {n.toLocaleString()}</span>
    </div>
  );
}

/** "3 days ago" → "3 days ago"; "yesterday" → "Yesterday". */
function capital(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

export function QuickResults({
  query,
  result,
  openCount,
  folders,
  counts,
  tabs,
  siteKinds,
  currentWindowId,
  navRef,
  onActiveChange,
  onClear,
  onProblem,
  onDone,
  onOpenFolder,
  ago,
  footer = true,
}: {
  query: string;
  result: SearchResponse | null;
  openCount: number;
  folders: readonly FolderRecord[];
  /** Tabs in each folder. */
  counts: ReadonlyMap<string, number>;
  /** Folded tabs, to say which folder or kind of site a result is in. */
  tabs: readonly TabRecord[] | undefined;
  siteKinds: SiteKinds;
  currentWindowId?: number;
  navRef: React.MutableRefObject<SearchNav | null>;
  onActiveChange: (id: string | undefined) => void;
  onClear: () => void;
  /** A folded tab couldn't open: the page says why. */
  onProblem?: (reason: string) => void;
  /** After switching to a tab or opening one in front (the popup closes). */
  onDone?: () => void;
  /** ↵ on a folder: open its tabs. */
  onOpenFolder: (folder: FolderRecord) => void;
  /** "3 days ago". */
  ago: (timestamp: number) => string;
  footer?: boolean;
}) {
  const byId = useMemo(() => new Map((tabs ?? []).map((t) => [t.id, t])), [tabs]);
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const rows = useMemo<Row[]>(() => {
    if (!result) return [];
    const open = openHitsFirstHere(result.open, currentWindowId).map((hit): Row => ({ type: 'hit', hit, open: true }));
    const named = matchingFolders(folders, query).map((folder): Row => ({ type: 'folder', folder, n: counts.get(folder.id) ?? 0 }));
    const saved = result.saved.map((hit): Row => ({ type: 'hit', hit, open: false }));
    return [...open, ...named, ...saved];
  }, [result, currentWindowId, folders, query, counts]);
  const openRows = result ? result.open.length : 0;
  const folderRows = rows.filter((r) => r.type === 'folder').length;
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter((w) => w && !w.startsWith('#')), [query]);

  useEffect(() => setActive(0), [result]);
  useEffect(() => onActiveChange(rows.length ? optionId(Math.min(active, rows.length - 1)) : undefined), [active, rows, onActiveChange]);
  useEffect(() => () => onActiveChange(undefined), [onActiveChange]);

  const openRow = async (row: Row | undefined, background = false) => {
    if (!row) return;
    if (row.type === 'folder') {
      onOpenFolder(row.folder);
      return;
    }
    const doc = row.hit.doc;
    if (doc.kind === 'open' && doc.tabId !== undefined) {
      if (await switchTo(doc.tabId, doc.windowId)) onDone?.();
      else onProblem?.('That tab was closed.');
    } else if (doc.tabRecordId) {
      const answer = await send({ type: 'open-saved-tab', tabRecordId: doc.tabRecordId, active: !background, windowId: currentWindowId }).catch(
        () => undefined,
      );
      if (answer && !answer.opened) onProblem?.(answer.reason ?? 'Chrome wouldn’t open this page.');
      else if (!background) onDone?.();
    }
  };

  navRef.current = {
    move: (delta) => {
      if (!rows.length) return;
      const next = (active + delta + rows.length) % rows.length;
      setActive(next);
      listRef.current?.querySelector(`#${optionId(next)}`)?.scrollIntoView({ block: 'nearest' });
    },
    open: (background) => openRow(rows[active], background),
  };

  const total = result ? result.open.length + folderRows + result.savedTotal : 0;
  const current = rows[Math.min(active, rows.length - 1)];
  const switching = !!current && current.type === 'hit' && current.open;
  const foot = footer && (
    <footer className="flex h-11 flex-none items-center justify-between gap-3 border-t border-border bg-bg-subtle px-4 text-small text-text-3">
      <span className="inline-flex items-center gap-1.5">
        <Kbd>↵</Kbd>
        {switching ? 'switch' : 'open'}
        <span aria-hidden="true">·</span>
        <Kbd>esc</Kbd>clear
      </span>
      <span role="status" className="tabular-nums">
        {result ? `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}` : ''}
      </span>
    </footer>
  );

  if (result && rows.length === 0) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-6 pt-10 pb-3 text-center">
          <Search size={24} strokeWidth={1.75} aria-hidden className="text-text-3" />
          <div dir="auto" className="text-section font-semibold">
            No tabs match “{query.trim()}”
          </div>
          <p className="max-w-[320px] text-text-2">
            Searched {openCount.toLocaleString()} open and {result.indexedTabs.toLocaleString()} folded tabs by title, address and keyword.
          </p>
          <button
            type="button"
            onClick={onClear}
            className="mt-1.5 inline-flex h-8 items-center rounded-control border border-border-strong bg-surface px-3.5 hover:bg-hover"
          >
            Clear search
          </button>
        </div>
        {foot}
      </>
    );
  }

  const row = (r: Row, i: number) => {
    const on = i === active;
    if (r.type === 'folder') {
      return (
        <div
          key={`folder:${r.folder.id}`}
          id={optionId(i)}
          role="option"
          aria-selected={on}
          aria-label={`${r.folder.name}, folder, ${r.n} ${r.n === 1 ? 'tab' : 'tabs'}`}
          onMouseEnter={() => setActive(i)}
          onClick={() => void openRow(r)}
          className={cx('flex h-[46px] cursor-pointer items-center gap-2.5 rounded-control px-2', on && 'bg-hover')}
        >
          <FolderIcon color={r.folder.color} />
          <div className="min-w-0 flex-1">
            <div dir="auto" className="truncate font-semibold">
              <Highlight text={r.folder.name} terms={terms} />
            </div>
            <div className="text-meta text-text-3">
              Folder · {r.n.toLocaleString()} {r.n === 1 ? 'tab' : 'tabs'}
            </div>
          </div>
          {on && (
            <span className="inline-flex flex-none items-center gap-1.5 text-small text-text-3">
              <Kbd>↵</Kbd>open all
            </span>
          )}
        </div>
      );
    }
    const hit = r.hit;
    const doc = hit.doc;
    const keyword = hit.matchedKeywords[0];
    const tab = doc.tabRecordId ? byId.get(doc.tabRecordId) : undefined;
    const folder = tab?.folderId ? folderById.get(tab.folderId) : undefined;
    const where = r.open ? null : folder ? `in ${folder.name}` : tab ? kindName(kindOf(tab, siteKinds)) : host(doc.url);
    return (
      <div
        key={doc.id}
        id={optionId(i)}
        role="option"
        aria-selected={on}
        aria-label={r.open ? `${doc.title}, open in ${doc.windowLabel ?? 'a window'}` : undefined}
        onMouseEnter={() => setActive(i)}
        onClick={(e) => void openRow(r, e.metaKey || e.ctrlKey)}
        className={cx('flex h-[46px] cursor-pointer items-center gap-2.5 rounded-control px-2', on && 'bg-hover')}
      >
        <Favicon url={doc.url} size={16} dim={r.open && doc.discarded} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span dir="auto" className="min-w-0 truncate">
              <Highlight text={doc.title} terms={hit.terms} />
            </span>
            {doc.incognito && <IncognitoMark size={13} />}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-meta text-text-3">
            {r.open ? (
              <span className="flex min-w-0 items-center gap-1 truncate">
                <span className="truncate">
                  <Highlight text={host(doc.url)} terms={hit.terms} /> ·
                </span>
                <AppWindow size={11} strokeWidth={2} aria-hidden className="flex-none" />
                <span className="truncate">{doc.windowLabel}</span>
              </span>
            ) : (
              <span dir="auto" className="truncate">
                {doc.savedAt ? `${capital(ago(doc.savedAt))} · ` : ''}
                {where}
              </span>
            )}
            {keyword && (
              <span
                title="Matched your keyword"
                className="inline-flex h-[18px] flex-none items-center gap-[3px] rounded bg-accent-soft px-1.5 text-meta font-semibold text-accent-text"
              >
                <Tag size={11} strokeWidth={2} aria-hidden />
                {keyword}
              </span>
            )}
          </div>
        </div>
        {on && (
          <span className="inline-flex flex-none items-center gap-1.5 text-small text-text-3">
            <Kbd>↵</Kbd>
            {r.open ? 'switch' : 'open'}
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      <div
        ref={listRef}
        id={RESULTS_ID}
        role="listbox"
        aria-label={result ? `${total} results for ${query.trim()}` : 'Search results'}
        aria-busy={!result}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {openRows > 0 && (
          <div role="group" aria-label="Open now">
            <Label n={openRows}>Open now</Label>
            {rows.slice(0, openRows).map((r, i) => row(r, i))}
          </div>
        )}
        {openRows > 0 && rows.length > openRows && <div className="h-1.5" />}
        {rows.length > openRows && (
          <div role="group" aria-label="Folded">
            <Label n={folderRows + (result?.savedTotal ?? 0)}>Folded</Label>
            {rows.slice(openRows).map((r, i) => row(r, i + openRows))}
          </div>
        )}
      </div>
      {foot}
    </>
  );
}
