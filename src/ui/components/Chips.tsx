import type { ReactNode } from 'react';
import { Check, Plus, Sparkles, X } from 'lucide-react';
import { planLabel, type Plan } from '@/lib/limits';
import { cx } from '../cx';

/** Keyword on a saved tab. "match" highlights a keyword the current search matched. */
export function KeywordChip({ keyword, match = false }: { keyword: string; match?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-meta',
        match ? 'bg-accent-soft font-semibold text-accent-text' : 'bg-hover text-text-2',
      )}
    >
      {keyword}
    </span>
  );
}

/** Pickable keyword in the keyword editor: picked (accent, check) or suggested (dashed, plus). */
export function PickChip({ keyword, picked, onToggle }: { keyword: string; picked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onToggle}
      className={cx(
        'inline-flex h-[26px] items-center gap-1 rounded-md pr-2.5 pl-2 text-small',
        picked
          ? 'border border-accent-line bg-accent-soft font-semibold text-accent-text'
          : 'border border-dashed border-border-strong text-text-2 hover:bg-hover',
      )}
    >
      {picked ? <Check size={12} strokeWidth={2.5} aria-hidden /> : <Plus size={12} strokeWidth={2.2} aria-hidden />}
      {keyword}
    </button>
  );
}

/** Removable chip inside the keyword input. */
export function InputChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-6 items-center gap-0.5 rounded-md bg-accent-soft pr-0.5 pl-2 text-small font-semibold text-accent-text">
      {label}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="inline-flex size-5 items-center justify-center rounded hover:bg-accent-line/40"
      >
        <X size={12} strokeWidth={2.2} aria-hidden />
      </button>
    </span>
  );
}

const TAG_COLORS = ['#6E78E6', '#14A38B', '#8A63D2', '#E59A2F', '#D9608C', '#3B8FD9', '#7FA32B', '#C2410C'];

export function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) hash = (hash * 33 + tag.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]!;
}

/** Session tag: a colour dot plus the name, so colour is never the only signal. */
export function TagChip({ tag, onRemove, size = 'sm' }: { tag: string; onRemove?: () => void; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border border-border text-meta text-text-2',
        size === 'sm' ? 'h-5 px-2' : 'h-[22px] px-2',
        onRemove && 'pr-0.5',
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: tagColor(tag) }} />
      {tag}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove tag ${tag}`}
          onClick={onRemove}
          className="inline-flex size-[18px] items-center justify-center rounded-full text-text-3 hover:bg-hover"
        >
          <X size={11} aria-hidden />
        </button>
      )}
    </span>
  );
}

export function PlanBadge({ plan }: { plan: Plan }) {
  if (plan === 'free') {
    return (
      <span className="inline-flex h-[22px] items-center rounded-full border border-border-strong px-2 text-meta font-semibold text-text-2">
        Free
      </span>
    );
  }
  return (
    <span className="inline-flex h-[22px] items-center gap-1 rounded-full border border-accent-line bg-accent-soft px-2 text-meta font-semibold text-accent-text">
      {plan === 'pro-ai' && <Sparkles size={11} aria-hidden />}
      {planLabel(plan)}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border-strong bg-surface px-1 text-meta text-text-2',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Badge({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'neutral' }) {
  return (
    <span
      className={cx(
        'inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-meta font-semibold',
        tone === 'accent' ? 'bg-accent-soft text-accent-text' : 'bg-hover text-text-2',
      )}
    >
      {children}
    </span>
  );
}
