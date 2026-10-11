import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, Tag } from 'lucide-react';
import { send } from '@/lib/messages';
import type { SearchHit } from '@/lib/search/engine';
import { displayHost } from '@/lib/urls';
import { Favicon } from '@/ui/components/Favicon';
import { IncognitoMark } from '@/ui/components/IncognitoMark';
import { Highlight } from '@/ui/components/Highlight';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { openDocsFrom, useTabSearch, type OpenWindow } from '@/ui/hooks';
import { errorText, switchToTab } from './actions';
import { ago, count } from './format';

type Row =
  | { type: 'header'; key: string; label: string; n: number; first: boolean }
  | { type: 'hit'; key: string; hit: SearchHit; option: number };

const HEADER = 36;
const GAP = 8;
const ROW = 40;

async function openHit(hit: SearchHit, background: boolean): Promise<void> {
  const doc = hit.doc;
  if (doc.kind === 'open' && doc.tabId !== undefined) {
    await switchToTab(doc.tabId, doc.windowId);
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

/**
 * Search results replace the list while there is a query: open tabs first (with Switch), then
 * folded tabs, matches highlighted and matched keywords as chips. ↑↓ move, ↵ opens, ⌘↵ opens in
 * the background, Esc clears.
 */
export function SearchResults({
  query,
  windows,
  foldedCount,
  scrollRef,
  onClear,
  onActive,
  top,
  onShiftEnter,
}: {
  query: string;
  windows: OpenWindow[];
  foldedCount: number;
  scrollRef: RefObject<HTMLElement | null>;
  onClear: () => void;
  onActive: (id: string | undefined) => void;
  /** Shown above the results: "Best matches" from Ask your tabs (Pro AI). */
  top?: ReactNode;
  /** Shift+Enter in the search box (Ask). */
  onShiftEnter?: () => void;
}) {
  const own = location.origin;
  const openDocs = useMemo(() => openDocsFrom(windows).filter((d) => !d.url.startsWith(own)), [windows, own]);
  const { result } = useTabSearch(query, openDocs, { limit: 1000 });

  const rows = useMemo(() => {
    const out: Row[] = [];
    let option = 0;
    const open = result?.open ?? [];
    const saved = result?.saved ?? [];
    if (open.length) {
      out.push({ type: 'header', key: 'h-open', label: 'Open tabs', n: open.length, first: true });
      for (const hit of open) out.push({ type: 'hit', key: hit.doc.id, hit, option: option++ });
    }
    if (saved.length) {
      out.push({ type: 'header', key: 'h-folded', label: 'Folded', n: result?.savedTotal ?? saved.length, first: out.length === 0 });
      for (const hit of saved) out.push({ type: 'hit', key: hit.doc.id, hit, option: option++ });
    }
    return out;
  }, [result]);
  const options = useMemo(() => rows.filter((r): r is Extract<Row, { type: 'hit' }> => r.type === 'hit'), [rows]);
  const total = (result?.open.length ?? 0) + (result?.savedTotal ?? 0);

  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);
  const activeId = options[active] ? `result-${active}` : undefined;
  useEffect(() => onActive(activeId), [activeId, onActive]);
  useEffect(() => () => onActive(undefined), [onActive]);

  const listRef = useRef<HTMLDivElement>(null);
  const [listTop, setListTop] = useState(0);
  useLayoutEffect(() => {
    const top = listRef.current?.offsetTop ?? 0;
    if (top !== listTop) setListTop(top);
  });
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === 'header' ? HEADER + (rows[i]?.first ? 0 : GAP) : ROW),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 12,
    scrollMargin: listTop,
  });

  const move = (to: number) => {
    if (!options.length) return;
    const next = Math.max(0, Math.min(options.length - 1, to));
    setActive(next);
    const index = rows.indexOf(options[next]!);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
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
        void openHit(options[active]!.hit, e.metaKey || e.ctrlKey);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const trimmed = query.trim();
  if (result && rows.length === 0) {
    return (
      <>
      {top}
      <div role="status" className={cx('flex flex-col items-center gap-2 px-3 pb-3 text-center', top ? 'pt-8' : 'pt-16')}>
        <Search size={24} strokeWidth={1.75} aria-hidden className="text-text-3" />
        <div className="text-section font-semibold">No tabs match “{trimmed}”</div>
        <p className="m-0 max-w-[320px] text-text-2">
          Searched {openDocs.length.toLocaleString()} open and {count(foldedCount, 'folded tab')} by title, address and keyword.
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
      </>
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2.5 px-0.5">
        <h1 className="m-0 text-page leading-[1.45] font-semibold">Search</h1>
        {result && (
          <span role="status" className="truncate text-text-3">
            {total === 1 ? '1 tab matches' : `${total.toLocaleString()} tabs match`} “{trimmed}”
          </span>
        )}
      </div>
      {top}
      <div
        ref={listRef}
        id="search-results"
        data-search-results
        role="listbox"
        aria-label={`Results for ${trimmed}`}
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index]!;
          return (
            <div key={v.key} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${v.start - listTop}px)`, height: v.size }}>
              {row.type === 'header' ? (
                <div role="presentation" className={cx('flex h-9 items-center gap-1.5 px-2', !row.first && 'mt-2')}>
                  <h2 className="label-caps m-0">{row.label}</h2>
                  <span className="text-meta text-text-3">· {row.n.toLocaleString()}</span>
                </div>
              ) : (
                <Result
                  id={`result-${row.option}`}
                  hit={row.hit}
                  active={row.option === active}
                  onHover={() => setActive(row.option)}
                  onOpen={(background) => void openHit(row.hit, background)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Result({
  id,
  hit,
  active,
  onHover,
  onOpen,
}: {
  id: string;
  hit: SearchHit;
  active: boolean;
  onHover: () => void;
  onOpen: (background: boolean) => void;
}) {
  const doc = hit.doc;
  const isOpen = doc.kind === 'open';
  const host = displayHost(doc.url);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={(e) => onOpen(e.metaKey || e.ctrlKey)}
      className={cx('flex h-10 cursor-pointer items-center gap-3 rounded-control px-2', active && 'bg-hover')}
    >
      <Favicon url={doc.url} size={16} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span dir="auto" className="min-w-0 truncate" title={doc.title}>
          <Highlight text={doc.title || doc.url} terms={hit.terms} />
        </span>
        {doc.incognito && <IncognitoMark />}
        {hit.matchedKeywords.slice(0, 3).map((keyword) => (
          <span
            key={keyword}
            title="Matched your keyword"
            className="inline-flex h-[18px] shrink-0 items-center gap-[3px] rounded px-1.5 text-meta font-semibold text-accent-text bg-accent-soft"
          >
            <Tag size={11} strokeWidth={2} aria-hidden />
            {keyword}
          </span>
        ))}
      </span>
      <span className="w-[180px] shrink-0 truncate text-small text-text-2 max-[720px]:hidden" title={isOpen ? doc.windowLabel : undefined}>
        <Highlight text={host} terms={hit.terms} />
      </span>
      <span className="flex w-24 shrink-0 items-center justify-end text-small text-text-3">
        {isOpen ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Switch to ${doc.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(false);
            }}
            className="inline-flex h-6 items-center rounded-md border border-border-strong bg-surface px-2 text-small font-semibold text-text hover:bg-hover"
          >
            Switch
          </button>
        ) : doc.savedAt ? (
          ago(doc.savedAt)
        ) : null}
      </span>
    </div>
  );
}
