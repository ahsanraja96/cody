import type { ReactNode } from 'react';
import { AppWindow, Download, GitMerge, Tag, Trash2, X } from 'lucide-react';
import { plural } from '@/lib/format';
import { ProLock } from '@/ui/components/Chips';
import { cx } from '@/ui/cx';

function BarButton({
  icon,
  children,
  onClick,
  danger,
  label,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-2 rounded-control px-2.5 whitespace-nowrap transition-colors duration-150 hover:bg-hover',
        danger ? 'font-semibold text-red' : 'text-text',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

const Divider = () => <span aria-hidden className="h-6 w-px shrink-0 bg-border" />;

/** Floating actions for the sessions picked with checkboxes, ⌘/Ctrl-click or Shift-click. */
export function BulkBar({
  count,
  tabs,
  onRestore,
  onTag,
  onExport,
  onMerge,
  onTrash,
  onClear,
}: {
  count: number;
  tabs: number;
  onRestore: () => void;
  onTag: () => void;
  onExport: () => void;
  onMerge: () => void;
  onTrash: () => void;
  onClear: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label={`Actions for ${plural(count, 'selected session')}`}
      className="anim-in absolute bottom-6 left-1/2 z-30 flex h-[52px] max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-card border border-border-strong bg-surface pr-2 pl-4 shadow-pop [scrollbar-width:none]"
    >
      <span aria-live="polite" className="mr-1.5 inline-flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
        <span className="font-semibold">{count.toLocaleString()} selected</span>
        <span className="text-small text-text-3">{plural(tabs, 'tab')}</span>
      </span>
      <Divider />
      <BarButton icon={<AppWindow size={16} aria-hidden />} onClick={onRestore}>
        Restore
      </BarButton>
      <BarButton icon={<Tag size={16} aria-hidden />} onClick={onTag}>
        Add tag
      </BarButton>
      <BarButton icon={<Download size={16} aria-hidden />} onClick={onExport}>
        Export
      </BarButton>
      <BarButton icon={<GitMerge size={16} aria-hidden />} onClick={onMerge} label="Merge, a Pro feature">
        <span className="text-text-2">Merge</span>
        <ProLock />
      </BarButton>
      <Divider />
      <BarButton icon={<Trash2 size={16} aria-hidden />} onClick={onTrash} danger>
        Move to Trash
      </BarButton>
      <Divider />
      <button
        type="button"
        aria-label="Clear selection"
        title="Clear selection (Esc)"
        onClick={onClear}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control pr-1.5 pl-2 text-small text-text-2 hover:bg-hover hover:text-text"
      >
        <X size={16} aria-hidden />
        <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border-strong bg-surface px-1 text-meta text-text-3">
          esc
        </kbd>
      </button>
    </div>
  );
}
