import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import type { PlanState } from '@/lib/pro/types';
import { cx } from '../cx';
import { planChipLabel } from '../pro';

type Tone = 'accent' | 'green' | 'neutral';

const TONES: Record<Tone, string> = {
  accent: 'bg-accent-soft text-accent-text',
  green: 'bg-green-soft text-green',
  neutral: 'bg-hover text-text-2',
};

/** A small rounded label (Pro boards): "7-day free trial · no card", "Your plan", "5 days left". */
export function Chip({ children, tone = 'accent', small = false, className }: { children: ReactNode; tone?: Tone; small?: boolean; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 text-meta leading-none font-semibold whitespace-nowrap',
        small ? 'h-[18px] rounded-[5px] px-1.5' : 'h-5 rounded-md px-[7px]',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The plan next to "Tabfold" in the top bar: Sparkles + "Pro", "Pro AI" or "Pro AI trial". Nothing on Free. */
export function PlanChip({ plan, className }: { plan: PlanState; className?: string }) {
  const label = planChipLabel(plan);
  if (!label) return null;
  return (
    <Chip className={className}>
      <Sparkles size={11} strokeWidth={2} aria-hidden />
      {label}
    </Chip>
  );
}

/** "Pro" or "Pro AI" on a control that needs it (menus, Export). */
export function ProTag({ label = 'Pro' }: { label?: string }) {
  return (
    <Chip small>
      <Sparkles size={10} strokeWidth={2} aria-hidden />
      {label}
    </Chip>
  );
}

/**
 * "✦ Upgrade" for Free (Up-List, Up-Popup): a quiet accent button next to Settings that opens
 * the plans page. 36px in the full list's top bar, 32px in the popup's header.
 */
export function UpgradeButton({ onClick, size = 'md', className }: { onClick: () => void; size?: 'md' | 'sm'; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="See Pro and Pro AI"
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-control border border-accent-line bg-accent-soft font-semibold text-accent-text hover:brightness-95',
        size === 'md' ? 'h-9 px-3 text-body' : 'h-8 px-[9px] text-small',
        className,
      )}
    >
      <Sparkles size={size === 'md' ? 14 : 13} strokeWidth={1.9} aria-hidden />
      Upgrade
    </button>
  );
}

/** "Pro AI trial · 5 days left" in the Upgrade button's place while the trial runs; opens the plans page. */
export function TrialChip({ days, onClick, className }: { days: number; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="See plans"
      className={cx('inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-accent-soft px-2 text-meta font-semibold text-accent-text hover:brightness-95', className)}
    >
      <Sparkles size={11} strokeWidth={2} aria-hidden />
      Pro AI trial · {days === 1 ? '1 day left' : `${days} days left`}
    </button>
  );
}
