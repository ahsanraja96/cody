import { useEffect, useState, type ReactNode } from 'react';
import { Check, CircleAlert, X } from 'lucide-react';
import { create } from 'zustand';
import { cx } from '../cx';

export interface ToastItem {
  id: number;
  message: string;
  tone: 'default' | 'success' | 'error';
  actions: Array<{ label: string; onClick: () => void }>;
  duration: number;
  /** When the toast goes away; with `countdown` the message shows the seconds left ("· 6s left"). */
  expiresAt: number;
  countdown: boolean;
  /** Replaces the tone's icon (e.g. a stop sign for a cancelled restore). */
  icon?: ReactNode;
  /** Read once by screen readers instead of the visible text (which may tick every second). */
  announce?: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, 'id'>) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts.slice(-2), { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

type ToastAction = ToastItem['actions'][number];

export interface ToastOptions {
  tone?: ToastItem['tone'];
  action?: ToastAction;
  actions?: ToastAction[];
  duration?: number;
  /** Show the seconds left after the message, for undoable actions. */
  countdown?: boolean;
  icon?: ReactNode;
  announce?: string;
}

export function toast(message: string, options: ToastOptions = {}): number {
  const actions = options.actions ?? (options.action ? [options.action] : []);
  const duration = options.duration ?? (actions.length ? 10_000 : 4_000);
  return useToasts.getState().push({
    message,
    tone: options.tone ?? 'default',
    actions,
    duration,
    expiresAt: Date.now() + duration,
    countdown: options.countdown ?? false,
    icon: options.icon,
    announce: options.announce,
  });
}

export function dismissToast(id: number): void {
  useToasts.getState().dismiss(id);
}

/** Run the newest visible toast's "Undo" (for ⌘Z / Ctrl+Z). Returns false when there is nothing to undo. */
export function triggerLatestUndo(): boolean {
  const { toasts, dismiss } = useToasts.getState();
  for (let i = toasts.length - 1; i >= 0; i -= 1) {
    const item = toasts[i]!;
    const undo = item.actions.find((a) => a.label === 'Undo');
    if (undo && item.expiresAt > Date.now()) {
      undo.onClick();
      dismiss(item.id);
      return true;
    }
  }
  return false;
}

function useSecondsLeft(item: ToastItem): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!item.countdown) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [item.countdown]);
  return Math.max(0, Math.ceil((item.expiresAt - now) / 1000));
}

function ToastView({ item }: { item: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  const secondsLeft = useSecondsLeft(item);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), Math.max(0, item.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [item.id, item.expiresAt, dismiss]);
  const icon =
    item.icon ??
    (item.tone === 'error' ? <CircleAlert size={16} aria-hidden className="shrink-0" /> : <Check size={16} aria-hidden className="shrink-0" />);
  return (
    <div
      role={item.tone === 'error' ? 'alert' : undefined}
      className="anim-in pointer-events-auto flex h-11 w-[min(420px,100%)] min-w-0 items-center gap-2.5 rounded-card bg-inverse pr-1.5 pl-3.5 text-on-inverse shadow-pop"
    >
      <span className="flex shrink-0" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate" aria-hidden={item.announce ? true : undefined}>
        {item.message}
        {item.countdown && <span aria-hidden> · {secondsLeft}s left</span>}
      </span>
      {item.announce && <span className="sr-only">{item.announce}</span>}
      {item.actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="h-[30px] shrink-0 rounded-md px-2.5 font-semibold underline underline-offset-2 hover:bg-white/10 focus-visible:outline-on-inverse"
          onClick={() => {
            action.onClick();
            dismiss(item.id);
          }}
        >
          {action.label}
        </button>
      ))}
      <button
        type="button"
        aria-label="Dismiss"
        className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md hover:bg-white/10 focus-visible:outline-on-inverse"
        onClick={() => dismiss(item.id)}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

export function ToastViewport({ className }: { className?: string }) {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx('pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2 px-4', className)}
    >
      {toasts.map((item) => (
        <ToastView key={item.id} item={item} />
      ))}
    </div>
  );
}
