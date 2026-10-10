import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';

/**
 * The full title and address of a tab row: shown after 500 ms of hover or keyboard focus,
 * hidden on leave, blur or Escape. Rows truncate; this is where the whole text is readable.
 */

interface Tip {
  anchor: HTMLElement;
  title: string;
  url: string;
}

const DELAY_MS = 500;
let timer: ReturnType<typeof setTimeout> | undefined;

const useTip = create<{ tip: Tip | null; set: (tip: Tip | null) => void }>((set) => ({
  tip: null,
  set: (tip) => set({ tip }),
}));

export function scheduleTip(anchor: HTMLElement, title: string, url: string): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (anchor.isConnected) useTip.getState().set({ anchor, title, url });
  }, DELAY_MS);
}

export function hideTip(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (useTip.getState().tip) useTip.getState().set(null);
}

/** Props for an element that should show the tooltip. */
export function tipHandlers(title: string, url: string) {
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => scheduleTip(e.currentTarget, title, url),
    onMouseLeave: hideTip,
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) scheduleTip(e.currentTarget, title, url);
    },
    onBlur: hideTip,
    onMouseDown: hideTip,
  };
}

const GAP = 4;
const MAX_URL_SHOWN = 240;
const EDGE = 8;

export function TipHost() {
  const tip = useTip((s) => s.tip);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!tip || !ref.current) {
      setPosition(null);
      return;
    }
    const anchor = tip.anchor.getBoundingClientRect();
    const box = ref.current.getBoundingClientRect();
    const below = anchor.bottom + GAP;
    const top = below + box.height <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - box.height);
    const left = Math.min(Math.max(EDGE, anchor.left + 26), window.innerWidth - EDGE - box.width);
    setPosition({ left, top });
  }, [tip]);

  useEffect(() => {
    if (!tip) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape hides the tooltip first; the next one clears a selection or closes the popup.
      e.preventDefault();
      e.stopImmediatePropagation();
      hideTip();
    };
    const onAway = () => hideTip();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onAway, true);
    document.addEventListener('pointerdown', onAway, true);
    // The row can disappear under the pointer (tab closed, list re-rendered): no leave event comes.
    const check = setInterval(() => {
      if (!tip.anchor.isConnected) hideTip();
    }, 300);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onAway, true);
      document.removeEventListener('pointerdown', onAway, true);
      clearInterval(check);
    };
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-50 max-w-[min(340px,calc(100vw-16px))] rounded-control bg-inverse px-2.5 py-2 text-small text-on-inverse shadow-pop"
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <div dir="auto" className="font-semibold break-words">
        {tip.title}
      </div>
      {tip.url && (
        <div className="mt-0.5 font-mono text-meta break-all opacity-80">
          {tip.url.length > MAX_URL_SHOWN ? `${tip.url.slice(0, MAX_URL_SHOWN)}…` : tip.url}
        </div>
      )}
    </div>
  );
}
