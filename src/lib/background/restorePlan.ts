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

export interface OpenCopy {
  /** Windows holding the open copy, the one with most of it first. */
  windowIds: number[];
  /** Session tabs whose address is open. */
  openTabs: number;
  totalTabs: number;
}

/**
 * Is (most of) this session already open? Counts addresses open in any window (a session saved
 * from two windows is restored into two). Returns the windows holding them, most first, so the
 * user can switch to the copy instead of opening another.
 */
export function describeOpenCopy(
  sessionUrls: string[],
  openWindows: Array<{ id?: number; tabs?: Array<{ url?: string; pendingUrl?: string }> }>,
): OpenCopy | undefined {
  const unique = [...new Set(sessionUrls)];
  if (unique.length < 2) return undefined;
  const hitsByWindow: Array<{ id: number; hits: Set<string> }> = [];
  const openAnywhere = new Set<string>();
  for (const window of openWindows) {
    // Tabs restored lazily have no committed address yet; theirs is in pendingUrl.
    const open = new Set((window.tabs ?? []).map((t) => t.url || t.pendingUrl));
    const hits = new Set(unique.filter((url) => open.has(url)));
    for (const url of hits) openAnywhere.add(url);
    if (window.id !== undefined && hits.size) hitsByWindow.push({ id: window.id, hits });
  }
  if (openAnywhere.size / unique.length < 0.8) return undefined;
  // Windows that add something to the copy, biggest share first.
  hitsByWindow.sort((a, b) => b.hits.size - a.hits.size);
  const covered = new Set<string>();
  const windowIds: number[] = [];
  for (const { id, hits } of hitsByWindow) {
    if (![...hits].some((url) => !covered.has(url))) continue;
    for (const url of hits) covered.add(url);
    windowIds.push(id);
    if (covered.size === openAnywhere.size) break;
  }
  return { windowIds, openTabs: sessionUrls.filter((url) => openAnywhere.has(url)).length, totalTabs: sessionUrls.length };
}

/** The window holding most of an open copy of this session, if there is one. */
export function findOpenCopy(
  sessionUrls: string[],
  openWindows: Array<{ id?: number; tabs?: Array<{ url?: string; pendingUrl?: string }> }>,
): number | undefined {
  return describeOpenCopy(sessionUrls, openWindows)?.windowIds[0];
}
