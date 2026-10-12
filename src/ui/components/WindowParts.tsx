import { useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import type { OpenCopies } from '@/lib/openCopies';
import type { FolderRecord } from '@/lib/types';
import { cx } from '../cx';
import { COPIES_TIP, copiesText, WINDOW_NAME_MAX } from '../openTabs';
import type { WindowInfo } from '../windows';
import { FolderIcon } from './FolderIcon';

/**
 * Small pieces of a window row (1.0) shared by the popup, the side panel and the full list: its
 * name edited in place, the fold-back hint and "3 pages are open twice · Close the copies".
 */

/** A window's name edited in place (1.0): Enter saves, Esc cancels, leaving the field saves. */
export function WindowNameField({
  info,
  onDone,
  className,
}: {
  info: WindowInfo;
  /** `name` null: cancelled. */
  onDone: (name: string | null) => void;
  className?: string;
}) {
  const [name, setName] = useState(info.given);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? name : null);
  };
  return (
    <input
      autoFocus
      aria-label="Window name"
      aria-describedby="window-name-hint"
      placeholder={info.name}
      value={name}
      maxLength={WINDOW_NAME_MAX}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className={cx(
        'h-7 min-w-0 flex-1 rounded-md border border-accent bg-surface px-2 font-semibold text-text shadow-[0_0_0_3px_var(--tf-accent-soft)] outline-none',
        className,
      )}
    />
  );
}

/** "Its “Client sites” group folds back into the folder" under a window (Fi-Popup). */
export function FoldBackHint({ folders, text }: { folders: readonly FolderRecord[]; text: string }) {
  const first = folders[0];
  if (!first) return null;
  return (
    <div className="-mt-1 flex items-center gap-1.5 pr-2 pb-1.5 pl-[34px] text-meta text-text-3">
      <FolderIcon color={first.color} size={12} />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}

/** "3 pages are open twice · Close the copies" (Fi-Fold-States), under the windows. */
export function CopiesLine({ copies, onClose, className }: { copies: OpenCopies; onClose: () => void; className?: string }) {
  if (copies.pages === 0) return null;
  return (
    <div role="status" className={cx('flex min-h-8 items-center gap-2 text-small text-text-2', className)}>
      <Copy size={14} strokeWidth={1.75} aria-hidden className="flex-none text-text-3" />
      <span>{copiesText(copies)}</span>
      <span aria-hidden className="text-text-3">
        ·
      </span>
      <button type="button" title={COPIES_TIP} onClick={onClose} className="font-semibold text-accent-text hover:underline">
        Close the copies
      </button>
    </div>
  );
}
