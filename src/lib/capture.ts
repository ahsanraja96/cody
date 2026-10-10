import { cleanKeywords } from './keywords';
import { defaultSessionName, newId } from './format';
import { capFavicon, capUrl, classifyUrl, dedupeKey, displayHost, displayUrl, unwrapViewerUrl } from './urls';
import {
  TAB_GROUP_COLORS,
  type CapturedTab,
  type CapturedWindow,
  type SessionDraft,
  type SessionRecord,
  type SessionSource,
  type TabGroupColor,
  type TabPreview,
  type TabRecord,
  type WindowRecord,
  type WindowState,
} from './types';

/** The parts of a browser tab Tabfold reads. Kept minimal so the logic is testable without a browser. */
export interface TabLike {
  id?: number;
  windowId?: number;
  index: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  favIconUrl?: string;
  pinned: boolean;
  audible?: boolean;
  active: boolean;
  highlighted?: boolean;
  discarded?: boolean;
  incognito: boolean;
  groupId?: number;
  lastAccessed?: number;
}

export interface WindowLike {
  id?: number;
  focused: boolean;
  incognito: boolean;
  type?: string;
  state?: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  tabs?: TabLike[];
}

export interface GroupLike {
  id: number;
  title?: string;
  color: string;
  collapsed: boolean;
}

export interface CaptureOptions {
  scope: 'all' | 'window' | 'tabs';
  /** Window to save for scope 'window'; for scope 'all' with includeAllWindows off, the current window. */
  windowId?: number;
  tabIds?: number[];
  keepPinnedOpen: boolean;
  skipBlank: boolean;
  includeAllWindows: boolean;
  /** Tabs playing audio: keep them open (and out of the save), or save and close them like the rest. */
  audible: 'keep' | 'close';
  ownOrigin: string;
  windowNames?: Record<number, string>;
  keywordsByTabId?: Record<number, string[]>;
  /**
   * Include Incognito windows and tabs: a fold with "Fold Incognito windows too" on, or a save the
   * user confirmed for an Incognito window. Snapshots never include Incognito.
   */
  includeIncognito?: boolean;
  /** Tabfold pages that must stay open (the page that started the fold). Other Tabfold pages close. */
  keepTabIds?: number[];
}

export interface CapturePlan {
  windows: CapturedWindow[];
  /** Tabs to close once the save is confirmed written. */
  closeTabIds: number[];
  kept: { pinned: number; audible: number };
  skipped: { blank: number; own: number };
}

function isNormalWindow(window: WindowLike): boolean {
  return window.type === undefined || window.type === 'normal';
}

/** Only normal windows are captured, and Incognito ones only when the user chose to save one. */
export function isCapturableWindow(window: WindowLike, includeIncognito = false): boolean {
  return (includeIncognito || !window.incognito) && isNormalWindow(window);
}

/**
 * Chrome shows a page's address as its title (without the scheme) until the real title arrives,
 * and keeps it for pages that have none.
 */
export function isPlaceholderTitle(title: string | undefined, url: string): boolean {
  const clean = (title ?? '').trim();
  if (!clean) return true;
  return clean === url || clean === url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') || clean === displayUrl(url);
}

/** The address Tabfold saves for a tab, before capping (the PDF viewer's address unwrapped). */
export function rawTabUrl(tab: Pick<TabLike, 'url' | 'pendingUrl'>): string {
  return unwrapViewerUrl(tab.url || tab.pendingUrl || '');
}

function toGroupColor(color: string | undefined): TabGroupColor | null {
  if (!color) return null;
  return (TAB_GROUP_COLORS as readonly string[]).includes(color) ? (color as TabGroupColor) : 'grey';
}

function toWindowState(state: string | undefined): WindowState | null {
  return state === 'normal' || state === 'minimized' || state === 'maximized' || state === 'fullscreen'
    ? state
    : null;
}

export function captureTab(
  tab: TabLike,
  groups: Map<number, GroupLike>,
  keywords: string[] = [],
): CapturedTab {
  const rawUrl = rawTabUrl(tab);
  const { url, truncated } = capUrl(rawUrl);
  const title = (tab.title ?? '').trim();
  const group = tab.groupId !== undefined && tab.groupId >= 0 ? groups.get(tab.groupId) : undefined;
  return {
    url,
    // Tabs still loading have no title yet: fall back to the host so the row stays readable.
    title: isPlaceholderTitle(title, rawUrl) || title === url ? displayHost(url) || url : title,
    favIconUrl: capFavicon(tab.favIconUrl),
    pinned: tab.pinned,
    groupName: group ? (group.title ?? '') : null,
    groupColor: group ? toGroupColor(group.color) : null,
    groupCollapsed: group?.collapsed ?? false,
    keywords: cleanKeywords(keywords),
    urlTruncated: truncated,
    sourceTabId: tab.id,
  };
}

