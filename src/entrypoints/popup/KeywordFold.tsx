import { useMemo, useRef, useState } from 'react';
import { Archive, Check, CircleAlert, Plus, X } from 'lucide-react';
import { cleanKeywords, MAX_KEYWORDS_PER_TAB, normalizeKeyword, suggestKeywords } from '@/lib/keywords';
import { send } from '@/lib/messages';
import { displayHost, displayUrl } from '@/lib/urls';
import { Favicon } from '@/ui/components/Favicon';
import { Logo } from '@/ui/components/Logo';
import { cx } from '@/ui/cx';
import type { OpenWindow } from '@/ui/hooks';
import { tabUrl } from './popupHooks';

/**
 * Right-click › "Fold this tab with keywords…" (Min-Popup-Keywords): the tab, a keyword input with
 * chips, suggestions from its title and address, then Fold tab saves it with them and closes it.
 * Runs in the toolbar popup or, when Chrome can't open that, in a small window.
 */
export function KeywordFold({
  tabIds,
  windows,
  loaded,
  onCancel,
}: {
  tabIds: number[];
  windows: OpenWindow[];
  loaded: boolean;
  onCancel: () => void;
}) {
  const tabs = useMemo(
    () => windows.flatMap((w) => w.tabs).filter((t) => t.id !== undefined && tabIds.includes(t.id)),
    [windows, tabIds],
  );
  const [keywords, setKeywords] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    const merged: string[] = [];
    for (const tab of tabs.slice(0, 5)) {
      for (const word of suggestKeywords(tab.title ?? '', tabUrl(tab), { limit: tabs.length > 1 ? 3 : 5 })) {
        if (!merged.includes(word)) merged.push(word);
      }
    }
    return merged.slice(0, 5);
  }, [tabs]);

  const full = keywords.length >= MAX_KEYWORDS_PER_TAB;
  const add = (word: string) => {
    setKeywords((list) => cleanKeywords([...list, word]));
    setText('');
  };
  const toggle = (word: string) =>
    setKeywords((list) => (list.includes(word) ? list.filter((k) => k !== word) : cleanKeywords([...list, word])));

  const fold = async () => {
    if (busy || !tabs.length) return;
    const typed = normalizeKeyword(text);
    const chosen = typed ? cleanKeywords([...keywords, typed]) : keywords;
    setBusy(true);
    setError(null);
    try {
      const ids = tabs.map((t) => t.id!);
      await send({
        type: 'save',
        scope: 'tabs',
        tabIds: ids,
        close: true,
        keywordsByTabId: Object.fromEntries(ids.map((id) => [id, chosen])),
        duplicates: 'skip',
      });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/\s*Nothing was closed\.?$/i, '') : null);
      setBusy(false);
    }
  };

  const first = tabs[0];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kw-title"
      className="flex h-full min-h-0 flex-col bg-bg"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <header className="flex flex-none items-center gap-2 border-b border-border py-3.5 pr-3 pl-4">
        <Logo size={24} />
        <h1 id="kw-title" className="min-w-0 flex-1 truncate text-section font-semibold">
          Fold with keywords
        </h1>
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel"
          onClick={onCancel}
          className="flex size-8 flex-none items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
        >
          <X size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </header>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-5">
        {!loaded ? null : !first ? (
          <p className="rounded-card border border-border bg-bg-subtle px-3.5 py-3 text-text-2">That tab is no longer open.</p>
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-card border border-border bg-bg-subtle px-3.5 py-3">
              <Favicon url={tabUrl(first)} size={16} />
              <div className="min-w-0 flex-1">
                <div dir="auto" className="truncate font-semibold">
                  {first.title || displayHost(tabUrl(first))}
                </div>
                <div className="truncate text-small text-text-3">
                  {tabs.length > 1 ? `and ${tabs.length - 1} more` : displayUrl(tabUrl(first))}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="kw-input" className="text-small font-semibold text-text-2">
                Keywords
              </label>
              <div
                className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-control border border-border-strong bg-surface py-[7px] pr-2.5 pl-[7px] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]"
                onClick={() => inputRef.current?.focus()}
              >
                {keywords.map((word) => (
                  <span
                    key={word}
                    className="inline-flex h-6 items-center gap-0.5 rounded-md bg-accent-soft pr-0.5 pl-2 text-small font-semibold text-accent-text"
                  >
                    {word}
                    <button
                      type="button"
                      aria-label={`Remove keyword ${word}`}
                      onClick={() => setKeywords((list) => list.filter((k) => k !== word))}
                      className="flex size-5 items-center justify-center rounded text-accent-text hover:bg-accent-line/40"
                    >
                      <X size={12} strokeWidth={2} aria-hidden />
                    </button>
                  </span>
                ))}
                <input
                  ref={inputRef}
                  id="kw-input"
                  autoFocus
                  value={text}
                  disabled={full}
                  placeholder={full ? '' : 'Add a keyword'}
                  aria-describedby="kw-help"
                  onChange={(e) => setText(e.target.value.replace(',', ''))}
                  onKeyDown={(e) => {
                    const typed = normalizeKeyword(text);
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (typed) add(typed);
                      else void fold();
                    } else if ((e.key === ',' || e.key === 'Tab') && typed) {
                      e.preventDefault();
                      add(typed);
                    } else if (e.key === 'Backspace' && !text && keywords.length) {
                      setKeywords((list) => list.slice(0, -1));
                    } else if (e.key === 'Escape' && text) {
                      e.preventDefault();
                      e.stopPropagation();
                      setText('');
                    }
                  }}
                  className="h-6 min-w-[100px] flex-1 border-0 bg-transparent pl-0.5 text-text outline-none"
                />
              </div>
              <p id="kw-help" className="text-small text-text-3">
                Search finds the tab by these words later.
              </p>
            </div>

            {suggestions.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="text-small font-semibold text-text-2">From the title and address</div>
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map((word) => {
                    const picked = keywords.includes(word);
                    return (
                      <button
                        key={word}
                        type="button"
                        aria-pressed={picked}
                        onClick={() => toggle(word)}
                        className={cx(
                          'inline-flex h-[26px] items-center gap-1 rounded-md pr-2.5 pl-2 text-small',
                          picked
                            ? 'border border-accent-line bg-accent-soft font-semibold text-accent-text'
                            : 'border border-dashed border-border-strong text-text-2 hover:bg-hover',
                        )}
                      >
                        {picked ? <Check size={12} strokeWidth={2.5} aria-hidden /> : <Plus size={12} strokeWidth={2.2} aria-hidden />}
                        {word}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {error !== null && (
              <div role="alert" className="flex items-start gap-2.5 rounded-card border border-red-line bg-red-soft px-3.5 py-3">
                <CircleAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 flex-none text-red" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-red">Couldn’t fold. Nothing was closed.</div>
                  {error && <div className="text-small text-text-2">{error}</div>}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="flex flex-none flex-col gap-2.5 border-t border-border p-4">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-control border border-border-strong bg-surface text-text hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !first}
            onClick={() => void fold()}
            className="flex h-10 items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover disabled:bg-hover disabled:text-text-3"
          >
            <Archive size={16} strokeWidth={1.75} aria-hidden />
            {tabs.length > 1 ? `Fold ${tabs.length} tabs` : 'Fold tab'}
          </button>
        </div>
        <p className="text-center text-small text-text-3">
          {tabs.length > 1 ? 'Saves them to your list and closes the tabs.' : 'Saves it to your list and closes the tab.'}
        </p>
      </footer>
    </div>
  );
}
