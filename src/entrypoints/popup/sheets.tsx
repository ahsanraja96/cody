import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Archive, Link, TextCursorInput, Volume2, X } from 'lucide-react';
import { plural } from '@/lib/format';
import type { PreflightResult } from '@/lib/messages';
import { MAX_URL_LENGTH, displayHost } from '@/lib/urls';
import { Button, IconButton } from '@/ui/components/Button';
import { Checkbox } from '@/ui/components/Controls';
import { Favicon } from '@/ui/components/Favicon';
import { cx } from '@/ui/cx';
import { addressHead, formatLength, listSessions } from './popupHooks';

/**
 * A bottom sheet: a native modal <dialog> (focus trap, Escape) pinned to the popup's bottom edge,
 * over a dimmed popup.
 */
export function Sheet({
  labelledBy,
  describedBy,
  onCancel,
  children,
}: {
  labelledBy: string;
  describedBy?: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      // showModal focuses the first focusable element; start on the sheet's main action instead.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onCancel();
      }}
      className="tf-sheet fixed inset-x-0 top-auto bottom-0 m-0 flex max-h-[calc(100%-16px)] w-full max-w-none flex-col gap-3 overflow-y-auto rounded-t-card border border-b-0 border-border bg-surface p-4 text-text shadow-pop"
    >
      {children}
    </dialog>
  );
}

/** A radio with a one-line hint under its label, dot aligned with the first line. */
function HintRadio({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  hint: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="radio" name={name} className="peer sr-only" checked={checked} onChange={onChange} />
      <span
        aria-hidden
        className={cx(
          'mt-px size-4 shrink-0 rounded-full bg-surface peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          checked ? 'border-[5px] border-accent' : 'border border-border-strong',
        )}
      />
      <span className="min-w-0">
        <span className="block">{label}</span>
        <span className="block text-meta text-text-3">{hint}</span>
      </span>
    </label>
  );
}

export interface DuplicatesAnswer {
  choice: 'skip' | 'keep';
  remember: boolean;
}

/** "4 of 18 tabs are already saved": skip them (they still close) or save them again. */
export function DuplicatesSheet({
  preflight,
  onAnswer,
}: {
  preflight: PreflightResult;
  onAnswer: (answer: DuplicatesAnswer | null) => void;
}) {
  const titleId = useId();
  const descId = useId();
  const name = useId();
  const [choice, setChoice] = useState<'skip' | 'keep'>('skip');
  const [remember, setRemember] = useState(false);
  const dups = preflight.duplicates;
  const total = Math.max(preflight.tabs, dups.length);
  const one = dups.length === 1;
  const counts = new Map<string, number>();
  for (const d of dups) counts.set(d.sessionName, (counts.get(d.sessionName) ?? 0) + 1);
  const where = listSessions([...counts], counts.size > 1 || dups.length > 1);
  const saving = choice === 'skip' ? total - dups.length : total;

  return (
    <Sheet labelledBy={titleId} describedBy={descId} onCancel={() => onAnswer(null)}>
      <div>
        <h2 id={titleId} className="text-section font-semibold">
          {dups.length} of {plural(total, 'tab')} {one ? 'is' : 'are'} already saved
        </h2>
        <p id={descId} dir="auto" className="mt-0.5 text-text-2">
          {one ? 'It’s' : 'They’re'} in {where}.
        </p>
      </div>
      <ul
        aria-label="Tabs that are already saved"
        className="scroll-thin max-h-[118px] shrink-0 overflow-y-auto rounded-control border border-border bg-bg-subtle py-0.5"
      >
        {dups.map((d) => (
          <li key={d.tabId} className="flex h-7 items-center gap-2.5 px-2.5">
            <Favicon url={d.url} />
            <span dir="auto" className="min-w-0 flex-1 truncate">
              {d.title || displayHost(d.url)}
            </span>
            <span dir="auto" className="max-w-[40%] shrink-0 truncate text-meta text-text-3">
              {d.sessionName}
            </span>
          </li>
        ))}
      </ul>
      <div role="radiogroup" aria-label={`What to do with the ${plural(dups.length, 'duplicate')}`} className="flex flex-col gap-2">
        <HintRadio
          name={name}
          checked={choice === 'skip'}
          onChange={() => setChoice('skip')}
          label={one ? 'Skip the duplicate' : `Skip the ${dups.length} duplicates`}
          hint={one ? 'It still closes, and stays saved where it is.' : 'They still close, and stay saved where they are.'}
        />
        <HintRadio
          name={name}
          checked={choice === 'keep'}
          onChange={() => setChoice('keep')}
          label={one ? 'Save it again' : 'Save them again'}
          hint={`The new session gets its own copy of all ${total}.`}
        />
      </div>
      <div className="border-t border-border pt-3">
        <Checkbox checked={remember} onChange={setRemember}>
          Remember my choice
        </Checkbox>
        <div className="pl-6 text-meta text-text-3">Change it in Settings › General</div>
      </div>
      <div className="mt-1 grid shrink-0 grid-cols-2 gap-2">
        <Button className="h-[38px]" onClick={() => onAnswer(null)}>
          Cancel
        </Button>
        <Button variant="primary" className="h-[38px]" data-autofocus onClick={() => onAnswer({ choice, remember })}>
          Save {plural(saving, 'tab')}
        </Button>
      </div>
    </Sheet>
  );
}

export interface BeforeCloseAnswer {
  audible: 'keep' | 'close';
  stopAudioWarning: boolean;
}

