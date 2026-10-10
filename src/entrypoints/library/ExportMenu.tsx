import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, FileDown } from 'lucide-react';
import { ProTag } from '@/ui/components/ProBits';
import { exportAll, type ExportFormat } from './actions';
import { goToPlans } from './router';

const ITEMS: Array<{ format: ExportFormat; label: string; sub: string; pro: boolean }> = [
  { format: 'html', label: 'Web page (HTML)', sub: 'Opens in any browser; OneTab can import it', pro: false },
  { format: 'markdown', label: 'Markdown', sub: 'For notes, docs and AI assistants', pro: true },
  { format: 'csv', label: 'CSV', sub: 'For spreadsheets', pro: true },
  { format: 'json', label: 'JSON', sub: 'Everything, for other tools', pro: true },
];

const MENU_WIDTH = 300;
const MENU_HEIGHT = 230;

/**
 * Settings › Your tabs › Export… (Min-Remove "Export… · Pro formats"): HTML is free; Markdown, CSV
 * and JSON are Pro, and on Free picking one opens the plans page. The menu is fixed to the window
 * so the Settings scroll area never clips it; it opens upwards when there's no room below.
 */
export function ExportMenu({ pro, className }: { pro: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const below = r.bottom + 8 + MENU_HEIGHT <= window.innerHeight - 8;
    setPlace({
      top: below ? r.bottom + 8 : Math.max(8, r.top - 8 - MENU_HEIGHT),
      left: Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    const away = (e: Event) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    // Scrolling Settings or resizing would leave the menu behind: close it.
    const close = () => setOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open, place]);

  const pick = (format: ExportFormat, needsPro: boolean) => {
    setOpen(false);
    trigger.current?.focus();
    if (needsPro && !pro) goToPlans();
    else void exportAll(format);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={className}
      >
        <Download size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
        Export…
      </button>
      {open && place && (
        <div
          ref={menu}
          role="menu"
          aria-label="Export"
          onKeyDown={(e) => {
            const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
            } else if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
            } else if (e.key === 'Escape' || e.key === 'Tab') {
              // Escape closes the menu, not Settings.
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
          className="anim-in fixed z-50 rounded-card border border-border bg-surface p-1 text-text shadow-pop"
          style={{ top: place.top, left: place.left, width: MENU_WIDTH }}
        >
          {ITEMS.map((item) => (
            <button
              key={item.format}
              type="button"
              role="menuitem"
              onClick={() => pick(item.format, item.pro)}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
            >
              <FileDown size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-2" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{item.label}</span>
                <span className="block text-meta text-text-3">{item.sub}</span>
              </span>
              {item.pro && !pro && <ProTag />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
