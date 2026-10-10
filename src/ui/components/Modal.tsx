import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../cx';

/**
 * A native modal <dialog> with the boards' card look (focus trap, Escape and the backdrop come from
 * the browser). Its content mounts only while open. The element marked `data-autofocus` takes focus,
 * otherwise the dialog itself, so nothing looks pressed until the person moves.
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  width,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  width: number;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog).focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx('m-auto overflow-hidden rounded-[12px] border border-border bg-surface p-0 text-text shadow-pop outline-none', className)}
      style={{ width: `min(${width}px, calc(100vw - 32px))` }}
    >
      {open && children}
    </dialog>
  );
}
