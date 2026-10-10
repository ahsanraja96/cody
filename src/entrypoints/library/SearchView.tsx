import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ExternalLink, Search } from 'lucide-react';
import { timeAgo } from '@/lib/format';
import { send } from '@/lib/messages';
import { displayHost } from '@/lib/urls';
import { IconButton } from '@/ui/components/Button';
import { KeywordChip } from '@/ui/components/Chips';
import { Segmented } from '@/ui/components/Controls';
import { Favicon } from '@/ui/components/Favicon';
import { Highlight } from '@/ui/components/Highlight';
import { cx } from '@/ui/cx';
import { useTabSearch } from '@/ui/hooks';

const NO_OPEN_TABS: never[] = [];

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
  const { result, searching } = useTabSearch(query, NO_OPEN_TABS, { scope, limit: 5000 });
  const hits = useMemo(() => result?.saved ?? [], [result]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  return (
    <div ref={scrollRef} className="scroll-thin h-full overflow-y-auto bg-bg-subtle">
      <div className="flex flex-wrap items-center gap-3 px-6 pt-5 pb-3">
        <div className="flex min-w-[200px] flex-1 items-baseline gap-2.5">
          <h1 className="text-page font-semibold">Search</h1>
          {result && (
            <span className="text-text-3">
              {result.savedTotal.toLocaleString()} {result.savedTotal === 1 ? 'tab' : 'tabs'} · {result.ms} ms
            </span>
          )}
        </div>
        <Segmented
          label="Where to search"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'live', label: 'Saved' },
            { value: 'trash', label: 'Trash' },
          ]}
        />
      </div>
      <p className="px-6 pb-3 text-small text-text-3">
        Matches titles, addresses and keywords. Keyword matches rank first; <span className="font-semibold text-text-2">#keyword</span>{' '}
        matches keywords only.
      </p>

      {!result && searching && (
        <div className="px-6" aria-busy="true">
          {[70, 82, 58, 76].map((w) => (
            <div key={w} className="flex items-center gap-3 py-3.5">
              <span className="size-4 rounded bg-skeleton" />
              <span className="h-2.5 rounded bg-skeleton" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      )}

      {result && hits.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <Search size={24} aria-hidden className="text-text-3" />
          <div className="text-section font-semibold">No tabs match “{query.trim()}”</div>
          <p className="text-text-2">
            Searched {result.indexedTabs.toLocaleString()} saved tabs{scope === 'trash' ? ' in Trash' : ''} by title, address and keyword.
          </p>
          {scope === 'live' && (
            <button type="button" className="mt-1 font-semibold text-accent-text hover:underline" onClick={() => setScope('trash')}>
              Search in Trash
            </button>
          )}
        </div>
      )}

      <div role="list" aria-label="Search results" className="relative mx-4 mb-8" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const hit = hits[item.index]!;
          const doc = hit.doc;
          const selected = doc.sessionId === selectedId;
          return (
            <div
              key={doc.id}
              role="listitem"
              className="absolute inset-x-0"
              style={{ transform: `translateY(${item.start}px)`, height: item.size }}
            >
              <div
                onClick={() => doc.sessionId && onSelect(doc.sessionId)}
                className={cx(
                  'group flex h-[50px] cursor-pointer items-center gap-3 rounded-control px-2.5',
                  selected ? 'bg-accent-soft' : 'hover:bg-hover',
                )}
              >
                <Favicon url={doc.url} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <button type="button" className="truncate text-left" onClick={() => doc.sessionId && onSelect(doc.sessionId)}>
                    <Highlight text={doc.title} terms={hit.terms} />
                  </button>
                  <div className="flex min-w-0 items-center gap-1.5 text-meta text-text-3">
                    {hit.matchedKeywords.slice(0, 3).map((k) => (
                      <KeywordChip key={k} keyword={k} match />
                    ))}
                    {doc.keywords
                      .filter((k) => !hit.matchedKeywords.includes(k))
                      .slice(0, 2)
                      .map((k) => (
                        <KeywordChip key={k} keyword={k} />
                      ))}
                    <span className="truncate">
                      <Highlight text={displayHost(doc.url)} terms={hit.terms} /> · {doc.sessionName}
                      {doc.savedAt ? ` · ${timeAgo(doc.savedAt)}` : ''}
                    </span>
                  </div>
                </div>
                {doc.tabRecordId && scope === 'live' && (
                  <IconButton
                    label="Open tab (keeps it saved)"
                    className="invisible group-focus-within:visible group-hover:visible"
                    onClick={(e) => {
                      e.stopPropagation();
                      send({ type: 'open-saved-tab', tabRecordId: doc.tabRecordId!, active: true }).catch(() => undefined);
                    }}
                  >
                    <ExternalLink size={14} aria-hidden />
                  </IconButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
