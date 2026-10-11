import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { cx } from '../cx';

/**
 * A pop-up menu with submenus (Up-Move-States, Fo-Folders-States, Mx-Auto): a tab's ⋯ menu, a
 * folder's menu, right-click. It renders in a portal with fixed positioning, so it is never
 * clipped by the scrolling list, and keeps inside the window. Keyboard: ↑↓ move, → opens a
 * submenu, ← or Esc closes it, Esc closes the menu and puts focus back on what opened it, Tab
 * closes. A click outside, or scrolling the page, closes it too.
 */

export type MenuEntry =
  | {
      type?: 'item';
      key: string;
      label: ReactNode;
      icon?: ReactNode;
      /** Shown on the right: a time, a Pro chip. */
      hint?: ReactNode;
      /** A second, smaller line. */
      description?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      /** A choice that can be the current one (menuitemradio): ticked when true. */
      checked?: boolean;
      onSelect?: () => void;
      submenu?: MenuEntry[];
      submenuWidth?: number;
      /** For screen readers when the label isn't plain text. */
      ariaLabel?: string;
    }
  | { type: 'separator'; key: string }
  | { type: 'heading'; key: string; label: ReactNode }
  | { type: 'custom'; key: string; render: (close: () => void) => ReactNode };

export interface MenuAnchor {
  x: number;
  y: number;
  /** The menu's right edge sits at x (a ⋯ button at the end of a row). */
  alignRight?: boolean;
  /** Where to put the menu's bottom when it doesn't fit below (the trigger's top). */
  flipY?: number;
}

/** Below a trigger, right-aligned with it. */
export function anchorBelow(el: Element, alignRight = true): MenuAnchor {
  const r = el.getBoundingClientRect();
  return { x: alignRight ? r.right : r.left, y: r.bottom + 4, alignRight, flipY: r.top - 4 };
}

const MARGIN = 8;

interface PanelProps {
  entries: MenuEntry[];
  label: string;
  width: number;
  anchor: MenuAnchor;
  /** Set for a submenu: the item it hangs from. */
  parent?: HTMLElement;
  depth: number;
  closeAll: (refocus: boolean) => void;
  /** Close this submenu and focus the parent item. */
  closeSelf?: () => void;
  autoFocus: 'first' | 'none';
}

function items(panel: HTMLElement | null): HTMLElement[] {
  return panel ? [...panel.querySelectorAll<HTMLElement>('[data-menu-item]:not([disabled])')] : [];
}

