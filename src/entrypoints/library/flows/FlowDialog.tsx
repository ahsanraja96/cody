import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@/ui/components/Button';
import { cx } from '@/ui/cx';

/**
 * A native modal <dialog> (focus trap, Escape and focus return come from the browser) with the
 * boards' header: a 15px title and a close button. `closable={false}` hides the close button for
 * confirmations that need an explicit answer.
 */
export function FlowDialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 400,
  closable = true,
  showClose = closable,
  className,
  bodyClassName,
  headerClassName,
  describedBy,
  band,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Escape and a click outside close it. */
  closable?: boolean;
  /** The X button in the header. */
  showClose?: boolean;
  className?: string;
  /** Replaces the body's default gap and padding. */
  bodyClassName?: string;
  headerClassName?: string;
  describedBy?: string;
  /** Full-width strip under the body (e.g. a tinted footer). */
  band?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // The main action (marked data-autofocus) takes focus rather than the close button.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onClose={onClose}
      onCancel={(e) => {
        if (!closable) e.preventDefault();
      }}
      onClick={(e) => {
        if (closable && e.target === ref.current) onClose();
      }}
      className={cx('m-auto max-h-[calc(100vh-48px)] overflow-y-auto rounded-card border border-border bg-surface p-0 text-text shadow-pop', className)}
      style={{ width: `min(${width}px, calc(100vw - 32px))` }}
    >
      {open && (
        <>
          <div className={cx('flex flex-col', bodyClassName ?? 'gap-3 px-5 pt-[18px] pb-5')}>
            <div className={cx('flex min-h-7 items-center gap-2', headerClassName)}>
              <h2 id={titleId} className="min-w-0 flex-1 text-section font-semibold" dir="auto">
                {title}
              </h2>
              {showClose && (
                <IconButton label="Close" onClick={onClose} className="-mr-1.5">
                  <X size={16} aria-hidden />
                </IconButton>
              )}
            </div>
            {children}
            {footer && <div className="mt-1 flex flex-wrap items-center justify-end gap-2">{footer}</div>}
          </div>
          {band}
        </>
      )}
    </dialog>
  );
}

/** Small uppercase label above a group of choices. */
export function GroupLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className="mb-0.5 label-caps">
      {children}
    </span>
  );
}

/** One row of a radio group, styled as on the boards (16px ring, 32px row). */
export function RadioRow({
  name,
  checked,
  disabled,
  onChange,
  children,
  trailing,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <label className={cx('flex h-8 items-center gap-2.5 px-0.5', disabled ? 'text-text-3' : 'cursor-pointer')}>
      <input type="radio" name={name} className="peer sr-only" checked={checked} disabled={disabled} onChange={onChange} />
      <span
        aria-hidden
        className={cx(
          'size-4 shrink-0 rounded-full peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          checked ? 'border-[5px] border-accent bg-surface' : disabled ? 'border border-border bg-hover' : 'border border-border-strong bg-surface',
        )}
      />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </label>
  );
}
