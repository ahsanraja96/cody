import { Button } from '@/ui/components/Button';
import { cx } from '@/ui/cx';
import type { RestoreProgressInfo } from './flows/progress';

/** Big restores open 10 tabs at a time; the floating card shows from 20 tabs up. */
export const FLOATING_PROGRESS_FROM = 20;

function ProgressBar({ done, total, label, className }: { done: number; total: number; label: string; className?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className={cx('overflow-hidden rounded-full', className)}
    >
      <div className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * In the session detail panel, in place of the restore buttons: "Restoring Checkout app",
 * "Window 2 of 3 · 12 of 24 tabs", a bar and Cancel.
 */
export function RestoreProgressBlock({ progress, onCancel }: { progress: RestoreProgressInfo; onCancel: () => void }) {
  const windowLine =
    progress.windowCount && progress.windowCount > 1 && progress.windowIndex !== undefined
      ? `Window ${Math.min(progress.windowIndex + 1, progress.windowCount)} of ${progress.windowCount} · `
      : '';
  const counts = `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} tabs`;
  return (
    <div
      role="status"
      aria-label={`Restoring ${progress.name}: ${windowLine ? `window ${(progress.windowIndex ?? 0) + 1} of ${progress.windowCount}, ` : ''}${counts}`}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface py-3.5 pr-3.5 pl-4"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold" dir="auto">
            Restoring {progress.name}
          </div>
          <div className="text-small text-text-2">
            {windowLine}
            {counts}
          </div>
        </div>
        <Button size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ProgressBar done={progress.done} total={progress.total} label="Tabs restored" className="h-1.5 bg-border" />
      <p className="text-meta text-text-3">Background tabs load once, then sleep until you click them.</p>
    </div>
  );
}

/** Library, floating bottom right, for restores of 20+ tabs whose session isn't open in the detail panel. */
export function RestoreProgressFloating({ progress, onCancel }: { progress: RestoreProgressInfo; onCancel: () => void }) {
  if (progress.total < FLOATING_PROGRESS_FROM) return null;
  return (
    <div
      role="status"
      aria-label={`Opening ${progress.total.toLocaleString()} tabs, ${progress.done.toLocaleString()} done`}
      className="anim-in fixed right-6 bottom-6 z-40 w-[min(360px,calc(100vw-48px))] rounded-card border border-border bg-surface p-4 shadow-pop"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate font-semibold">Opening {progress.total.toLocaleString()} tabs in batches of 10</span>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ProgressBar done={progress.done} total={progress.total} label="Tabs opened" className="mt-2.5 h-1 bg-hover" />
      <p className="mt-2 text-meta text-text-3">
        {progress.done.toLocaleString()} of {progress.total.toLocaleString()} · background tabs sleep until you click them
      </p>
    </div>
  );
}

/** Backwards-compatible name for the floating card. */
export const RestoreProgress = RestoreProgressFloating;