/** Small two-option switch sized for a row ("Keep open | Close"). */
function RowSegmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-7 shrink-0 rounded-control border border-border-strong bg-bg-subtle p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'inline-flex h-[22px] items-center rounded-md px-2 text-small',
            value === option.value ? 'border border-border bg-surface font-semibold text-text' : 'text-text-2 hover:text-text',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function RowIcon({ tone, children }: { tone: 'amber' | 'neutral'; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-control',
        tone === 'amber' ? 'bg-amber-soft text-amber' : 'bg-hover text-text-2',
      )}
    >
      {children}
    </span>
  );
}

/**
 * "Before closing 47 tabs": tabs playing audio (keep them open or close them), addresses too long
 * to save in full, and a reminder that unsaved form text can't be checked.
 */
export function BeforeCloseSheet({
  preflight,
  warnAudio,
  onAnswer,
}: {
  preflight: PreflightResult;
  warnAudio: boolean;
  onAnswer: (answer: BeforeCloseAnswer | null) => void;
}) {
  const titleId = useId();
  const descId = useId();
  const [audible, setAudible] = useState<'keep' | 'close'>('keep');
  const [stopWarning, setStopWarning] = useState(false);
  const audioCount = preflight.audibleTabs.length || preflight.audible;
  const showAudio = warnAudio && audioCount > 0;
  const long = preflight.longUrls;
  const closing = Math.max(preflight.closeTabs, preflight.tabs);
  const closeCount = showAudio && audible === 'keep' ? closing - audioCount : closing;

  return (
    <Sheet labelledBy={titleId} describedBy={descId} onCancel={() => onAnswer(null)}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-section font-semibold">
            Before closing {plural(closing, 'tab')}
          </h2>
          <p id={descId} className="mt-0.5 text-small text-text-2">
            Nothing closes until it's saved.
          </p>
        </div>
        <IconButton label="Cancel" className="-mt-1" onClick={() => onAnswer(null)}>
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      <ul className="shrink-0 overflow-hidden rounded-card border border-border">
        {showAudio && (
          <li className="flex items-start gap-3 p-3">
            <RowIcon tone="amber">
              <Volume2 size={16} />
            </RowIcon>
            <div className="min-w-0 flex-1">
              <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {audioCount === 1 ? '1 tab is playing audio' : `${audioCount} tabs are playing audio`}
                </span>
                <RowSegmented
                  label={audioCount === 1 ? 'What to do with the tab playing audio' : 'What to do with the tabs playing audio'}
                  value={audible}
                  onChange={setAudible}
                  options={[
                    { value: 'keep', label: 'Keep open' },
                    { value: 'close', label: 'Close' },
                  ]}
                />
              </div>
              {preflight.audibleTabs.slice(0, 3).map((tab) => (
                <div key={tab.tabId} className="flex items-center gap-1.5 text-small text-text-2">
                  <Favicon url={tab.url} size={14} />
                  <span dir="auto" className="truncate">
                    {displayHost(tab.url)}
                    {tab.title ? ` · ${tab.title}` : ''}
                  </span>
                </div>
              ))}
              {preflight.audibleTabs.length > 3 && (
                <div className="text-small text-text-3">and {preflight.audibleTabs.length - 3} more</div>
              )}
            </div>
          </li>
        )}
        {long.length > 0 && (
          <li className="flex items-start gap-3 border-t border-border p-3 first:border-t-0">
            <RowIcon tone="amber">
              <Link size={16} />
            </RowIcon>
            <div className="min-w-0 flex-1 pt-1">
              <div className="font-semibold">
                {long.length === 1 ? '1 address is too long to save in full' : `${long.length} addresses are too long to save in full`}
              </div>
              {long.slice(0, 2).map((entry) => (
                <div key={entry.tabId} className="flex min-w-0 font-mono text-small text-text-2">
                  <span className="truncate">{addressHead(entry.url)}…</span>
                  <span className="shrink-0 whitespace-pre"> ({formatLength(entry.length)})</span>
                </div>
              ))}
              <div className="mt-0.5 text-small text-text-3">
                Tabfold saves the first {MAX_URL_LENGTH.toLocaleString('en-US')} characters.
                <br />
                {long.length === 1 ? 'It may not reopen.' : 'They may not reopen.'}
              </div>
            </div>
          </li>
        )}
        <li className="flex items-start gap-3 border-t border-border bg-bg-subtle p-3 first:border-t-0">
          <RowIcon tone="neutral">
            <TextCursorInput size={16} />
          </RowIcon>
          <div className="min-w-0 flex-1 pt-1">
            <div className="font-semibold">Unsaved form text can't be checked</div>
            <div className="text-small text-balance text-text-2">Tabfold never reads pages, so save anything you typed first.</div>
          </div>
        </li>
      </ul>
      {showAudio && (
        <span className="text-small text-text-2">
          <Checkbox checked={stopWarning} onChange={setStopWarning}>
            Don't warn about audio again
          </Checkbox>
        </span>
      )}
      <div className="flex shrink-0 gap-2">
        <Button className="h-9 px-4" onClick={() => onAnswer(null)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="h-9 min-w-0 flex-1"
          icon={<Archive size={16} aria-hidden className="shrink-0" />}
          data-autofocus
          onClick={() => onAnswer({ audible: showAudio ? audible : 'close', stopAudioWarning: showAudio && stopWarning })}
        >
          Save &amp; close {plural(Math.max(0, closeCount), 'tab')}
        </Button>
      </div>
    </Sheet>
  );
}
