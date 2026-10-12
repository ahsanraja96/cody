import type { ReactNode } from 'react';
import { cx } from '@/ui/cx';

/** "OPEN NOW · 3 windows", "FOLDED · 2,140" (Fi-Panel). */
export function PanelLabel({ children, count, className }: { children: ReactNode; count?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex h-9 items-center gap-1.5 px-2', className)}>
      <h2 className="m-0 text-meta font-semibold tracking-[.06em] text-text-3 uppercase">{children}</h2>
      {count !== undefined && count !== null && <span className="text-meta text-text-3 tabular-nums">· {count}</span>}
    </div>
  );
}

/** "Show 6 more folders", "Show 42 more". */
export function ShowMore({ children, onClick, indent = 30 }: { children: ReactNode; onClick: () => void; indent?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: indent }}
      className="flex h-[26px] w-full items-center rounded-control pr-2 text-left text-small text-text-3 hover:text-text"
    >
      {children}
    </button>
  );
}

export const DIVIDER = <div aria-hidden className="mx-2 my-1 h-px bg-border" />;