function MenuPanel({ entries, label, width, anchor, parent, depth, closeAll, closeSelf, autoFocus }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [openSub, setOpenSub] = useState<{ key: string; el: HTMLElement; focus: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (parent) {
      const r = parent.getBoundingClientRect();
      left = r.right + 4 + w > vw - MARGIN ? r.left - 4 - w : r.right + 4;
      top = r.top - 5;
    } else {
      left = anchor.alignRight ? anchor.x - w : anchor.x;
      top = anchor.y;
      if (top + h > vh - MARGIN) top = anchor.flipY !== undefined && anchor.flipY - h >= MARGIN ? anchor.flipY - h : Math.max(MARGIN, vh - MARGIN - h);
    }
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - MARGIN - w));
    top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - MARGIN - h));
    setPos({ left, top });
  }, [anchor, parent]);

  useEffect(() => {
    if (!pos || autoFocus === 'none') return;
    items(ref.current)[0]?.focus();
    // Focus the first item once, when the panel has its place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos === null]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = items(ref.current);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => list[(to + list.length) % list.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(at + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(at < 0 ? -1 : at - 1);
        break;
      case 'Home':
        e.preventDefault();
        move(0);
        break;
      case 'End':
        e.preventDefault();
        move(-1);
        break;
      case 'ArrowRight': {
        const current = list[at];
        if (current?.dataset.submenu) {
          e.preventDefault();
          setOpenSub({ key: current.dataset.submenu, el: current, focus: true });
        }
        break;
      }
      case 'ArrowLeft':
        if (closeSelf) {
          e.preventDefault();
          closeSelf();
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (closeSelf) closeSelf();
        else closeAll(true);
        break;
      case 'Tab':
        e.preventDefault();
        closeAll(true);
        break;
    }
    e.stopPropagation();
  };

  const sub = openSub ? entries.find((x) => x.key === openSub.key) : undefined;

  return (
    <>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        data-tf-menu=""
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className="anim-in fixed z-[60] rounded-card border border-border bg-surface p-1 text-text shadow-pop"
        style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden', zIndex: 60 + depth }}
      >
        {entries.map((entry) => {
          if (entry.type === 'separator') return <div key={entry.key} role="separator" className="mx-1.5 my-1 h-px bg-border" />;
          if (entry.type === 'heading')
            return (
              <div key={entry.key} role="presentation" className="px-2.5 pt-1.5 pb-1 text-meta font-semibold tracking-[.04em] text-text-3 uppercase">
                {entry.label}
              </div>
            );
          if (entry.type === 'custom') return <div key={entry.key}>{entry.render(() => closeAll(true))}</div>;
          const hasSub = !!entry.submenu?.length;
          const expanded = hasSub && openSub?.key === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={entry.checked === undefined ? undefined : entry.checked}
              aria-haspopup={hasSub ? 'menu' : undefined}
              aria-expanded={hasSub ? expanded : undefined}
              aria-label={entry.ariaLabel}
              data-menu-item=""
              data-submenu={hasSub ? entry.key : undefined}
              disabled={entry.disabled}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.focus({ preventScroll: true });
                if (hasSub) setOpenSub({ key: entry.key, el, focus: false });
                else if (openSub) setOpenSub(null);
              }}
              onClick={(e) => {
                if (hasSub) {
                  setOpenSub(expanded ? null : { key: entry.key, el: e.currentTarget, focus: e.detail === 0 });
                  return;
                }
                closeAll(true);
                entry.onSelect?.();
              }}
              className={cx(
                'flex min-h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left outline-none',
                'hover:bg-hover focus-visible:bg-hover focus:bg-hover disabled:cursor-default disabled:opacity-50',
                expanded && 'bg-hover',
                entry.danger ? 'text-red' : 'text-text',
              )}
            >
              {entry.icon && <span className={cx('flex shrink-0', entry.danger ? 'text-red' : 'text-text-2')}>{entry.icon}</span>}
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate', expanded && 'font-semibold')}>{entry.label}</span>
                {entry.description && <span className="block text-meta text-text-3">{entry.description}</span>}
              </span>
              {entry.hint && <span className="flex shrink-0 items-center text-small text-text-3">{entry.hint}</span>}
              {entry.checked && <Check size={14} strokeWidth={2.2} aria-hidden className="shrink-0 text-text-3" />}
              {hasSub && <ChevronRight size={14} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />}
            </button>
          );
        })}
      </div>
      {sub && sub.type !== 'separator' && sub.type !== 'heading' && sub.type !== 'custom' && sub.submenu && openSub && (
        <MenuPanel
          key={openSub.key}
          entries={sub.submenu}
          label={typeof sub.label === 'string' ? sub.label : (sub.ariaLabel ?? label)}
          width={sub.submenuWidth ?? 200}
          anchor={anchor}
          parent={openSub.el}
          depth={depth + 1}
          closeAll={closeAll}
          closeSelf={() => {
            const el = openSub.el;
            setOpenSub(null);
            el.focus();
          }}
          autoFocus={openSub.focus ? 'first' : 'none'}
        />
      )}
    </>
  );
}

/**
 * Open while mounted. `returnFocus` gets focus back when the menu closes with the keyboard or a
 * choice (unless the choice moved focus somewhere else, like a dialog).
 */
export function Menu({
  anchor,
  entries,
  label,
  width = 232,
  onClose,
  returnFocus,
}: {
  anchor: MenuAnchor;
  entries: MenuEntry[];
  label: string;
  width?: number;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const focusRef = useRef(returnFocus);
  focusRef.current = returnFocus;

  const closeAll = (refocus: boolean) => {
    closeRef.current();
    if (!refocus) return;
    const target = focusRef.current;
    // After the choice runs: only take focus back when nothing else (a dialog, a field) took it.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      const lost = !active || active === document.body || !!active.closest?.('[data-tf-menu]') || !active.isConnected;
      if (lost && target?.isConnected) target.focus();
    });
  };

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-tf-menu]')) return;
      closeRef.current();
    };
    const scrolled = (e: Event) => {
      if ((e.target as Element | null)?.closest?.('[data-tf-menu]')) return;
      closeRef.current();
    };
    const resized = () => closeRef.current();
    document.addEventListener('mousedown', away, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', resized);
    window.addEventListener('blur', resized);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', resized);
      window.removeEventListener('blur', resized);
    };
  }, []);

  return createPortal(
    <MenuPanel entries={entries} label={label} width={width} anchor={anchor} depth={0} closeAll={closeAll} autoFocus="first" />,
    document.body,
  );
}
