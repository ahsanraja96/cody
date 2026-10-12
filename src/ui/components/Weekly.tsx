import { useState, type ReactNode } from 'react';
import { ChartColumn, X } from 'lucide-react';
import { send } from '@/lib/messages';
import type { WeekStats } from '@/lib/state';
import { cx } from '../cx';

/**
 * The weekly summary (1.0, Fi-List, Fi-Popup, Fi-Settings): on Mondays, last week's folds, the
 * memory they freed and the tabs that came back. A card at the top of the full list and a line
 * under the popup's Fold button, each with × ("Hide this week’s summary").
 */

/** "about 12 GB", "about 1.6 GB", "about 480 MB". */
export function aboutBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `about ${Math.max(10, Math.round(mb / 10) * 10)} MB`;
  const gb = mb / 1024;
  return `about ${gb >= 10 ? Math.round(gb) : gb.toFixed(1).replace(/\.0$/, '')} GB`;
}

export interface WeeklyParts {
  /** "340 tabs" */
  folded: string;
  /** "12 GB", or null when nothing measurable was freed. */
  freed: string | null;
  /** Tabs that came back (0: the sentence leaves it out). */
  cameBack: number;
}

export function weeklyParts(week: WeekStats): WeeklyParts {
  return {
    folded: `${week.folded.toLocaleString()} ${week.folded === 1 ? 'tab' : 'tabs'}`,
    freed: week.freedBytes > 0 ? aboutBytes(week.freedBytes).replace(/^about /, '') : null,
    cameBack: week.cameBack,
  };
}

/** "Last week you folded 340 tabs and freed about 12 GB. 28 came back when you needed them." */
export function weeklyText(week: WeekStats): string {
  const p = weeklyParts(week);
  const first = `Last week you folded ${p.folded}${p.freed ? ` and freed about ${p.freed}` : ''}.`;
  if (p.cameBack <= 0) return first;
  return `${first} ${p.cameBack.toLocaleString()} came back when you needed ${p.cameBack === 1 ? 'it' : 'them'}.`;
}

/** The sentence, numbers kept with their words on one line ("340 tabs", "12 GB"). */
function WeeklySentence({ week, bold }: { week: WeekStats; bold?: string }) {
  const p = weeklyParts(week);
  const B = ({ children }: { children: ReactNode }) => <b className={cx('whitespace-nowrap', bold ?? 'font-normal')}>{children}</b>;
  return (
    <>
      Last week you folded <B>{p.folded}</B>
      {p.freed && (
        <>
          {' '}
          and freed <B>about {p.freed}</B>
        </>
      )}
      .
      {p.cameBack > 0 && (
        <>
          {' '}
          <B>{p.cameBack.toLocaleString()}</B> came back when you needed {p.cameBack === 1 ? 'it' : 'them'}.
        </>
      )}
    </>
  );
}

function dismiss(): void {
  void send({ type: 'weekly-summary-dismiss' }).catch(() => undefined);
}

const HIDE = 'Hide this week’s summary';

/** The full list's card (Fi-List): the numbers in bold. */
export function WeeklyCard({ week, className }: { week: WeekStats; className?: string }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const p = weeklyParts(week);
  const b = 'font-semibold whitespace-nowrap text-text';
  return (
    <section
      aria-label="Last week"
      className={cx('flex items-center gap-3 rounded-card border border-border bg-bg-subtle py-2.5 pr-2 pl-3', className)}
    >
      <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-text">
        <ChartColumn size={16} strokeWidth={1.75} />
      </span>
      <p className="m-0 min-w-0 flex-1 text-text-2">
        Last week you folded <b className={b}>{p.folded}</b>
        {p.freed && (
          <>
            {' '}
            and freed about <b className={b}>{p.freed}</b>
          </>
        )}
        .
        {p.cameBack > 0 && (
          <>
            {' '}
            <b className={b}>{p.cameBack.toLocaleString()}</b> came back when you needed {p.cameBack === 1 ? 'it' : 'them'}.
          </>
        )}
      </p>
      <button
        type="button"
        aria-label={HIDE}
        title={HIDE}
        onClick={() => {
          setHidden(true);
          dismiss();
        }}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </section>
  );
}

/** The popup's line under the Fold button (Fi-Popup), in place of its hint on Mondays. */
export function WeeklyLine({ week, id, className }: { week: WeekStats; id?: string; className?: string }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div id={id} role="note" className={cx('flex items-start gap-2 rounded-control bg-bg-subtle py-1.5 pr-1 pl-2.5 text-small text-text-2', className)}>
      <ChartColumn size={14} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-accent-text" />
      <span className="min-w-0 flex-1">
        <WeeklySentence week={week} />
      </span>
      <button
        type="button"
        aria-label={HIDE}
        title={HIDE}
        onClick={() => {
          setHidden(true);
          dismiss();
        }}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
      >
        <X size={12} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