export function planCapture(
  windows: WindowLike[],
  groups: Map<number, GroupLike>,
  options: CaptureOptions,
): CapturePlan {
  const plan: CapturePlan = {
    windows: [],
    closeTabIds: [],
    kept: { pinned: 0, audible: 0 },
    skipped: { blank: 0, own: 0 },
  };
  const wanted = options.scope === 'tabs' ? new Set(options.tabIds ?? []) : null;
  const onlyWindow =
    options.scope === 'window' || (options.scope === 'all' && !options.includeAllWindows)
      ? options.windowId
      : undefined;
  const explicit = options.scope === 'tabs';
  const incognito = options.includeIncognito === true;
  const keep = new Set(options.keepTabIds ?? []);

  for (const window of windows) {
    if (!isCapturableWindow(window, incognito)) continue;
    if (onlyWindow !== undefined && window.id !== onlyWindow) continue;
    const tabs = [...(window.tabs ?? [])].sort((a, b) => a.index - b.index);
    const captured: CapturedTab[] = [];

    for (const tab of tabs) {
      if (tab.incognito && !incognito) continue;
      if (wanted && (tab.id === undefined || !wanted.has(tab.id))) continue;
      const url = rawTabUrl(tab);
      const kind = classifyUrl(url, options.ownOrigin);
      if (!explicit && tab.pinned && options.keepPinnedOpen) {
        plan.kept.pinned += 1;
        continue;
      }
      if (kind === 'own') {
        // Tabfold's own pages (the welcome tab, the full list) aren't saved, but they close with
        // everything else, except the page that started the fold.
        plan.skipped.own += 1;
        if (!explicit && tab.id !== undefined && !keep.has(tab.id)) plan.closeTabIds.push(tab.id);
        continue;
      }
      if (kind === 'blank' && options.skipBlank) {
        plan.skipped.blank += 1;
        if (!explicit && tab.id !== undefined) plan.closeTabIds.push(tab.id);
        continue;
      }
      if (!explicit && tab.audible && options.audible === 'keep') {
        plan.kept.audible += 1;
        continue;
      }
      const keywords = tab.id !== undefined ? options.keywordsByTabId?.[tab.id] : undefined;
      captured.push(captureTab(tab, groups, keywords));
      if (tab.id !== undefined) plan.closeTabIds.push(tab.id);
    }

    if (captured.length === 0) continue;
    const state = toWindowState(window.state);
    const hasBounds =
      state === 'normal' &&
      window.left !== undefined &&
      window.top !== undefined &&
      window.width !== undefined &&
      window.height !== undefined;
    plan.windows.push({
      name: (window.id !== undefined ? options.windowNames?.[window.id] : undefined) ?? '',
      focused: window.focused,
      bounds: hasBounds
        ? { left: window.left!, top: window.top!, width: window.width!, height: window.height! }
        : null,
      state,
      tabs: captured,
      sourceWindowId: window.id,
      ...(window.incognito ? { incognito: true } : {}),
    });
  }
  return plan;
}

/**
 * Would closing these tabs leave no normal window open? Then Chrome would quit (or, with only an
 * Incognito window left, the user would lose their normal window). With no normal window open at
 * all (only Incognito), the question is whether any window at all stays open.
 */
export function wouldCloseEverything(windows: WindowLike[], closeTabIds: number[]): boolean {
  const closing = new Set(closeTabIds);
  const normal = windows.filter((w) => isCapturableWindow(w));
  const pool = normal.length ? normal : windows.filter(isNormalWindow);
  return !pool.some((window) => (window.tabs ?? []).some((tab) => tab.id === undefined || !closing.has(tab.id)));
}

export interface DraftMeta {
  name?: string;
  source: SessionSource;
  deviceId: string;
  now: number;
  tags?: string[];
  kind?: SessionRecord['kind'];
  /** Skip a tab whose address is already in the session (or earlier in this capture). */
  dedupe: boolean;
  existingUrls?: Iterable<string>;
  /** Addresses already folded from Incognito. Incognito and normal copies don't count as duplicates of each other. */
  existingIncognitoUrls?: Iterable<string>;
}

export interface SkippedTab {
  tab: CapturedTab;
  /** Browser window the tab was in. */
  sourceWindowId?: number;
  incognito?: boolean;
}

/** Duplicates are per mode: the same address in Incognito and in a normal window are two tabs. */
export function modeKey(url: string, incognito: boolean | undefined): string {
  return `${incognito ? 'incognito ' : ''}${dedupeKey(url)}`;
}

