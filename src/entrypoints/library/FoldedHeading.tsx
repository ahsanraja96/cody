import { FolderPlus, Sparkles } from 'lucide-react';
import { cx } from '@/ui/cx';
import { count } from './format';

const BUTTON =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3.5 text-small font-semibold text-text hover:bg-hover';

/**
 * The "Folded" heading row (Fo-List, Fo-Limit-States): "16 of 500 tabs · 2 folders" on Free (the
 * count amber from 450), "16 tabs · 2 folders" on paid plans, then "New folder" and the quiet
 * "Organise with AI".
 */
export function FoldedHeading({
  tabs,
  limit,
  near,
  folders,
  spaced,
  onNewFolder,
  onOrganise,
}: {
  tabs: number;
  /** The free list's limit; null on paid plans. */
  limit: number | null;
  /** 450 or more on Free: the count turns amber. */
  near: boolean;
  folders: number;
  /** Recent folds sit above it. */
  spaced: boolean;
  onNewFolder: () => void;
  onOrganise: () => void;
}) {
  const tabsText = limit !== null ? `${tabs.toLocaleString()} of ${limit.toLocaleString()} tabs` : count(tabs, 'tab');
  return (
    <div className={cx('mb-1 flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-2 px-0.5', spaced && 'mt-7')}>
      <h1 className="m-0 text-page leading-[1.45] font-semibold">Folded</h1>
      <span className="text-text-3">
        <span className={cx('tabular-nums', near && 'font-semibold text-amber')}>{tabsText}</span>
        {' · '}
        {folders > 0 ? count(folders, 'folder') : 'newest first'}
      </span>
      <span className="min-w-0 flex-1" />
      <button type="button" onClick={onNewFolder} className={BUTTON}>
        <FolderPlus size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
        New folder
      </button>
      <button
        type="button"
        onClick={onOrganise}
        title="Puts your folded tabs into folders. You see the folders first and choose."
        className={cx(BUTTON, 'font-semibold')}
      >
        <Sparkles size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
        Organise with AI
      </button>
    </div>
  );
}
