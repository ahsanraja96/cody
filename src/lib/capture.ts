import { cleanKeywords } from './keywords';
import { defaultSessionName, newId } from './format';
import { capFavicon, capUrl, classifyUrl, dedupeKey, displayHost, unwrapViewerUrl } from './urls';
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
}

export interface CapturePlan {
  windows: CapturedWindow[];
  /** Tabs to close once the save is confirmed written. */
  closeTabIds: number[];
  kept: { pinned: number; audible: number };
  skipped: { blank: number; own: number };
}

/** Only normal, non-incognito windows are ever captured. */
export function isCapturableWindow(window: WindowLike): boolean {
  return !window.incognito && (window.type === undefined || window.type === 'normal');
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
  const rawUrl = unwrapViewerUrl(tab.url || tab.pendingUrl || '');
  const { url, truncated } = capUrl(rawUrl);
  const title = (tab.title ?? '').trim();
  const group = tab.groupId !== undefined && tab.groupId >= 0 ? groups.get(tab.groupId) : undefined;
  return {
    url,
    // Tabs still loading have no title yet: fall back to the host so the row stays readable.
    title: title && title !== url ? title : displayHost(url) || url,
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

  for (const window of windows) {
    if (!isCapturableWindow(window)) continue;
    if (onlyWindow !== undefined && window.id !== onlyWindow) continue;
    const tabs = [...(window.tabs ?? [])].sort((a, b) => a.index - b.index);
    const captured: CapturedTab[] = [];

    for (const tab of tabs) {
      if (tab.incognito) continue;
      if (wanted && (tab.id === undefined || !wanted.has(tab.id))) continue;
      const url = unwrapViewerUrl(tab.url || tab.pendingUrl || '');
      const kind = classifyUrl(url, options.ownOrigin);
      if (kind === 'own') {
        plan.skipped.own += 1;
        continue;
      }
      if (kind === 'blank' && options.skipBlank) {
        plan.skipped.blank += 1;
        if (!explicit && tab.id !== undefined) plan.closeTabIds.push(tab.id);
        continue;
      }
      if (!explicit && tab.pinned && options.keepPinnedOpen) {
        plan.kept.pinned += 1;
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
    });
  }
  return plan;
}

/** Which of the tabs to close would leave no normal window open (Chrome would quit)? */
export function wouldCloseEverything(windows: WindowLike[], closeTabIds: number[]): boolean {
  const closing = new Set(closeTabIds);
  return !windows
    .filter(isCapturableWindow)
    .some((window) => (window.tabs ?? []).some((tab) => tab.id === undefined || !closing.has(tab.id)));
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
}

export interface DraftResult {
  draft: SessionDraft;
  skippedDuplicates: number;
  /** Database tab id for each browser tab id that was saved. */
  tabIdMap: Map<number, string>;
  /** Database window id for each browser window id. */
  windowIdMap: Map<number, string>;
}

export function buildDraft(windows: CapturedWindow[], meta: DraftMeta): DraftResult {
  const sessionId = newId();
  const seen = new Set<string>([...(meta.existingUrls ?? [])].map(dedupeKey));
  let skippedDuplicates = 0;
  const windowRecords: WindowRecord[] = [];
  const tabRecords: TabRecord[] = [];
  const tabIdMap = new Map<number, string>();
  const windowIdMap = new Map<number, string>();

  windows.forEach((window) => {
    const windowId = newId();
    let order = 0;
    for (const tab of window.tabs) {
      const key = dedupeKey(tab.url);
      if (meta.dedupe && seen.has(key)) {
        skippedDuplicates += 1;
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
  return { draft: { session, windows: windowRecords, tabs: tabRecords }, skippedDuplicates, tabIdMap, windowIdMap };
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
