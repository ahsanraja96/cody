import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Tag } from 'lucide-react';
import { send } from '@/lib/messages';
import type { SearchDoc, SearchHit } from '@/lib/search/engine';
import type { SearchResponse } from '@/lib/search/protocol';
import { displayHost } from '@/lib/urls';
import { Favicon } from '@/ui/components/Favicon';
import { Highlight } from '@/ui/components/Highlight';
import { cx } from '@/ui/cx';
import type { OpenWindow } from '@/ui/hooks';
import { Kbd, SectionLabel } from './parts';
import { longAgo, showTab } from './popupHooks';

/**
 * Search (Min-Popup-Search): one flat list over open and folded tabs, open ones first with
 * "Switch", matches highlighted, a keyword chip when a keyword matched. ↑↓ move, ↵ opens, esc clears.
 */

export interface SearchNav {
  move: (delta: number) => void;
  open: (background: boolean) => void;
}

export const RESULTS_ID = 'tf-results';
export const optionId = (index: number) => `tf-result-${index}`;

/** Open tabs as search documents, labelled "this window" or "window 2". */
export function openDocs(windows: OpenWindow[], currentWindowId: number | undefined): SearchDoc[] {
  return windows.flatMap((window, index) =>
    window.tabs
      .filter((t) => t.id !== undefined && (t.url || t.pendingUrl))
      .map((t) => ({
        id: `open:${t.id}`,
        kind: 'open' as const,
        title: t.title || displayHost(t.url || t.pendingUrl || ''),
        url: t.url || t.pendingUrl || '',
        keywords: [],
        favIconUrl: '',
        tabId: t.id,
        windowId: window.id,
        windowLabel: window.id === currentWindowId ? 'this window' : `window ${index + 1}`,
        discarded: t.discarded,
      })),
  );
}

function host(url: string) {
  return displayHost(url).replace(/^www\./, '');
}

export function SearchResults({
  query,
  result,
  openCount,
  navRef,
  onActiveChange,
  onClear,
}: {
  query: string;
  result: SearchResponse | null;
  openCount: number;
  navRef: React.MutableRefObject<SearchNav | null>;
  onActiveChange: (id: string | undefined) => void;
  onClear: () => void;
}) {
  const hits: SearchHit[] = useMemo(() => (result ? [...result.open, ...result.saved] : []), [result]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setActive(0), [result]);
  useEffect(() => onActiveChange(hits.length ? optionId(Math.min(active, hits.length - 1)) : undefined), [active, hits, onActiveChange]);
  useEffect(() => () => onActiveChange(undefined), [onActiveChange]);

  const openHit = async (hit: SearchHit | undefined, background = false) => {
    if (!hit) return;
    const doc = hit.doc;
    if (doc.kind === 'open' && doc.tabId !== undefined) {
      await showTab(doc.tabId, doc.windowId);
      window.close();
    } else if (doc.tabRecordId) {
      await send({ type: 'open-saved-tab', tabRecordId: doc.tabRecordId, active: !background }).catch(() => undefined);
      if (!background) window.close();
    }
  };

  navRef.current = {
    move: (delta) => {
      if (!hits.length) return;
      const next = (active + delta + hits.length) % hits.length;
      setActive(next);
      listRef.current?.querySelector(`#${optionId(next)}`)?.scrollIntoView({ block: 'nearest' });
    },
    open: (background) => openHit(hits[active], background),
  };

  const total = result ? result.open.length + result.savedTotal : 0;
  const footer = (
    <footer className="flex h-11 flex-none items-center justify-between gap-3 border-t border-border bg-bg-subtle px-4 text-small text-text-3">
      <span className="inline-flex items-center gap-1.5">
        <Kbd>↵</Kbd>open<span aria-hidden="true">·</span>
        <Kbd>esc</Kbd>clear
      </span>
      <span role="status" className="tabular-nums">
        {result ? `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}` : ''}
      </span>
    </footer>
  );

  if (result && hits.length === 0) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-6 pt-10 pb-3 text-center">
          <Search size={24} strokeWidth={1.75} aria-hidden className="text-text-3" />
          <div dir="auto" className="text-section font-semibold">
            No tabs match “{query.trim()}”
          </div>
          <p className="max-w-[320px] text-text-2">
            Searched {openCount.toLocaleString()} open and {result.indexedTabs.toLocaleString()} folded tabs by title, address
            and keyword.
          </p>
          <button
            type="button"
            onClick={onClear}
            className="mt-1.5 inline-flex h-8 items-center rounded-control border border-border-strong bg-surface px-3.5 hover:bg-hover"
          >
            Clear search
          </button>
        </div>
        {footer}
      </>
    );
  }

  let index = -1;
  const row = (hit: SearchHit) => {
    index += 1;
    const i = index;
    const doc = hit.doc;
    const isOpen = doc.kind === 'open';
    const keyword = hit.matchedKeywords[0];
    return (
      <div
        key={doc.id}
        id={optionId(i)}
        role="option"
        aria-selected={i === active}
        onMouseEnter={() => setActive(i)}
        onClick={(e) => openHit(hit, e.metaKey || e.ctrlKey)}
        className={cx('flex h-12 cursor-pointer items-center gap-2.5 rounded-control px-2', i === active && 'bg-hover')}
      >
        <Favicon url={doc.url} size={16} dim={isOpen && doc.discarded} />
        <div className="min-w-0 flex-1">
          <div dir="auto" className="truncate">
            <Highlight text={doc.title} terms={hit.terms} />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-meta text-text-3">
            <span className="truncate">
              <Highlight text={host(doc.url)} terms={hit.terms} />
              {isOpen ? ` · ${doc.windowLabel}` : doc.savedAt ? ` · ${longAgo(doc.savedAt)}` : ''}
            </span>
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
        {isOpen && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Switch to ${doc.title}`}
            onClick={(e) => {
              e.stopPropagation();
              void openHit(hit);
            }}
            className="inline-flex h-6 flex-none items-center rounded-md border border-border-strong bg-surface px-2 text-small font-semibold hover:bg-hover"
          >
            Switch
          </button>
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
        {result && result.open.length > 0 && (
          <div role="group" aria-label="Open tabs">
            <SectionLabel count={result.open.length}>Open tabs</SectionLabel>
            {result.open.map(row)}
          </div>
        )}
        {result && result.open.length > 0 && result.saved.length > 0 && <div className="h-2" />}
        {result && result.saved.length > 0 && (
          <div role="group" aria-label="Folded tabs">
            <SectionLabel count={result.savedTotal}>Folded</SectionLabel>
            {result.saved.map(row)}
          </div>
        )}
      </div>
      {footer}
    </>
  );
}
