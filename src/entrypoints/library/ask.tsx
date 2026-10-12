import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { send, type AskMatch } from '@/lib/messages';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { Favicon } from '@/ui/components/Favicon';
import { cx } from '@/ui/cx';
import { errorCode, proErrorText } from '@/ui/pro';
import { openFolded } from './actions';
import { ago } from './format';
import { goToPlans } from './router';

/**
 * Ask your tabs (Mx-Ask, Pro AI): a question in search ("pricing page I looked at last week")
 * gets an "Ask" chip; asking shows "Best matches" from the AI, with why, above the usual results.
 * Free and Pro see "Ask with Pro AI", which opens the plans.
 */

/** A question, or three words or more. */
export function looksLikeQuestion(query: string): boolean {
  const q = query.trim();
  if (q.length < 4) return false;
  if (q.endsWith('?')) return true;
  if (/^(what|where|which|who|when|why|how|that|the|my|find|show)\b/i.test(q) && q.split(/\s+/).length >= 2) return true;
  return q.split(/\s+/).filter(Boolean).length >= 3;
}

export type AskState =
  | { query: string; status: 'loading' }
  | { query: string; status: 'done'; matches: AskMatch[] }
  | { query: string; status: 'error'; message: string };

export function useAsk(query: string): { ask: AskState | null; run: () => void } {
  const [ask, setAsk] = useState<AskState | null>(null);
  const trimmed = query.trim();
  // A new query forgets the last answer.
  useEffect(() => {
    setAsk((a) => (a && a.query !== trimmed ? null : a));
  }, [trimmed]);
  const run = useCallback(() => {
    if (!trimmed) return;
    setAsk({ query: trimmed, status: 'loading' });
    send({ type: 'ai-ask', query: trimmed })
      .then(({ matches }) => setAsk((a) => (a?.query === trimmed ? { query: trimmed, status: 'done', matches } : a)))
      .catch((error) => {
        if (errorCode(error) === 'needs-pro-ai') {
          setAsk(null);
          goToPlans();
          return;
        }
        setAsk((a) => (a?.query === trimmed ? { query: trimmed, status: 'error', message: proErrorText(error) } : a));
      });
  }, [trimmed]);
  return { ask, run };
}

/** The chip inside the search field: "✦ Ask" on Pro AI, "✦ Ask with Pro AI" otherwise. */
export function AskChip({ proAi, busy, onAsk }: { proAi: boolean; busy: boolean; onAsk: () => void }) {
  return (
    <button
      type="button"
      onClick={proAi ? onAsk : goToPlans}
      disabled={busy}
      title={proAi ? 'Find tabs by what they’re about (Shift+Enter). Only titles and sites are sent.' : 'Ask your tabs is part of Pro AI'}
      className={cx(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-accent-soft px-2 text-meta font-semibold text-accent-text hover:brightness-95',
        busy && 'opacity-70',
      )}
    >
      {busy ? <LoaderCircle size={11} aria-hidden className="tf-spin" /> : <Sparkles size={11} strokeWidth={2} aria-hidden />}
      {proAi ? 'Ask' : 'Ask with Pro AI'}
    </button>
  );
}

/** "Best matches" above the search results, each with why it matched. */
export function BestMatches({ ask, tabs, folders }: { ask: AskState; tabs: TabRecord[]; folders: FolderRecord[] }) {
  const rows = useMemo(() => {
    if (ask.status !== 'done') return [];
    const byId = new Map(tabs.map((t) => [t.id, t]));
    return ask.matches.map((m) => ({ match: m, tab: byId.get(m.tabRecordId) })).filter((r): r is { match: AskMatch; tab: TabRecord } => !!r.tab);
  }, [ask, tabs]);
  const folderName = (id?: string) => (id ? folders.find((f) => f.id === id)?.name : undefined);

  return (
    <section aria-labelledby="ask-h" className="mb-4">
      <div className="flex h-9 items-center gap-1.5 px-2">
        <h2 id="ask-h" className="label-caps m-0">
          Best matches
        </h2>
        <Sparkles size={11} strokeWidth={2} aria-hidden className="text-accent-text" />
      </div>
      {ask.status === 'loading' && (
        <p role="status" className="m-0 flex items-center gap-2 px-2 py-2 text-small text-text-3">
          <LoaderCircle size={14} aria-hidden className="tf-spin" />
          Asking your tabs… Only titles and sites are sent.
        </p>
      )}
      {ask.status === 'error' && (
        <p role="alert" className="m-0 px-2 py-2 text-small text-red">
          {ask.message}
        </p>
      )}
      {ask.status === 'done' && rows.length === 0 && (
        <p role="status" className="m-0 px-2 py-2 text-small text-text-3">
          No folded tab looks like that. The results below match the words.
        </p>
      )}
      {rows.length > 0 && (
        <ul role="list" aria-label="Best matches" className="m-0 flex list-none flex-col p-0">
          {rows.map(({ match, tab }) => {
            const inFolder = folderName(tab.folderId);
            const when = ago(tab.savedAt);
            const meta = `Folded ${/^[A-Z][a-z]+ \d/.test(when) ? when : when[0]!.toLowerCase() + when.slice(1)}${inFolder ? ` · in “${inFolder}”` : ''}`;
            return (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={(e) => void openFolded(tab, !(e.metaKey || e.ctrlKey))}
                  className="flex w-full items-center gap-3 rounded-control px-2 py-2 text-left hover:bg-hover"
                >
                  <Favicon url={tab.url} size={16} />
                  <span className="min-w-0 flex-1">
                    <span dir="auto" className="block truncate">
                      {tab.title || tab.url}
                    </span>
                    <span dir="auto" className="block truncate text-small text-text-3">
                      {match.reason || meta}
                    </span>
                  </span>
                  {match.reason && <span className="hidden shrink-0 text-small text-text-3 min-[900px]:block">{meta}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
