import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { cx } from '../cx';
import './MemoryCapsule.css';

/**
 * The memory capsule from the Min-Memory board: one slim segment per open tab (loaded ones filled
 * with the indigo to violet mix, sleeping ones hollow), freed space as an empty ticked track, and
 * a small fold capsule at the end that fills as tabs fold into the list. It shows tabs, not bytes;
 * the number above it is the estimate. Used by the popup at 10 px and by pages at 14 px.
 */

export type TabKind = 'loaded' | 'sleeping';
type SegmentKind = TabKind | 'freed';

interface Segment {
  kind: SegmentKind;
  /** Still on its way into the fold capsule (a fold in progress). */
  pending: boolean;
}

/** One segment per open tab up to this many; above it each segment stands for several tabs. */
export const MAX_SEGMENTS = 60;
const MAX_SEGMENT_PX = 16;
const GAP_PX = 3;
/** While folding, this many of the last tabs keep flowing into the fold capsule. */
const FLOWING = 5;

const SIZES = {
  popup: { pad: 2, capGap: 6, capWidth: 24, flowExtra: 16 },
  page: { pad: 3, capGap: 8, capWidth: 40, flowExtra: 24 },
} as const;

/** Squeeze tabs into `count` segments; a segment is loaded when at least half of its tabs are. */
function bucket(kinds: TabKind[], count: number): TabKind[] {
  if (count >= kinds.length) return kinds;
  const out: TabKind[] = [];
  for (let b = 0; b < count; b += 1) {
    const start = Math.floor((b * kinds.length) / count);
    const end = Math.max(start + 1, Math.floor(((b + 1) * kinds.length) / count));
    let loaded = 0;
    for (let i = start; i < end; i += 1) if (kinds[i] === 'loaded') loaded += 1;
    out.push(loaded * 2 >= end - start ? 'loaded' : 'sleeping');
  }
  return out;
}

/** The segments to draw: stayed tabs, freed slots, then tabs still folding, scaled to fit `max`. */
export function layoutSegments(stayed: TabKind[], freed: number, pending: TabKind[], max = MAX_SEGMENTS): Segment[] {
  const total = stayed.length + freed + pending.length;
  let s = stayed.length;
  let f = Math.max(0, freed);
  let p = pending.length;
  if (total > max) {
    const scale = max / total;
    s = s ? Math.max(1, Math.round(s * scale)) : 0;
    p = p ? Math.max(1, Math.round(p * scale)) : 0;
    f = f ? Math.max(1, max - s - p) : 0;
    while (s + f + p > max) {
      if (s >= p && s >= f && s > 1) s -= 1;
      else if (p >= f && p > 1) p -= 1;
      else if (f > 1) f -= 1;
      else break;
    }
  }
  return [
    ...bucket(stayed, s).map((kind) => ({ kind, pending: false })),
    ...Array.from({ length: f }, () => ({ kind: 'freed' as const, pending: false })),
    ...bucket(pending, p).map((kind) => ({ kind, pending: true })),
  ];
}

export interface MemoryCapsuleProps {
  /** Open tabs that stay, in tab order (at rest: every open tab). */
  stayed: TabKind[];
  /** Folded tabs whose memory is free now: empty slots after the stayed tabs. */
  freed?: number;
  /** Tabs still on their way into the fold capsule while a fold runs. */
  pending?: TabKind[];
  /** How full the fold capsule is, 0 to 1. */
  fill?: number;
  /** A fold is running: the fold capsule glows and the last tabs flow into it. */
  active?: boolean;
  /** 10 px tall in the popup, 14 px on pages. */
  size?: 'popup' | 'page';
  /** What the capsule shows, for screen readers. */
  label: string;
  /** With a fold running, the capsule is a progress bar. */
  progress?: { now: number; max: number };
  className?: string;
}

