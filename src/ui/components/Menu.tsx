import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../cx';

export type MenuItem =
  | { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string; icon?: ReactNode }
  | 'separator';

/** Small popover menu. Opens on click, closes on outside click, Escape or selection; arrow keys move. */
export function Menu({
  items,
  trigger,
  align = 'end',
  label,
}: {
  items: MenuItem[];
  trigger: (props: { onClick: (e: React.MouseEvent) => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  align?: 'start' | 'end';
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(index + 1) % buttons.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <div ref={root} className="relative inline-flex" onKeyDown={onKeyDown}>
      {trigger({
        onClick: (e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        },
        'aria-expanded': open,
        'aria-haspopup': 'menu',
      })}
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label={label}
          className={cx(
            'anim-in absolute top-full z-40 mt-1 min-w-[200px] rounded-card border border-border bg-surface py-1.5 shadow-pop',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item, index) =>
            item === 'separator' ? (
              <div key={`sep-${index}`} className="my-1.5 h-px bg-border" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                className={cx(
                  'flex h-[30px] w-full items-center gap-2.5 px-3 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:text-text-3',
                  item.danger ? 'text-red' : 'text-text',
                )}
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
                {item.hint && <span className="text-[10px] font-semibold text-accent-text">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
