import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { ArrowRight, ExternalLink, Pause, Search } from 'lucide-react';
import { timeAgo } from '@/lib/format';
import { send } from '@/lib/messages';
import { openLibrary } from '@/lib/openLibrary';
import type { SearchHit } from '@/lib/search/engine';
import { displayHost, displayUrl } from '@/lib/urls';
import { Favicon } from '@/ui/components/Favicon';
import { Highlight } from '@/ui/components/Highlight';
import { KeywordChip, Kbd } from '@/ui/components/Chips';
import { IconButton } from '@/ui/components/Button';
import { cx } from '@/ui/cx';
import { openDocsFrom, useTabSearch, type OpenWindow } from '@/ui/hooks';

export interface SearchNav {
  move: (delta: number) => void;
  open: (background: boolean) => void;
}

const POPUP_SAVED_LIMIT = 30;

/** The word to show in the "#keyword" hint: the first word typed, when it could be a keyword. */
function hashWord(query: string): string {
  const word = query.trim().replace(/^#/, '').split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,30}$/u.test(word) ? word : 'keyword';
}

export function SearchResults({
  query,
  windows,
  navRef,
  onClear,
}: {
  query: string;
  windows: OpenWindow[];
  navRef: React.MutableRefObject<SearchNav | null>;
  onClear: () => void;
}) {
  const docs = useMemo(() => openDocsFrom(windows), [windows]);
  const { result, searching } = useTabSearch(query, docs, { limit: POPUP_SAVED_LIMIT });
  const hits: SearchHit[] = useMemo(() => (result ? [...result.open, ...result.saved] : []), [result]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setActive(0), [result]);

  const openHit = async (hit: SearchHit | undefined, background = false) => {
    if (!hit) return;
    if (hit.doc.kind === 'open' && hit.doc.tabId !== undefined) {
      await browser.tabs.update(hit.doc.tabId, { active: true });
      if (hit.doc.windowId !== undefined) await browser.windows.update(hit.doc.windowId, { focused: true });
      window.close();
    } else if (hit.doc.tabRecordId) {
      await send({ type: 'open-saved-tab', tabRecordId: hit.doc.tabRecordId, active: !background }).catch(() => undefined);
      if (!background) window.close();
    }
  };

  navRef.current = {
    move: (delta) => {
      if (!hits.length) return;
      const next = (active + delta + hits.length) % hits.length;
      setActive(next);
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    },
    open: (background) => openHit(hits[active], background),
  };

  if (!result && searching) {
    return (
      <div className="flex-1 px-4 py-4" aria-busy="true">
        {[78, 64, 86, 52].map((w) => (
          <div key={w} className="flex items-center gap-2.5 py-3">
            <span className="size-4 rounded bg-skeleton" />
            <span className="h-2.5 rounded bg-skeleton" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    );
  }

  if (result && hits.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center gap-2 px-6 py-10 text-center">
        <Search size={24} aria-hidden className="text-text-3" />
        <div className="text-section font-semibold">No tabs match “{query.trim()}”</div>
        <p className="text-text-2">
          Searched {docs.length.toLocaleString()} open and {result.indexedTabs.toLocaleString()} saved tabs by title, address and
          keyword.
        </p>
        <button type="button" onClick={onClear} className="mt-1 h-8 rounded-control border border-border-strong px-3 hover:bg-hover">
          Clear search
        </button>
      </div>
    );
  }

  let index = -1;
  const row = (hit: SearchHit) => {
    index += 1;
    const i = index;
    const doc = hit.doc;
    const isOpen = doc.kind === 'open';
    return (
      <div
        key={doc.id}
        role="option"
        aria-selected={i === active}
        data-index={i}
        onMouseEnter={() => setActive(i)}
        onClick={(e) => openHit(hit, e.metaKey || e.ctrlKey)}
        className={cx(
          'group flex min-h-12 cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5',
          i === active ? 'bg-accent-soft' : 'hover:bg-hover',
        )}
      >
        <Favicon url={doc.url} dim={doc.discarded} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="truncate">
            <Highlight text={doc.title} terms={hit.terms} />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-meta text-text-3">
            {hit.matchedKeywords.slice(0, 2).map((k) => (
              <KeywordChip key={k} keyword={k} match />
            ))}
            {doc.keywords
              .filter((k) => !hit.matchedKeywords.includes(k))
              .slice(0, hit.matchedKeywords.length ? 1 : 2)
              .map((k) => (
                <KeywordChip key={k} keyword={k} />
              ))}
            {isOpen && doc.discarded && <Pause size={11} aria-label="Suspended" className="shrink-0" />}
            <span className="truncate">
              {isOpen ? (
                <>
                  <Highlight text={displayUrl(doc.url)} terms={hit.terms} /> · {doc.windowLabel}
                </>
              ) : (
                <>
                  {displayHost(doc.url)} · {doc.sessionName}
                  {doc.savedAt ? ` · ${timeAgo(doc.savedAt)}` : ''}
                </>
              )}
            </span>
          </div>
        </div>
        {i === active ? (
          <span className="flex shrink-0 items-center gap-1.5 text-meta text-accent-text">
            {isOpen ? 'Switch' : 'Open'}
            <Kbd className="border-accent-line">↵</Kbd>
          </span>
        ) : (
          !isOpen && (
            <IconButton
              label="Open in background, keep it saved"
              size="sm"
              className="hidden group-hover:inline-flex"
              onClick={(e) => {
                e.stopPropagation();
                openHit(hit, true);
              }}
            >
              <ExternalLink size={14} aria-hidden />
            </IconButton>
          )
        )}
      </div>
    );
  };

  return (
    <div ref={listRef} role="listbox" aria-label="Search results" className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
      {result && result.open.length > 0 && (
        <>
          <h2 className="flex h-8 items-center px-2 label-caps">Open · {result.open.length}</h2>
          {result.open.map(row)}
        </>
      )}
      {result && result.saved.length > 0 && (
        <>
          <h2 className="mt-1.5 flex h-8 items-center px-2 label-caps">Saved · {result.savedTotal.toLocaleString()}</h2>
          {result.saved.map(row)}
        </>
      )}
      {result && result.savedTotal > result.saved.length && (
        <button
          type="button"
          className="mt-1 flex h-9 items-center gap-1.5 px-2 text-small font-semibold text-accent-text hover:underline"
          onClick={() => {
            openLibrary(`#/search/${encodeURIComponent(query.trim())}`);
            window.close();
          }}
        >
          Show all {result.savedTotal.toLocaleString()} saved results in library
          <ArrowRight size={14} aria-hidden />
        </button>
      )}
      <p className="mx-2 mt-2 text-meta text-text-3">
        Keyword matches rank first. Type <span className="font-semibold text-text-2">#{hashWord(query)}</span> to match keywords
        only.
      </p>
    </div>
  );
}