export function MemoryCapsule({
  stayed,
  freed = 0,
  pending = [],
  fill = 0,
  active = false,
  size = 'popup',
  label,
  progress,
  className,
}: MemoryCapsuleProps) {
  const dims = SIZES[size];
  const segments = layoutSegments(stayed, freed, pending);
  const n = segments.length;
  const signature = segments.map((s) => (s.kind === 'freed' ? 'f' : 'x')).join('');

  const trackRef = useRef<HTMLSpanElement>(null);
  const [pitch, setPitch] = useState(7);
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const inner = track.clientWidth - 2 * dims.pad;
      if (n > 0 && inner > 0) setPitch((inner + GAP_PX) / n);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [n, dims.pad]);

  // Tabs that just folded slide right and squeeze into the fold capsule (from the right, 15 ms apart).
  const previous = useRef<string | null>(null);
  const [leaving, setLeaving] = useState<Map<number, number>>(() => new Map());
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = signature;
    if (!before || before.length !== signature.length) return;
    const newly: number[] = [];
    for (let i = signature.length - 1; i >= 0; i -= 1) if (signature[i] === 'f' && before[i] !== 'f') newly.push(i);
    if (!newly.length) return;
    const step = Math.min(15, 600 / newly.length);
    setLeaving((current) => {
      const next = new Map(current);
      newly.forEach((index, rank) => next.set(index, Math.round(rank * step)));
      return next;
    });
    const timer = setTimeout(() => {
      setLeaving((current) => {
        const next = new Map(current);
        for (const index of newly) next.delete(index);
        return next;
      });
    }, 900 + newly.length * step);
    return () => clearTimeout(timer);
  }, [signature]);

  const hug = n > 0 ? n * MAX_SEGMENT_PX + (n - 1) * GAP_PX + 2 * dims.pad + 2 : 48;
  const toCapsule = dims.pad + 1 + dims.capGap + dims.capWidth / 2;
  const pendingCount = segments.filter((s) => s.pending).length;
  const pct = Math.round(Math.max(0, Math.min(1, fill)) * 100);

  return (
    <div
      role={progress ? 'progressbar' : 'img'}
      aria-label={label}
      aria-valuemin={progress ? 0 : undefined}
      aria-valuemax={progress?.max}
      aria-valuenow={progress?.now}
      data-size={size}
      className={cx('tf-cap', className)}
    >
      <span ref={trackRef} className="tf-cap-track" style={{ flex: `0 1 ${hug}px` }}>
        {segments.map((segment, i) => {
          const share = Math.round((100 * i) / Math.max(n - 1, 1));
          const style: Record<string, string | number> = {
            '--seg-c': `color-mix(in oklab, var(--tf-mem-to) ${share}%, var(--tf-mem-from))`,
          };
          let flow = false;
          if (segment.pending) {
            const fromRight = n - 1 - i;
            const grow = Math.max(0.25, Math.min(1, 0.25 + fromRight * 0.11));
            style.flexGrow = grow;
            if (active && fromRight < FLOWING && fromRight < pendingCount) {
              flow = true;
              style['--dx'] = `${Math.round((fromRight + 1) * pitch * grow + dims.flowExtra)}px`;
              style['--d'] = `${(FLOWING - fromRight) * 130}ms`;
            }
          }
          const delay = leaving.get(i);
          if (delay !== undefined) {
            style['--dx'] = `${Math.round((n - 1 - i) * pitch + toCapsule)}px`;
            style['--d'] = `${delay}ms`;
          }
          return (
            <span
              key={i}
              className="tf-seg"
              data-kind={segment.kind}
              data-flow={flow || undefined}
              data-leaving={delay !== undefined || undefined}
              style={style as CSSProperties}
            />
          );
        })}
      </span>
      <span className="tf-cap-fold" data-active={active || undefined} title="Fold capsule: tabs folded into your list">
        <span className="tf-cap-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

const GB = 1024 ** 3;

/** Bytes as gigabytes with one decimal ("2.1"), the unit the capsule's number always uses. */
export function formatGb(bytes: number): string {
  return (Math.max(0, bytes) / GB).toFixed(1);
}

/** Bytes in tenths of a gigabyte, for the rolling number. */
export function gbTenths(bytes: number): number {
  return Math.round((Math.max(0, bytes) / GB) * 10);
}

const NUMBER = {
  popup: { number: 32, unit: 15, check: 28, icon: 15, gap: 10 },
  page: { number: 48, unit: 18, check: 40, icon: 22, gap: 14 },
} as const;

/** "2.1 GB": the big light number above the capsule. */
export function BigNumber({
  value,
  unit = 'GB',
  size = 'popup',
  className,
}: {
  value: string;
  unit?: string;
  size?: 'popup' | 'page';
  className?: string;
}) {
  const s = NUMBER[size];
  return (
    <div className={cx('flex items-baseline tabular-nums gap-1.5 text-text', className)}>
      <span style={{ fontSize: s.number, lineHeight: 1, fontWeight: 400, letterSpacing: '-0.02em' }}>{value}</span>
      <span className="text-text-2" style={{ fontSize: s.unit }}>
        {unit}
      </span>
    </div>
  );
}

function OdometerColumn({ digits, roll }: { digits: string[]; roll: boolean }) {
  return (
    <span className="tf-odo-col">
      <span className={roll ? 'tf-odo-roll' : undefined} style={{ transform: `translateY(-${digits.length - 1}em)` }}>
        {digits.map((digit, i) => (
          <span key={i}>{digit}</span>
        ))}
      </span>
    </span>
  );
}

/** A number in tenths ("21" shows "2.1") that rolls up from `from` once, like an odometer. */
export function RollingNumber({ tenths, from }: { tenths: number; from?: number }) {
  const end = Math.max(0, Math.round(tenths));
  const start = from === undefined ? end : Math.max(0, Math.min(Math.round(from), end), end - 300);
  const whole: string[] = [];
  const decimal: string[] = [];
  for (let t = start; t <= end; t += 1) {
    const w = String(Math.floor(t / 10));
    if (whole[whole.length - 1] !== w) whole.push(w);
    decimal.push(String(t % 10));
  }
  const roll = start !== end;
  return (
    <>
      <OdometerColumn digits={whole} roll={roll} />
      <span>.</span>
      <OdometerColumn digits={decimal} roll={roll} />
    </>
  );
}

/**
 * "+2.1 GB freed" in green with a check whose ring pulses once when the number settles. Pass
 * `fromBytes` to roll up from that value (do it only when the fold finished while the page was open).
 */
export function FreedNumber({
  bytes,
  fromBytes,
  size = 'popup',
}: {
  bytes: number;
  fromBytes?: number;
  size?: 'popup' | 'page';
}) {
  const s = NUMBER[size];
  const tenths = gbTenths(bytes);
  const from = fromBytes === undefined ? undefined : gbTenths(fromBytes);
  const rolls = from !== undefined && from < tenths;
  return (
    <div className="flex items-center text-green" style={{ gap: s.gap }}>
      <span
        aria-hidden="true"
        data-pulse={rolls || undefined}
        className="tf-ring flex flex-none items-center justify-center rounded-full bg-green-soft text-green"
        style={{ width: s.check, height: s.check }}
      >
        <Check size={s.icon} strokeWidth={2.2} />
      </span>
      <div className="inline-flex items-end gap-1.5">
        <span
          aria-hidden="true"
          className="inline-flex tabular-nums"
          style={{ fontSize: s.number, lineHeight: 1, letterSpacing: '-0.02em' }}
        >
          +<RollingNumber tenths={tenths} from={from} />
        </span>
        <span
          aria-hidden="true"
          style={{ fontSize: s.unit, lineHeight: 1, paddingBottom: Math.round(s.number * 0.135 - s.unit * 0.135) }}
        >
          GB freed
        </span>
        <span className="sr-only">{formatGb(bytes)} GB freed</span>
      </div>
    </div>
  );
}
