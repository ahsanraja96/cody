import { Sparkles, TriangleAlert, X } from 'lucide-react';
import { FREE_LIMITS } from '@/lib/limits';
import { cx } from '../cx';

const PRIMARY_SM =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-3 text-small font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60';
const SECONDARY_SM =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3 text-small font-semibold text-text hover:bg-hover disabled:opacity-60';

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "Your free list is full" (Fo-Popup-Full): under the paused Fold button in the popup. */
export function FullCard({ onUpgrade, onMakeRoom, className }: { onUpgrade: () => void; onMakeRoom: () => void; className?: string }) {
  return (
    <section role="status" className={cx('rounded-card border border-amber-line bg-amber-soft p-3.5', className)}>
      <div className="flex items-center gap-2 font-semibold">
        <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-amber" />
        Your free list is full
      </div>
      <p className="mt-1 mb-3 text-small text-text-2">
        It holds {FREE_LIMITS.tabs} folded tabs. Remove some old ones, or upgrade for unlimited. Fold is paused until there’s room.
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={onUpgrade} className={PRIMARY_SM}>
          <Sparkles size={14} strokeWidth={1.75} aria-hidden />
          Upgrade
        </button>
        <button type="button" onClick={onMakeRoom} className={SECONDARY_SM}>
          Make room
        </button>
      </div>
    </section>
  );
}

/** "This fold needs room for 23 tabs" (Fo-Limit-States): Fold never saves half a window. */
export function NeedsRoomCard({
  needed,
  room,
  onMakeRoom,
  onUpgrade,
  onDismiss,
  className,
}: {
  needed: number | undefined;
  room: number | undefined;
  onMakeRoom: () => void;
  onUpgrade: () => void;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <section role="alert" className={cx('rounded-card border border-amber-line bg-amber-soft p-3.5', className)}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 font-semibold">{needed ? `This fold needs room for ${plural(needed, 'tab')}` : 'This fold doesn’t fit in your free list'}</div>
        {onDismiss && (
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={onDismiss}
            className="-mt-1 -mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
      <p className="mt-1 mb-3 text-small text-text-2">Your free list has room for {(room ?? 0).toLocaleString()}. Make room, or upgrade for unlimited.</p>
      <div className="flex gap-2">
        <button type="button" onClick={onUpgrade} className={PRIMARY_SM}>
          <Sparkles size={14} strokeWidth={1.75} aria-hidden />
          Upgrade
        </button>
        <button type="button" onClick={onMakeRoom} className={SECONDARY_SM}>
          Make room
        </button>
      </div>
    </section>
  );
}

/** "18 spaces left in your free list · Upgrade" under the Fold button from 450 tabs (Fo-Limit-States). */
export function SpacesLeft({ room, onUpgrade, id }: { room: number; onUpgrade: () => void; id?: string }) {
  return (
    <p id={id} className="mt-2.5 text-small text-text-2">
      <span className="font-semibold text-amber">{plural(room, 'space')} left</span> in your free list ·{' '}
      <button type="button" onClick={onUpgrade} className="font-semibold text-accent-text hover:underline">
        Upgrade
      </button>
    </p>
  );
}
