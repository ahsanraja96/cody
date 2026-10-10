import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Check, Lock } from 'lucide-react';
import type { TabPreview } from '@/lib/types';
import { Favicon } from '@/ui/components/Favicon';
import { cx } from '@/ui/cx';

/** Two or three pressed-state buttons in one frame (card/list view, search scope). */
export function ToggleGroup<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode; ariaLabel?: string }>;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-8 shrink-0 rounded-control border border-border-strong bg-surface p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        const iconOnly = !!option.ariaLabel;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            aria-label={option.ariaLabel}
            title={option.ariaLabel}
            onClick={() => onChange(option.value)}
            className={cx(
              'inline-flex h-[26px] items-center justify-center rounded-md transition-colors duration-150',
              iconOnly ? 'w-8' : 'px-2.5 text-small',
              active ? 'bg-hover font-semibold text-text' : 'text-text-3 hover:text-text',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A checkbox drawn as a button so clicks keep their modifier keys (Shift selects a range).
 * `mixed` shows the dash used by "select all" when only some rows are selected.
 */
export function SelectBox({
  checked,
  mixed = false,
  label,
  onToggle,
  className,
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  onToggle: (e: React.MouseEvent) => void;
  className?: string;
}) {
  const on = checked || mixed;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e);
      }}
      onMouseDown={(e) => {
        // Shift-click would otherwise select the text between the anchor and this row.
        if (e.shiftKey) e.preventDefault();
      }}
      className={cx(
        'inline-flex size-4 shrink-0 items-center justify-center rounded',
        on ? 'bg-accent text-on-accent' : 'border border-border-strong bg-surface hover:border-text-3',
        className,
      )}
    >
      {mixed ? <span aria-hidden className="h-0.5 w-2 rounded bg-current" /> : checked && <Check size={11} strokeWidth={3} aria-hidden />}
    </button>
  );
}

/** Favicons for a session's sites, with "+N" for the rest of its tabs. */
export function SiteStrip({
  preview,
  total,
  size = 18,
  max = 6,
  className,
}: {
  preview: TabPreview[];
  total: number;
  size?: number;
  max?: number;
  className?: string;
}) {
  const shown = preview.slice(0, max);
  const more = total - shown.length;
  return (
    <span aria-hidden className={cx('flex min-w-0 items-center gap-1', className)}>
      {shown.map((p, i) => (
        <Favicon key={`${p.url}-${i}`} url={p.url} size={size} />
      ))}
      {more > 0 && <span className="ml-0.5 text-meta whitespace-nowrap text-text-3">+{more.toLocaleString()}</span>}
    </span>
  );
}

/** The small "lock · Pro" mark used inside menus and option lists. */
export function ProMark({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 text-[10px] font-semibold text-accent-text', className)}>
      <Lock size={11} strokeWidth={2.25} aria-hidden />
      PRO
    </span>
  );
}

/** Close a popover on Escape or a click outside `ref`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, ignore?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || ignore?.current?.contains(target)) return;
      // Clicks inside an open dialog (a confirm opened from the popover) do not close it.
      if ((target as Element).closest?.('dialog')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as Element | null)?.closest?.('dialog')) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [ref, ignore, open, onClose]);
}

/**
 * Clear the library's search box (it lives in the page header). Uses the input's own setter so
 * React sees a normal change event and the route goes back to the list.
 */
export function clearLibrarySearch(): void {
  const input = document.querySelector<HTMLInputElement>('input[type=search]');
  if (!input) {
    location.hash = '#/all';
    return;
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

/** True while the media query matches; follows window resizes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof matchMedia === 'function' ? matchMedia(query).matches : false));
  useEffect(() => {
    const list = matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** "Saved 2h ago", "Saved yesterday", "Saved Sep 27". */
export function lowerFirstRelative(text: string): string {
  return text === 'Yesterday' || text === 'Just now' ? text.toLowerCase() : text;
}
