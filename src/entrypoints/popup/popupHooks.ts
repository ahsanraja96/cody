import { useEffect, useRef, useState } from 'react';
import { modKey, type OpenWindow } from '@/ui/hooks';

/** Width below which the popup switches to its compact layout (Chrome at 110%+ zoom). */
export const NARROW_QUERY = '(max-width: 360px)';

/** True while the popup's viewport is narrow. CSS handles most of the layout; this covers text. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const query = matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/** "⌘" on a Mac, "Ctrl" elsewhere, for "⌘-click" hints. */
export const clickKey = modKey.replace('+', '');

export interface ListedWindow extends OpenWindow {
  /** Closed in Chrome while the popup is open: shown briefly while it fades out. */
  closing?: boolean;
}

const FADE_MS = 180;

/**
 * Keep a window that was just closed in Chrome on screen for a moment (faded out), at the place it
 * had, so the list doesn't jump without explanation.
 */
export function useFadingWindows(windows: OpenWindow[]): ListedWindow[] {
  const previous = useRef<OpenWindow[]>([]);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [ghosts, setGhosts] = useState<Array<{ window: OpenWindow; index: number }>>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    const ids = new Set(windows.map((w) => w.id));
    const gone = previous.current
      .map((window, index) => ({ window, index }))
      .filter(({ window }) => !ids.has(window.id));
    previous.current = windows;
    if (!gone.length) return;
    const goneIds = new Set(gone.map((g) => g.window.id));
    setGhosts((g) => [...g.filter((x) => !goneIds.has(x.window.id)), ...gone]);
    timers.current.push(setTimeout(() => setGhosts((g) => g.filter((x) => !goneIds.has(x.window.id))), FADE_MS));
  }, [windows]);

  if (!ghosts.length) return windows;
  const list: ListedWindow[] = [...windows];
  for (const ghost of [...ghosts].sort((a, b) => a.index - b.index)) {
    if (list.some((w) => w.id === ghost.window.id)) continue;
    list.splice(Math.min(ghost.index, list.length), 0, { ...ghost.window, closing: true });
  }
  return list;
}

/** Bytes as "2.4 MB" / "12 KB", for address lengths (one byte per character). */
export function formatLength(length: number): string {
  if (length >= 1024 * 1024) return `${(length / (1024 * 1024)).toFixed(1)} MB`;
  if (length >= 1024) return `${Math.round(length / 1024)} KB`;
  return `${length.toLocaleString()} characters`;
}

/** The start of a very long address, enough to recognise it ("data:image/png;base64,"). */
export function addressHead(url: string): string {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma > 0 && comma < 60) return url.slice(0, comma + 1);
  }
  return url.slice(0, 48);
}

/** "Checkout app (3) and Reading list (1)". */
export function listSessions(counts: Array<[string, number]>, withCounts = true): string {
  const parts = counts.map(([name, count]) => (withCounts ? `${name} (${count})` : name));
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length > 3) return `${parts.slice(0, 2).join(', ')} and ${parts.length - 2} other sessions`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
