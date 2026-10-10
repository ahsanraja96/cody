import { useEffect, useRef, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';

export interface PopupToast {
  id: number;
  message: string;
  action?: { label: string; onClick: () => void };
}

const WITH_ACTION_MS = 10_000;
const PLAIN_MS = 5_000;

function ToastShell({
  children,
  action,
  onDismiss,
}: {
  children: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  onDismiss: () => void;
}) {
  return (
    <div className="anim-in pointer-events-auto flex min-h-11 w-full items-center gap-2.5 rounded-card bg-inverse py-1.5 pr-1.5 pl-3.5 text-on-inverse shadow-pop">
      <Check size={16} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action && (
        <button
          type="button"
          disabled={action.disabled}
          className="h-[30px] shrink-0 rounded-md px-2.5 font-semibold underline underline-offset-2 hover:bg-white/10 disabled:opacity-60"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md hover:bg-white/10"
        onClick={onDismiss}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

function TimedToast({ toast, onDismiss }: { toast: PopupToast; onDismiss: (id: number) => void }) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const hasAction = !!toast.action;
  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current(toast.id), hasAction ? WITH_ACTION_MS : PLAIN_MS);
    return () => clearTimeout(timer);
  }, [toast.id, hasAction]);
  return (
    <ToastShell
      onDismiss={() => onDismiss(toast.id)}
      action={
        toast.action && {
          label: toast.action.label,
          onClick: () => {
            toast.action!.onClick();
            onDismiss(toast.id);
          },
        }
      }
    >
      {toast.message}
    </ToastShell>
  );
}

/**
 * Toasts sit just above the footer. The Undo toast (a save made before this popup opened) counts
 * down the seconds left, like the library's.
 */
export function PopupToasts({
  toasts,
  onDismiss,
  undo,
}: {
  toasts: PopupToast[];
  onDismiss: (id: number) => void;
  undo: { message: string; secondsLeft: number; busy: boolean; onUndo: () => void; onDismiss: () => void } | null;
}) {
  if (!toasts.length && !undo) return null;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-3 bottom-[52px] z-20 flex flex-col gap-2 max-[360px]:bottom-11">
      {undo && (
        <ToastShell action={{ label: 'Undo', onClick: undo.onUndo, disabled: undo.busy }} onDismiss={undo.onDismiss}>
          {undo.message} · {undo.secondsLeft}s left
        </ToastShell>
      )}
      {toasts.map((toast) => (
        <TimedToast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
