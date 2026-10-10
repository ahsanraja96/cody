import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ExternalLink, Lock, Search } from 'lucide-react';
import { db } from '@/lib/db';
import { plural, timeAgo } from '@/lib/format';
import { send } from '@/lib/messages';
import type { SearchHit } from '@/lib/search/engine';
import { displayUrl } from '@/lib/urls';
import { Button, IconButton } from '@/ui/components/Button';
import { Kbd, KeywordChip } from '@/ui/components/Chips';
import { Favicon } from '@/ui/components/Favicon';
import { Highlight } from '@/ui/components/Highlight';
import { showProInfo } from '@/ui/components/ProDialog';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { isMac, openDocsFrom, useOpenWindows, useTabSearch } from '@/ui/hooks';
import { clearLibrarySearch, lowerFirstRelative, ToggleGroup } from './views/parts';

const NO_OPEN_TABS: never[] = [];
const FILTERS = ['Tag', 'Date', 'Domain', 'Device', 'Window'] as const;

type Row = { type: 'header'; key: string; label: string; first: boolean } | { type: 'hit'; key: string; hit: SearchHit; option: number };

/** "Checkout app › Docs": the window each saved tab sits in, looked up for the rows on screen. */
function useWindowNames(tabRecordIds: string[]): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  const key = tabRecordIds.join('|');
  useEffect(() => {
    const missing = tabRecordIds.filter((id) => !names.has(id));
    if (!missing.length) return;
    let alive = true;
    (async () => {
      const tabs = (await db.tabs.bulkGet(missing)).filter((t) => !!t);
      const windows = await db.windows.bulkGet([...new Set(tabs.map((t) => t.windowId))]);
      const byId = new Map(windows.filter((w) => !!w).map((w) => [w.id, w.name.trim() || `Window ${w.order + 1}`]));
      if (!alive) return;
      setNames((prev) => {
        const next = new Map(prev);
        for (const tab of tabs) next.set(tab.id, byId.get(tab.windowId) ?? '');
        return next;
      });
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return names;
}

/**
 * Library search (Library-Search): open tabs first ("Open now"), then saved ones, with keyword
 * matches ranked first. Filters are Pro and shown locked; search itself is free and unlimited.
 */
export function SearchView({
  query,
  selectedId,
  onSelect,
}: {
  query: string;
  selectedId?: string;
  onSelect: (sessionId: string) => void;
}) {
  const [scope, setScope] = useState<'live' | 'trash'>('live');
  const { windows } = useOpenWindows();
  const ownOrigin = location.origin;
  const openDocs = useMemo(
    () => (scope === 'live' ? openDocsFrom(windows).filter((d) => !d.url.startsWith(ownOrigin)) : NO_OPEN_TABS),
    [windows, scope, ownOrigin],
  );
  const { result, searching } = useTabSearch(query, openDocs, { scope, limit: 5000 });
  const savedTabCount =
    useLiveQuery(async () => {
      const sessions = scope === 'trash' ? await db.sessions.where('deletedAt').above(0).toArray() : await db.sessions.where('deletedAt').equals(0).toArray();
      return sessions.reduce((n, s) => n + s.tabCount, 0);
    }, [scope]) ?? 0;

  const tabPlace = useMemo(() => {
    const map = new Map<number, string>();
    windows.forEach((w, wi) => w.tabs.forEach((t, ti) => t.id !== undefined && map.set(t.id, `${w.name || `Window ${wi + 1}`} · tab ${ti + 1}`)));
    return map;
  }, [windows]);

  const openHits = useMemo(() => (scope === 'live' ? (result?.open ?? []) : []), [result, scope]);
  const savedHits = useMemo(() => result?.saved ?? [], [result]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    let option = 0;
    if (openHits.length) {
      out.push({ type: 'header', key: 'h-open', label: `Open now · ${openHits.length}`, first: true });
      for (const hit of openHits) out.push({ type: 'hit', key: hit.doc.id, hit, option: option++ });
    }
    if (savedHits.length) {
      out.push({ type: 'header', key: 'h-saved', label: `${scope === 'trash' ? 'In Trash' : 'Saved'} · ${(result?.savedTotal ?? savedHits.length).toLocaleString()}`, first: out.length === 0 });
      for (const hit of savedHits) out.push({ type: 'hit', key: hit.doc.id, hit, option: option++ });
    }
    return out;
  }, [openHits, savedHits, result, scope]);
  const options = useMemo(() => rows.filter((r): r is Extract<Row, { type: 'hit' }> => r.type === 'hit'), [rows]);

  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query, scope]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [listTop, setListTop] = useState(0);
  useLayoutEffect(() => {
    const top = listRef.current?.offsetTop ?? 0;
    if (top !== listTop) setListTop(top);
  });
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === 'header' ? (rows[index]?.first ? 32 : 36) : 52),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 10,
    scrollMargin: listTop,
  });

  const visibleSaved = virtualizer
    .getVirtualItems()
    .map((item) => rows[item.index])
    .flatMap((row) => (row?.type === 'hit' && row.hit.doc.tabRecordId ? [row.hit.doc.tabRecordId] : []));
  const windowNames = useWindowNames(visibleSaved);

  const activate = async (hit: SearchHit, background = false) => {
    const doc = hit.doc;
    try {
      if (doc.kind === 'open' && doc.tabId !== undefined) {
        await browser.tabs.update(doc.tabId, { active: true });
        if (doc.windowId !== undefined) await browser.windows.update(doc.windowId, { focused: true });
      } else if (doc.tabRecordId && scope === 'live') {
        const { opened, reason } = await send({ type: 'open-saved-tab', tabRecordId: doc.tabRecordId, active: !background });
        if (!opened) toast(reason ?? 'Chrome would not open this page.', { tone: 'error' });
        else if (background) toast(`Opened in a background tab. It stays saved in ${doc.sessionName ?? 'its session'}.`);
      } else if (doc.sessionId) {
        onSelect(doc.sessionId);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not open the tab.', { tone: 'error' });
    }
  };

  const move = (to: number) => {
    if (!options.length) return;
    const next = Math.max(0, Math.min(options.length - 1, to));
    setActive(next);
    const rowIndex = rows.indexOf(options[next]!);
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
  };

  // ↑↓ move, ↵ opens, ⌘↵ opens in the background, Esc clears; from the search box or the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inList = !!target.closest?.('[data-search-results]');
      const inBox = target instanceof HTMLInputElement && target.type === 'search';
      if (!inList && !inBox && target !== document.body) return;
      if (target.closest?.('dialog,[role=menu],aside')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        move(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' && options[active]) {
        e.preventDefault();
        void activate(options[active]!.hit, e.metaKey || e.ctrlKey);
      } else if (e.key === 'Escape' && !inBox) {
        e.preventDefault();
        clearLibrarySearch();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const total = (result?.savedTotal ?? 0) + openHits.length;
  const trimmed = query.trim();
  const activeId = options[active] ? `search-option-${active}` : undefined;

  return (
    <div className="flex h-full flex-col">
      <div role="group" aria-label="Filters" className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg px-6 py-2">
        {FILTERS.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={`${name} filter, a Pro feature`}
            onClick={() => showProInfo('Search filters')}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-2.5 text-small text-text-3 hover:bg-hover hover:text-text-2"
          >
            {name}
            <Lock size={12} aria-hidden />
          </button>
        ))}
        <span className="ml-2 text-small text-text-3">Filters come with Pro. Search itself is free and unlimited.</span>
        <button type="button" className="text-small font-semibold text-accent-text hover:underline" onClick={() => showProInfo()}>
          See what Pro adds
        </button>
      </div>

      <div ref={scrollRef} className="scroll-thin relative min-h-0 flex-1 overflow-y-auto bg-bg-subtle">
        <div className="px-6 pt-5 pb-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-[200px] flex-1 items-baseline gap-2.5">
              <h1 className="text-page font-semibold">Search</h1>
              {result && trimmed && (
                <span className="truncate text-text-3">
                  {total === 1 ? '1 tab matches' : `${total.toLocaleString()} tabs match`} “{trimmed}”
                </span>
              )}
            </div>
            <ToggleGroup
              label="Where to search"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'live', label: 'Open & saved' },
                { value: 'trash', label: 'Trash' },
              ]}
            />
          </div>
          <p className="mt-1.5 text-small text-text-3">
            Keyword matches rank first. Tip: type <span className="font-semibold text-text-2">#{suggestKeyword(trimmed)}</span> to search keywords
            only.
          </p>

          {!result && searching && (
            <div className="mt-3 rounded-card border border-border bg-surface px-5 py-2" aria-busy="true">
              {[70, 82, 58, 76].map((w) => (
                <div key={w} className="flex items-center gap-3 py-3.5">
                  <span className="size-4 rounded bg-skeleton" />
                  <span className="h-2.5 rounded bg-skeleton" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
          )}

          {result && rows.length === 0 && (
            <div className="mt-3 flex flex-col items-center gap-2 rounded-card border border-border bg-surface px-6 py-12 text-center">
              <Search size={24} aria-hidden className="text-text-3" />
              <div className="text-section font-semibold">No tabs match “{trimmed}”</div>
              <p className="max-w-[440px] text-text-2">
                {scope === 'trash'
                  ? `Searched ${plural(savedTabCount, 'tab')} in Trash by title and address.`
                  : `Searched ${plural(openDocs.length, 'open tab')} and ${plural(savedTabCount, 'saved tab')} by title and address.`}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <Button size="sm" onClick={clearLibrarySearch}>
                  Clear search
                </Button>
                {scope === 'live' && (
                  <Button size="sm" variant="ghost" className="font-semibold text-accent-text hover:text-accent-text" onClick={() => setScope('trash')}>
                    Search in Trash
                  </Button>
                )}
              </div>
            </div>
          )}

          {rows.length > 0 && (
            <div
              data-search-results
              role="listbox"
              tabIndex={0}
              aria-label="Search results"
              aria-activedescendant={activeId}
              className="@container mt-3 rounded-card border border-border bg-surface px-2 pt-1 pb-2 focus-visible:outline-offset-0"
            >
              <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const row = rows[item.index]!;
                  return (
                    <div key={item.key} className="absolute inset-x-0" style={{ transform: `translateY(${item.start - listTop}px)`, height: item.size }}>
                      {row.type === 'header' ? (
                        <div role="presentation" className={cx('label-caps flex h-8 items-center px-3', !row.first && 'mt-1')}>
                          {row.label}
                        </div>
                      ) : (
                        <ResultRow
                          id={`search-option-${row.option}`}
                          hit={row.hit}
                          active={row.option === active}
                          current={!!row.hit.doc.sessionId && row.hit.doc.sessionId === selectedId}
                          place={
                            row.hit.doc.kind === 'open'
                              ? (tabPlace.get(row.hit.doc.tabId ?? -1) ?? row.hit.doc.windowLabel ?? '')
                              : [row.hit.doc.sessionName, windowNames.get(row.hit.doc.tabRecordId ?? '')].filter(Boolean).join(' › ')
                          }
                          canOpen={scope === 'live'}
                          onClick={() => {
                            setActive(row.option);
                            if (row.hit.doc.kind === 'open') void activate(row.hit);
                            else if (row.hit.doc.sessionId) onSelect(row.hit.doc.sessionId);
                          }}
                          onOpen={() => void activate(row.hit)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="flex h-10 shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-bg-subtle px-6 text-meta whitespace-nowrap text-text-3">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>Move
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd>Open
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>{isMac ? '⌘↵' : 'Ctrl+↵'}</Kbd>Open in background
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>esc</Kbd>Clear
        </span>
        <span className="flex-1" />
        <span className="truncate">Opening a saved tab keeps it in its session</span>
      </footer>
    </div>
  );
}

/** A keyword-like word from the query for the "#keyword" tip. */
function suggestKeyword(query: string): string {
  const word = query
    .split(/\s+/)
    .map((w) => w.replace(/^#/, '').toLowerCase().replace(/[^\p{L}\p{N}\-_.]/gu, ''))
    .find((w) => w.length > 1);
  return word ?? 'keyword';
}

function ResultRow({
  id,
  hit,
  active,
  current,
  place,
  canOpen,
  onClick,
  onOpen,
}: {
  id: string;
  hit: SearchHit;
  active: boolean;
  current: boolean;
  place: string;
  canOpen: boolean;
  onClick: () => void;
  onOpen: () => void;
}) {
  const doc = hit.doc;
  const isOpen = doc.kind === 'open';
  const others = doc.keywords.filter((k) => !hit.matchedKeywords.includes(k));
  const chips = [...hit.matchedKeywords.map((k) => ({ k, match: true })), ...others.map((k) => ({ k, match: false }))].slice(0, 3);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cx(
        'group flex h-[52px] cursor-pointer items-center gap-3 rounded-control px-3',
        active ? 'bg-accent-soft' : 'hover:bg-hover',
        current && 'shadow-[inset_3px_0_0_var(--tf-accent)]',
      )}
    >
      <Favicon url={doc.url} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div dir="auto" className="truncate" title={doc.title}>
          <Highlight text={doc.title} terms={hit.terms} />
        </div>
        <div className="truncate text-meta text-text-3" title={doc.url}>
          <Highlight text={displayUrl(doc.url)} terms={hit.terms} />
        </div>
      </div>
      <div className="flex w-60 shrink-0 items-center gap-1 overflow-hidden @max-[860px]:hidden">
        {chips.map(({ k, match }) => (
          <KeywordChip key={k} keyword={k} match={match} />
        ))}
        {!isOpen && chips.length === 0 && <span className="text-meta text-text-3">No keywords</span>}
      </div>
      <div className="flex w-[220px] min-w-0 shrink-0 flex-col gap-0.5 @max-[620px]:hidden">
        <div dir="auto" className="truncate text-small text-text-2">
          {place}
        </div>
        <div className="truncate text-meta text-text-3">
          {isOpen ? 'Open now' : doc.deleted ? 'In Trash' : doc.savedAt ? `Saved ${lowerFirstRelative(timeAgo(doc.savedAt))}` : 'Saved'}
        </div>
      </div>
      <span className="flex w-24 shrink-0 items-center justify-end">
        {isOpen ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-md px-1 text-small font-semibold text-accent-text',
              active ? 'visible' : 'invisible group-hover:visible',
            )}
          >
            Switch
            <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-accent-line px-1 text-meta">↵</kbd>
          </button>
        ) : (
          canOpen &&
          doc.tabRecordId && (
            <IconButton
              label="Open tab, keeps it saved"
              tabIndex={-1}
              className={cx('size-7 rounded-control', active ? 'visible' : 'invisible group-hover:visible')}
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
            >
              <ExternalLink size={14} aria-hidden />
            </IconButton>
          )
        )}
      </span>
    </div>
  );
}
