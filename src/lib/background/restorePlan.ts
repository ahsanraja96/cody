import type { ScreenArea } from '../messages';
import { classifyUrl } from '../urls';
import type { CapturedWindow, TabGroupColor, WindowBounds, WindowState } from '../types';
import { TAB_GROUP_COLORS } from '../types';

export interface RestoreTab {
  url: string;
  title: string;
  pinned: boolean;
  groupName: string | null;
  groupColor: TabGroupColor | null;
  groupCollapsed: boolean;
}

export interface RestoreWindow {
  name: string;
  bounds: WindowBounds | null;
  state: WindowState | null;
  focused: boolean;
  tabs: RestoreTab[];
}

export function fromCaptured(windows: CapturedWindow[]): RestoreWindow[] {
  return windows.map((w) => ({
    name: w.name,
    bounds: w.bounds,
    state: w.state,
    focused: w.focused,
    tabs: w.tabs.map((t) => ({
      url: t.url,
      title: t.title,
      pinned: t.pinned,
      groupName: t.groupName,
      groupColor: t.groupColor,
      groupCollapsed: t.groupCollapsed,
    })),
  }));
}

/**
 * Use saved window bounds only when they land mostly on the current screen. Windows saved on a
 * monitor that is no longer connected, or on another device, open at the default size instead.
 */
export function fitBounds(bounds: WindowBounds | null, screen: ScreenArea | undefined): WindowBounds | null {
  if (!bounds || !screen) return null;
  if (bounds.width < 200 || bounds.height < 150) return null;
  const overlapW = Math.min(bounds.left + bounds.width, screen.left + screen.width) - Math.max(bounds.left, screen.left);
  const overlapH = Math.min(bounds.top + bounds.height, screen.top + screen.height) - Math.max(bounds.top, screen.top);
  if (overlapW < bounds.width * 0.6 || overlapH < bounds.height * 0.6) return null;
  const width = Math.min(bounds.width, screen.width);
  const height = Math.min(bounds.height, screen.height);
  return {
    width,
    height,
    left: Math.min(Math.max(bounds.left, screen.left), screen.left + screen.width - width),
    top: Math.min(Math.max(bounds.top, screen.top), screen.top + screen.height - height),
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function groupKey(tab: RestoreTab): string | null {
  if (tab.groupName === null && tab.groupColor === null) return null;
  return `${tab.groupName ?? ''}\u0001${tab.groupColor ?? ''}`;
}

/** Group colours Chrome no longer knows fall back to grey. */
export function safeGroupColor(color: string | null): TabGroupColor {
  return color && (TAB_GROUP_COLORS as readonly string[]).includes(color) ? (color as TabGroupColor) : 'grey';
}

/** Addresses we never try to open: scripts, and our own pages. */
export function refuseToOpen(url: string, ownOrigin: string): boolean {
  const kind = classifyUrl(url, ownOrigin);
  return url.toLowerCase().startsWith('javascript:') || kind === 'own';
}

/**
 * Is (most of) this session already open? Counts addresses open in any window (a session saved
 * from two windows is restored into two). Returns the window holding most of them, so the user
 * can switch to it instead of opening a copy.
 */
export function findOpenCopy(
  sessionUrls: string[],
  openWindows: Array<{ id?: number; tabs?: Array<{ url?: string; pendingUrl?: string }> }>,
): number | undefined {
  const unique = [...new Set(sessionUrls)];
  if (unique.length < 2) return undefined;
  const openAnywhere = new Set<string>();
  let best: { id: number; hits: number } | undefined;
  for (const window of openWindows) {
    // Tabs restored lazily have no committed address yet; theirs is in pendingUrl.
    const open = new Set((window.tabs ?? []).map((t) => t.url || t.pendingUrl));
    const hits = unique.filter((url) => open.has(url));
    for (const url of hits) openAnywhere.add(url);
    if (window.id !== undefined && hits.length && (!best || hits.length > best.hits)) best = { id: window.id, hits: hits.length };
  }
  return openAnywhere.size / unique.length >= 0.8 ? best?.id : undefined;
}
