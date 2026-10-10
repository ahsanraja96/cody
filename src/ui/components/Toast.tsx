import { useEffect } from 'react';
import { Check, CircleAlert, X } from 'lucide-react';
import { create } from 'zustand';
import { cx } from '../cx';

export interface ToastItem {
  id: number;
  message: string;
  tone: 'default' | 'success' | 'error';
  actions: Array<{ label: string; onClick: () => void }>;
  duration: number;
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

export function toast(
  message: string,
  options: { tone?: ToastItem['tone']; action?: ToastAction; actions?: ToastAction[]; duration?: number } = {},
): number {
  const actions = options.actions ?? (options.action ? [options.action] : []);
  return useToasts.getState().push({
    message,
    tone: options.tone ?? 'default',
    actions,
    duration: options.duration ?? (actions.length ? 10_000 : 4_000),
  });
}

function ToastView({ item }: { item: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, dismiss]);
  return (
    <div className="anim-in pointer-events-auto flex h-11 min-w-[280px] max-w-[520px] items-center gap-2.5 rounded-card bg-inverse pr-1.5 pl-3.5 text-on-inverse shadow-pop">
      {item.tone === 'error' ? (
        <CircleAlert size={16} aria-hidden className="shrink-0" />
      ) : (
        <Check size={16} aria-hidden className="shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{item.message}</span>
      {item.actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="h-[30px] shrink-0 rounded-md px-2.5 font-semibold underline underline-offset-2 hover:bg-white/10"
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
        className="inline-flex size-[30px] items-center justify-center rounded-md hover:bg-white/10"
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
