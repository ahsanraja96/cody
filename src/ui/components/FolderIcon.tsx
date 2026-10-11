import { Folder } from 'lucide-react';
import type { TabGroupColor } from '@/lib/types';
import { cx } from '../cx';
import './FoldedList.css';

/** A folder in its colour (Chrome's tab group colours, like the kinds of site). */
export function FolderIcon({ color, size = 16, className }: { color: TabGroupColor; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cx('flex shrink-0', `tf-cg-${color}`, className)} style={{ color: 'var(--tf-cg)' }}>
      <Folder size={size} strokeWidth={1.9} />
    </span>
  );
}

/** A small round swatch of a tab group colour. */
export function ColorDot({ color, size = 10 }: { color: TabGroupColor; size?: number }) {
  return <span aria-hidden className={cx('tf-cg-dot', `tf-cg-${color}`)} style={{ width: size, height: size }} />;
}
