import type { ReactNode } from 'react';
import { AlertTriangle, CircleAlert, Info } from 'lucide-react';
import { cx } from '../cx';

type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'accent';

const TONES: Record<Tone, string> = {
  neutral: 'border-border bg-bg-subtle text-text',
  success: 'border-green-line bg-green-soft text-green',
  warning: 'border-amber-line bg-amber-soft text-amber',
  error: 'border-red-line bg-red-soft text-red',
  accent: 'border-accent-line bg-accent-soft text-accent-text',
};

const ICONS: Partial<Record<Tone, ReactNode>> = {
  warning: <AlertTriangle size={16} aria-hidden />,
  error: <CircleAlert size={16} aria-hidden />,
  neutral: <Info size={16} aria-hidden />,
};

export function Banner({
  tone = 'neutral',
  icon,
  title,
  children,
  actions,
  className,
  role,
}: {
  tone?: Tone;
  icon?: ReactNode | null;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: 'status' | 'alert';
}) {
  const shownIcon = icon === undefined ? ICONS[tone] : icon;
  return (
    <div role={role} className={cx('flex items-start gap-2.5 rounded-card border px-3 py-2.5', TONES[tone], className)}>
      {shownIcon && <span className="mt-px shrink-0">{shownIcon}</span>}
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx(title ? 'text-text-2' : '', 'text-body')}>{children}</div>}
        {actions && <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
