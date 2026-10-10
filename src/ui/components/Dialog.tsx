import { useEffect, useRef, type ReactNode } from 'react';
import { create } from 'zustand';
import { Button } from './Button';

/** A native <dialog> (focus trap, Escape and backdrop come from the browser). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 420,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto max-h-[85vh] rounded-card border border-border bg-surface p-0 text-text shadow-pop"
      style={{ width: `min(${width}px, calc(100vw - 32px))` }}
    >
      {open && (
        <div className="flex flex-col gap-3 p-5">
          <h2 className="text-section font-semibold">{title}</h2>
          {children}
          {footer && <div className="mt-2 flex flex-wrap justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ request: ConfirmRequest | null; set: (r: ConfirmRequest | null) => void }>((set) => ({
  request: null,
  set: (request) => set({ request }),
}));

/** Ask before destructive bulk actions only (delete, clear all). */
export function confirmAction(options: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirm.getState().set({ ...options, resolve }));
}

export function ConfirmHost() {
  const { request, set } = useConfirm();
  const finish = (ok: boolean) => {
    request?.resolve(ok);
    set(null);
  };
  return (
    <Dialog
      open={!!request}
      onClose={() => finish(false)}
      title={request?.title ?? ''}
      footer={
        <>
          <Button onClick={() => finish(false)}>Cancel</Button>
          <Button variant={request?.danger ? 'danger' : 'primary'} onClick={() => finish(true)} autoFocus>
            {request?.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-text-2">{request?.body}</div>
    </Dialog>
  );
}
