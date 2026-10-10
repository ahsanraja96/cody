import type { CSSProperties, ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { cx } from '@/ui/cx';

/**
 * Small drawings for How Tabfold frees memory and the Welcome tab, after the Min-HowMemory and
 * Min-Welcome boards: memory segments in the memory colours, the fold capsule, a running page,
 * a tab in a tab strip. All decorative; the text next to them says the same thing.
 */

/** The colour of segment `index` of `total`: from --tf-mem-from to --tf-mem-to. */
function segColor(index: number, total: number): CSSProperties {
  const pct = total <= 1 ? 0 : Math.round((index / (total - 1)) * 100);
  return { '--seg-c': `color-mix(in oklab, var(--tf-mem-to) ${pct}%, var(--tf-mem-from))` } as CSSProperties;
}

export type Seg = 'on' | 'asleep' | 'off';

/**
 * A memory bar: one segment per tab ('on' loaded, 'asleep' sleeping, 'off' freed), then the fold
 * capsule, filled to `capsule` (0 to 1) with folded tabs.
 */
export function MemoryBar({ segments, capsule = 0, label }: { segments: Seg[]; capsule?: number; label: string }) {
  return (
    <div role="img" aria-label={label} className="flex items-center gap-1.5">
      <span className="tf-ticks flex h-2.5 min-w-0 flex-1 items-center gap-0.5 rounded-full border border-border px-0.5">
        {segments.map((seg, i) =>
          seg === 'on' ? (
            <span key={i} className="tf-seg" style={segColor(i, segments.length)} />
          ) : seg === 'asleep' ? (
            <span key={i} className="tf-seg-asleep" />
          ) : (
            <span key={i} className="h-1.5 min-w-0 flex-1 rounded-[1px]" />
          ),
        )}
      </span>
      <span title="Fold capsule: tabs folded into your list" className="relative h-2.5 w-6 shrink-0 overflow-hidden rounded-full border border-accent-line bg-bg-subtle">
        {capsule > 0 && <span className="tf-capsule-fill absolute inset-y-0 left-0" style={{ width: `${Math.round(capsule * 100)}%` }} />}
      </span>
    </div>
  );
}

/** A coloured letter tile standing in for a site's icon in drawings. */
export function LetterTile({ letter, bg, fg = '#FFFFFF', size = 16, dark = false }: { letter: string; bg: string; fg?: string; size?: number; dark?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx('inline-flex shrink-0 items-center justify-center font-semibold', dark && 'tf-fav-dark')}
      style={{
        width: size,
        height: size,
        borderRadius: size <= 12 ? 3 : 4,
        fontSize: size <= 14 ? 9 : 10,
        background: bg,
        color: fg,
      }}
    >
      {letter}
    </span>
  );
}

/** A tab in Chrome's tab strip, with the strip's bottom line. */
export function TabInStrip({ title, width, trailing }: { title: string; width: number; trailing?: ReactNode }) {
  return (
    <div aria-hidden className="px-3" style={{ width }}>
      <div className="flex h-[34px] items-center gap-2 rounded-t-[10px] border border-b-0 border-border-strong bg-surface px-3">
        <LetterTile letter="D" bg="#4285F4" />
        <span className="min-w-0 flex-1 truncate text-small">{title}</span>
        {trailing}
      </div>
      <div className="-mx-3 h-px bg-border-strong" />
    </div>
  );
}

const PARTS = ['page', 'scripts', 'images', 'video'];

/** A page's memory: running (filled), gone (closed, nothing left) or asleep (outlined). */
export function PageBlocks({ state }: { state: 'running' | 'gone' | 'asleep' }) {
  return (
    <div
      aria-hidden
      className={cx(
        'grid h-[120px] w-[208px] grid-cols-[1.25fr_1fr] grid-rows-3 gap-1 rounded-card p-1.5',
        state === 'gone' ? 'tf-ticks border border-dashed border-border-strong' : 'border border-border-strong bg-surface',
      )}
    >
      {PARTS.map((part, i) => (
        <span
          key={part}
          className={cx(
            'flex items-end rounded px-2 py-1.5 text-meta font-semibold',
            i === 0 && 'row-span-3',
            state === 'running' && 'text-on-accent shadow-[inset_0_1px_0_var(--tf-mem-hi),0_0_6px_var(--tf-mem-glow)]',
            state === 'gone' && 'text-transparent',
            state === 'asleep' && 'border border-[var(--tf-mem-line)] bg-bg-subtle text-text-3',
          )}
          style={state === 'running' ? { background: `color-mix(in oklab, var(--tf-mem-to) ${[0, 40, 70, 100][i]}%, var(--tf-mem-from))` } : undefined}
        >
          {part}
        </span>
      ))}
    </div>
  );
}

/** A numbered caption under a step: (1) A tab. */
export function StepLabel({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-small text-text-2">
      <span className="flex size-[18px] items-center justify-center rounded-full border border-border-strong text-[10px] font-semibold text-text-2">{n}</span>
      {children}
    </div>
  );
}

export function StepArrow({ caption, width = 40 }: { caption?: string; width?: number }) {
  return (
    <div aria-hidden className="flex shrink-0 flex-col items-center gap-1 text-text-3" style={{ width }}>
      <ArrowRight size={18} strokeWidth={1.75} />
      {caption && <span className="text-meta whitespace-nowrap">{caption}</span>}
    </div>
  );
}

/** One column of a diagram: the drawing (132px tall, centred) above its numbered caption. */
export function Step({ width, n, label, children }: { width: number; n: number; label: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-3" style={{ width }}>
      <div className="flex h-[132px] items-center justify-center">{children}</div>
      <StepLabel n={n}>{label}</StepLabel>
    </div>
  );
}
