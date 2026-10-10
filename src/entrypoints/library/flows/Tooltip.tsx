import { cloneElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const DELAY_MS = 500;

/**
 * Hover or keyboard focus shows the tip after 500 ms; Escape, leaving or blurring hides it. The tip
 * is portalled to <body> (rows are virtualised and transformed) and placed below the trigger, or
 * above it near the bottom of the screen. It never holds the only way to do something.
 */
export function Tooltip({
  content,
  children,
  maxWidth = 360,
}: {
  content: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  maxWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const target = useRef<HTMLElement | null>(null);
  const id = useId();

  const show = (el: HTMLElement) => {
    target.current = el;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!target.current?.isConnected) return;
      setRect(target.current.getBoundingClientRect());
      setOpen(true);
    }, DELAY_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hide();
      }
    };
    const onScroll = () => hide();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const props = children.props as {
    onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
    onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
    onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
  };
  const trigger = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseEnter?.(e);
      show(e.currentTarget);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      props.onFocus?.(e);
      if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      props.onBlur?.(e);
      hide();
    },
  });

  let style: React.CSSProperties | undefined;
  if (open && rect) {
    const below = rect.bottom + 6;
    const placeAbove = below + 80 > window.innerHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - maxWidth - 8));
    style = placeAbove
      ? { left, bottom: window.innerHeight - rect.top + 6, maxWidth }
      : { left, top: below, maxWidth };
  }

  return (
    <>
      {trigger}
      {open &&
        style &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="anim-in pointer-events-none fixed z-[60] rounded-control bg-inverse px-2.5 py-2 text-small break-words text-on-inverse shadow-pop"
            style={style}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
