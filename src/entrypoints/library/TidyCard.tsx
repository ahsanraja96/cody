import { useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { send } from '@/lib/messages';
import type { TidyState } from '@/lib/state';
import { handleCommandError, undoToast } from './folderActions';
import { count } from './format';

/**
 * "Your weekly tidy-up" (Mx-Ask, Pro AI): once a week at the top of the list, each suggestion one
 * click with Undo, and "Not now" until next week.
 */
export function TidyCard({ tidy, onSettings }: { tidy: TidyState; onSettings: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const suggestions = tidy.suggestions.filter((s) => !done.has(s.id));
  if (suggestions.length === 0) return null;

  const apply = async (id: string, action: string) => {
    setBusy(id);
    try {
      const result = await send({ type: 'tidy-apply', suggestionId: id });
      setDone((d) => new Set(d).add(id));
      undoToast(`${action}: ${count(result.done, 'tab')}`, [result.actionId]);
    } catch (error) {
      handleCommandError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="tidy-h" className="mb-6 rounded-card border border-accent-line bg-accent-soft p-3.5">
      <h2 id="tidy-h" className="m-0 flex items-center gap-2 text-body font-semibold">
        <Sparkles size={16} strokeWidth={1.75} aria-hidden className="text-accent-text" />
        Your weekly tidy-up
      </h2>
      <ul className="m-0 mt-2.5 flex list-none flex-col gap-2.5 p-0">
        {suggestions.map((s) => (
          <li key={s.id} className="flex items-center gap-2.5">
            <span dir="auto" className="min-w-0 flex-1 text-text-2">
              {s.text}
            </span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void apply(s.id, s.action)}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover disabled:opacity-60"
            >
              {busy === s.id && <LoaderCircle size={12} aria-hidden className="tf-spin" />}
              {s.action}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2.5 text-small">
        <button
          type="button"
          onClick={() => void send({ type: 'tidy-dismiss' }).catch(handleCommandError)}
          className="font-semibold text-accent-text hover:underline"
        >
          Not now
        </button>{' '}
        <span className="text-text-3">
          · every Monday ·{' '}
          <button type="button" onClick={onSettings} className="hover:text-text hover:underline">
            Settings › Weekly tidy-up
          </button>
        </span>
      </div>
    </section>
  );
}

/** The card shows for Pro AI with the switch on, while there are suggestions not put off with "Not now". */
export function showTidy(tidy: TidyState | undefined, on: boolean): tidy is TidyState {
  return !!tidy && on && tidy.suggestions.length > 0 && !(tidy.dismissedAt && tidy.dismissedAt >= tidy.at);
}
