import { Star } from 'lucide-react';
import { cx } from '../cx';

/** A starred folder's small filled star (Fi-* boards, `--tf-star`). Says "Starred" to screen readers. */
export function StarMark({ size = 12, label = true, className }: { size?: number; label?: boolean; className?: string }) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label ? 'Starred' : undefined}
      aria-hidden={label ? undefined : true}
      title="Starred"
      className={cx('inline-flex shrink-0 text-star', className)}
    >
      <Star size={size} fill="currentColor" strokeWidth={1.5} aria-hidden />
    </span>
  );
}
