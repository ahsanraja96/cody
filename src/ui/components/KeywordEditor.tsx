import { useId, useMemo, useRef, useState } from 'react';
import { cleanKeywords, MAX_KEYWORDS_PER_TAB, normalizeKeyword } from '@/lib/keywords';
import { cx } from '../cx';
import { InputChip, Kbd, PickChip } from './Chips';

/**
 * Pick keywords for a tab: type your own (Enter or comma adds), pick from words in the tab's
 * title and address, or reuse keywords you have used before.
 */
export function KeywordEditor({
  value,
  onChange,
  suggestions,
  vocabulary,
  autoFocus,
  onSubmit,
  compact = false,
}: {
  value: string[];
  onChange: (keywords: string[]) => void;
  suggestions: string[];
  vocabulary: Array<{ keyword: string; count: number }>;
  autoFocus?: boolean;
  /** Called on Enter when the input is empty (e.g. to save). */
  onSubmit?: () => void;
  compact?: boolean;
}) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const typed = normalizeKeyword(text);
  const matches = useMemo(() => {
    if (!typed) return [];
    return vocabulary
      .filter((v) => v.keyword.startsWith(typed) && !value.includes(v.keyword))
      .slice(0, 5);
  }, [typed, vocabulary, value]);
  const options: Array<{ keyword: string; count?: number; isNew: boolean }> = [
    ...matches.map((m) => ({ keyword: m.keyword, count: m.count, isNew: false })),
    ...(typed && !value.includes(typed) && !matches.some((m) => m.keyword === typed) ? [{ keyword: typed, isNew: true }] : []),
  ];

  const add = (keyword: string) => {
    onChange(cleanKeywords([...value, keyword]));
    setText('');
    setActive(0);
    inputRef.current?.focus();
  };
  const toggle = (keyword: string) =>
    onChange(value.includes(keyword) ? value.filter((k) => k !== keyword) : cleanKeywords([...value, keyword]));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const option = options[active] ?? options[0];
      if (option) add(option.keyword);
      else if (!text.trim()) onSubmit?.();
    } else if (e.key === ',' || e.key === 'Tab') {
      if (typed) {
        e.preventDefault();
        add(typed);
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'ArrowDown' && options.length) {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp' && options.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === 'Escape' && text) {
      e.stopPropagation();
      setText('');
    }
  };

  const suggested = suggestions;
  const yours = vocabulary.map((v) => v.keyword).filter((k) => !suggestions.includes(k)).slice(0, compact ? 6 : 8);
  const full = value.length >= MAX_KEYWORDS_PER_TAB;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor={inputId} className="flex items-baseline justify-between label-caps">
          Keywords
          <span className="text-meta font-normal tracking-normal normal-case">Search finds the tab by these</span>
        </label>
        <div className="relative">
          <div
            className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2 py-1.5 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]"
            onClick={() => inputRef.current?.focus()}
          >
            {value.map((keyword) => (
              <InputChip key={keyword} label={keyword} onRemove={() => onChange(value.filter((k) => k !== keyword))} />
            ))}
            <input
              ref={inputRef}
              id={inputId}
              value={text}
              disabled={full}
              autoFocus={autoFocus}
              onChange={(e) => {
                setText(e.target.value.replace(',', ''));
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={value.length ? '' : full ? '' : 'Add a keyword…'}
              aria-label="Add a keyword"
              aria-autocomplete="list"
              aria-controls={options.length ? listId : undefined}
              aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
              className="h-6 min-w-[80px] flex-1 border-0 bg-transparent px-1 outline-none"
            />
          </div>
          {options.length > 0 && (
            <div
              id={listId}
              role="listbox"
              aria-label="Matching keywords"
              className="absolute inset-x-0 top-full z-20 mt-1 rounded-control border border-border bg-surface p-1 shadow-pop"
            >
              {options.map((option, index) => (
                <div
                  key={option.keyword}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(option.keyword);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cx('flex h-[30px] cursor-pointer items-center gap-2 rounded-md px-2', index === active && 'bg-hover')}
                >
                  {option.isNew ? (
                    <span className="flex-1">
                      Add “<strong className="font-semibold">{option.keyword}</strong>” as a new keyword
                    </span>
                  ) : (
                    <span className="flex-1">
                      <strong className="font-semibold">{option.keyword.slice(0, typed.length)}</strong>
                      {option.keyword.slice(typed.length)}
                    </span>
                  )}
                  {option.isNew ? (
                    <Kbd>↵</Kbd>
                  ) : (
                    <span className="text-meta text-text-3">
                      used on {option.count} {option.count === 1 ? 'tab' : 'tabs'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {full && <p className="text-meta text-text-3">Up to {MAX_KEYWORDS_PER_TAB} keywords per tab.</p>}
      </div>

      {suggested.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="label-caps">Suggested from this tab</div>
          <div className="flex flex-wrap gap-1.5">
            {suggested.map((keyword) => (
              <PickChip key={keyword} keyword={keyword} picked={value.includes(keyword)} onToggle={() => toggle(keyword)} />
            ))}
          </div>
        </div>
      )}

      {yours.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="label-caps">Your keywords</div>
          <div className="flex flex-wrap gap-1.5">
            {yours.map((keyword) => (
              <PickChip key={keyword} keyword={keyword} picked={value.includes(keyword)} onToggle={() => toggle(keyword)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
