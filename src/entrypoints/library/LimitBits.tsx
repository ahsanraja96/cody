import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Sparkles, TriangleAlert, X } from 'lucide-react';
import { FREE_LIMITS } from '@/lib/limits';
import { send, type RoomFold, type RoomList } from '@/lib/messages';
import { Modal } from '@/ui/components/Modal';
export { NeedsRoomCard } from '@/ui/components/LimitCards';
import { toast, ToastViewport } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { useFoldedCount } from '@/ui/hooks';
import { proErrorText } from '@/ui/pro';
import { exportAll } from './actions';
import { handleCommandError, undoAction } from './folderActions';
import { count } from './format';
import { goToPlans } from './router';

const PRIMARY_SM =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-3 text-small font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60';
const SECONDARY_SM =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3 text-small font-semibold text-text hover:bg-hover disabled:opacity-60';

/**
 * "Your free list is full: 500 of 500 tabs" (Fo-Limit-States), at the top of the full list while
 * the free list is full, or after a fold that didn't fit was started where no page could say so
 * (the shortcut, a rule).
 */
export function FullBanner({
  tabs,
  full,
  onMakeRoom,
  onDismiss,
}: {
  tabs: number;
  full: boolean;
  onMakeRoom: () => void;
  /** Only for the "a fold didn't fit" line; the full banner stays while the list is full. */
  onDismiss?: () => void;
}) {
  const limit = FREE_LIMITS.tabs;
  return (
    <div role="status" className="flex items-center gap-3 rounded-card border border-amber-line bg-amber-soft py-3 pr-3 pl-4 max-[720px]:flex-wrap">
      <TriangleAlert size={18} strokeWidth={1.75} aria-hidden className="shrink-0 text-amber" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">
          {full ? 'Your free list is full' : 'A fold didn’t fit'}: {tabs.toLocaleString()} of {limit.toLocaleString()} tabs
        </div>
        <div className="text-small text-text-2">
          {full
            ? 'Fold is paused until there’s room. Remove some old tabs, or upgrade for unlimited tabs and folders.'
            : 'Nothing was closed. Remove some old tabs, or upgrade for unlimited tabs and folders.'}
        </div>
      </div>
      <button type="button" onClick={onMakeRoom} className={SECONDARY_SM}>
        Make room
      </button>
      <button type="button" onClick={goToPlans} className={PRIMARY_SM}>
        <Sparkles size={14} strokeWidth={1.75} aria-hidden />
        Upgrade
      </button>
      {onDismiss && !full && (
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </div>
  );
}

const DAY = 24 * 3_600_000;

/** "Folded 10 weeks ago". */
export function foldedAgo(timestamp: number, now = Date.now()): string {
  const days = Math.floor((now - timestamp) / DAY);
  if (days < 1) return 'Folded today';
  if (days === 1) return 'Folded yesterday';
  if (days < 14) return `Folded ${days} days ago`;
  if (days < 180) return `Folded ${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30);
  return months < 24 ? `Folded ${months} months ago` : `Folded ${Math.floor(days / 365)} years ago`;
}

function foldTitle(fold: RoomFold): string {
  const date = new Date(fold.createdAt);
  const day = date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day} · ${count(fold.windowCount, 'window')}`;
}

/** "2 months ago" for the older-than line. */
function olderText(days: number): string {
  return days % 30 === 0 && days >= 60 ? `${days / 30} months` : `${days} days`;
}

/**
 * "Make room" (Fo-Limit-States): the oldest folds with Remove (Undo for each), "Everything folded
 * more than 2 months ago", Export everything first, and Upgrade instead. The bar shows the room as
 * you go.
 */
export function MakeRoomDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const live = useFoldedCount();
  const [list, setList] = useState<RoomList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Map<string, string | null>>(() => new Map());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setProblem(null);
    setRemoved(new Map());
    send({ type: 'room-list' })
      .then((result) => alive && setList(result))
      .catch((error) => alive && setProblem(proErrorText(error)));
    return () => {
      alive = false;
    };
  }, [open]);

  const limit = list?.limit ?? FREE_LIMITS.tabs;
  const tabs = live?.tabs ?? list?.tabs ?? 0;
  const roomFor = Math.max(0, limit - tabs);

  const remove = async (key: string, command: { sessionIds?: string[]; olderThanDays?: number }) => {
    setBusy(key);
    try {
      const { actionId } = await send({ type: 'room-free', ...command });
      setRemoved((m) => new Map(m).set(key, actionId));
    } catch (error) {
      handleCommandError(error);
    } finally {
      setBusy(null);
    }
  };
  const undo = async (key: string) => {
    const actionId = removed.get(key);
    setRemoved((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
    if (actionId) await undoAction(actionId);
  };

  const removedTag = (key: string) => (
    <span role="status" className="inline-flex shrink-0 items-center gap-1 text-small font-semibold text-green">
      <Check size={14} strokeWidth={2.2} aria-hidden />
      Removed ·{' '}
      {removed.get(key) ? (
        <button type="button" onClick={() => void undo(key)} className="font-semibold text-accent-text hover:underline">
          Undo
        </button>
      ) : null}
    </span>
  );

  const older = list?.olderThan;
  return (
    <Modal open={open} onClose={onClose} labelledBy="mr-h" width={520} toasts>
      <div className="flex max-h-[min(720px,calc(100vh-32px))] flex-col">
        <header className="flex items-start gap-3 pt-5 pr-4 pb-1.5 pl-6">
          <div className="min-w-0 flex-1">
            <h2 id="mr-h" className="m-0 text-page font-semibold">
              Make room
            </h2>
            <p className="mt-1.5 mb-0 text-text-2">Your oldest folds first. Removing them frees space; export first if you want a copy.</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
          >
            <X size={18} strokeWidth={1.75} aria-hidden />
          </button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pt-2.5">
          <div className="mb-1.5 flex items-center justify-between text-small text-text-2">
            <span className="tabular-nums">
              {tabs.toLocaleString()} of {limit.toLocaleString()} tabs
            </span>
            <span role="status" className={cx('font-semibold', roomFor > 0 ? 'text-green' : 'text-amber')}>
              {roomFor > 0 ? `Room for ${roomFor.toLocaleString()} more` : 'No room yet'}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Your free list"
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(tabs, limit)}
            className="h-1.5 overflow-hidden rounded-[3px] bg-hover"
          >
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.min(100, (tabs / limit) * 100)}%` }} />
          </div>
          <div className="mt-3">
            {problem && (
              <p role="alert" className="m-0 border-t border-border py-3 text-small text-red">
                {problem}
              </p>
            )}
            {!list && !problem && (
              <p role="status" className="m-0 flex items-center gap-2 border-t border-border py-3 text-small text-text-3">
                <LoaderCircle size={14} aria-hidden className="tf-spin" />
                Finding your oldest folds…
              </p>
            )}
            {list?.folds.map((fold) => {
              const gone = removed.has(fold.sessionId);
              return (
                <div key={fold.sessionId} className="flex h-12 items-center gap-3 border-t border-border px-1">
                  <div className={cx('min-w-0 flex-1', gone && 'opacity-55')} title={fold.name}>
                    <div className="truncate font-semibold">{foldTitle(fold)}</div>
                    <div className="text-small text-text-3">{foldedAgo(fold.createdAt)}</div>
                  </div>
                  <span className={cx('w-16 shrink-0 text-right text-small text-text-2 tabular-nums', gone && 'opacity-55')}>{count(fold.tabCount, 'tab')}</span>
                  {gone ? (
                    removedTag(fold.sessionId)
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove the fold from ${foldTitle(fold)}, ${count(fold.tabCount, 'tab')}`}
                      disabled={busy !== null}
                      onClick={() => void remove(fold.sessionId, { sessionIds: [fold.sessionId] })}
                      className={cx(SECONDARY_SM, 'h-7 px-2.5')}
                    >
                      {busy === fold.sessionId && <LoaderCircle size={12} aria-hidden className="tf-spin" />}
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
            {list && list.folds.length === 0 && <p className="m-0 border-t border-border py-3 text-small text-text-3">Nothing folded yet.</p>}
            {older && older.tabs > 0 && (
              <div className="mt-2 flex items-center gap-2.5 rounded-control bg-bg-subtle p-3">
                <span className="min-w-0 flex-1 text-small text-text-2">
                  Everything folded more than {olderText(older.days)} ago · {count(older.tabs, 'tab')}
                </span>
                {removed.has('older') ? (
                  removedTag('older')
                ) : (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void remove('older', { olderThanDays: older.days })}
                    className={cx(SECONDARY_SM, 'h-7 px-2.5')}
                  >
                    {busy === 'older' && <LoaderCircle size={12} aria-hidden className="tf-spin" />}
                    Remove all {older.tabs.toLocaleString()}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <footer className="mt-3 flex items-center gap-3 border-t border-border px-6 pt-4 pb-5">
          <span className="min-w-0 flex-1">
            <button
              type="button"
              onClick={async () => {
                const n = await exportAll('html');
                if (n > 0) toast(`Exported ${count(n, 'tab')}. Now you can make room.`, { tone: 'success' });
              }}
              className="text-small font-semibold text-accent-text hover:underline"
            >
              Export everything first
            </button>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 shrink-0 items-center rounded-control border border-border-strong bg-surface px-3.5 text-text hover:bg-hover"
          >
            Done
          </button>
          <button
            type="button"
            data-autofocus
            onClick={() => {
              onClose();
              goToPlans();
            }}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-control bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover"
          >
            <Sparkles size={16} strokeWidth={1.75} aria-hidden />
            Upgrade instead
          </button>
        </footer>
        <ToastViewport inDialog />
      </div>
    </Modal>
  );
}