export interface DraftResult {
  draft: SessionDraft;
  skippedDuplicates: number;
  /** The duplicates that were not written, in capture order. */
  skippedTabs: SkippedTab[];
  /** Database tab id for each browser tab id that was saved. */
  tabIdMap: Map<number, string>;
  /** Database window id for each browser window id. */
  windowIdMap: Map<number, string>;
}

export function buildDraft(windows: CapturedWindow[], meta: DraftMeta): DraftResult {
  const sessionId = newId();
  const seen = new Set<string>([
    ...[...(meta.existingUrls ?? [])].map((url) => modeKey(url, false)),
    ...[...(meta.existingIncognitoUrls ?? [])].map((url) => modeKey(url, true)),
  ]);
  const skippedTabs: SkippedTab[] = [];
  const windowRecords: WindowRecord[] = [];
  const tabRecords: TabRecord[] = [];
  const tabIdMap = new Map<number, string>();
  const windowIdMap = new Map<number, string>();

  windows.forEach((window) => {
    const windowId = newId();
    let order = 0;
    for (const tab of window.tabs) {
      const key = modeKey(tab.url, window.incognito);
      if (meta.dedupe && seen.has(key)) {
        skippedTabs.push({ tab, sourceWindowId: window.sourceWindowId, ...(window.incognito ? { incognito: true } : {}) });
        continue;
      }
      seen.add(key);
      const id = newId();
      if (tab.sourceTabId !== undefined) tabIdMap.set(tab.sourceTabId, id);
      tabRecords.push({
        id,
        sessionId,
        windowId,
        url: tab.url,
        title: tab.title,
        favIconUrl: tab.favIconUrl,
        pinned: tab.pinned,
        groupName: tab.groupName,
        groupColor: tab.groupColor,
        groupCollapsed: tab.groupCollapsed,
        order: order++,
        savedAt: meta.now,
        keywords: tab.keywords,
        urlTruncated: tab.urlTruncated,
        ...(window.incognito ? { incognito: true as const } : {}),
      });
    }
    if (order === 0) return;
    if (window.sourceWindowId !== undefined) windowIdMap.set(window.sourceWindowId, windowId);
    windowRecords.push({
      id: windowId,
      sessionId,
      name: window.name,
      order: windowRecords.length,
      wasFocused: window.focused,
      bounds: window.bounds,
      state: window.state,
      ...(window.incognito ? { incognito: true as const } : {}),
    });
  });

  const session: SessionRecord = {
    id: sessionId,
    name: meta.name?.trim() || defaultSessionName(meta.now),
    tags: meta.tags ?? [],
    pinned: 0,
    color: null,
    kind: meta.kind ?? 'session',
    source: meta.source,
    createdAt: meta.now,
    updatedAt: meta.now,
    deletedAt: 0,
    deviceId: meta.deviceId,
    version: 1,
    ...aggregates(windowRecords, tabRecords),
  };
  return {
    draft: { session, windows: windowRecords, tabs: tabRecords },
    skippedDuplicates: skippedTabs.length,
    skippedTabs,
    tabIdMap,
    windowIdMap,
  };
}

/** Counts and the favicon strip shown on session cards, so cards never load every tab. */
export function aggregates(
  windows: Pick<WindowRecord, 'id' | 'order'>[],
  tabs: Pick<TabRecord, 'windowId' | 'order' | 'url' | 'title'>[],
): Pick<SessionRecord, 'tabCount' | 'windowCount' | 'preview'> {
  const windowOrder = new Map(windows.map((w) => [w.id, w.order]));
  const sorted = [...tabs].sort(
    (a, b) => (windowOrder.get(a.windowId) ?? 0) - (windowOrder.get(b.windowId) ?? 0) || a.order - b.order,
  );
  const preview: TabPreview[] = [];
  const hosts = new Set<string>();
  for (const tab of sorted) {
    const host = displayHost(tab.url);
    if (hosts.has(host)) continue;
    hosts.add(host);
    preview.push({ url: tab.url, title: tab.title });
    if (preview.length === 6) break;
  }
  for (const tab of sorted) {
    if (preview.length === 6) break;
    if (!preview.some((p) => p.url === tab.url)) preview.push({ url: tab.url, title: tab.title });
  }
  const usedWindows = new Set(tabs.map((t) => t.windowId));
  return { tabCount: tabs.length, windowCount: usedWindows.size, preview };
}

/** Stable fingerprint of what is open, so identical timer snapshots are not written twice. */
export function captureHash(windows: CapturedWindow[]): string {
  let hash = 2166136261;
  const text = windows.map((w) => w.tabs.map((t) => `${t.url}|${t.pinned ? 1 : 0}|${t.groupName ?? ''}`).join('\n')).join('\n--\n');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}-${text.length}`;
}
