/** Chrome's tab group colours. Anything else falls back to 'grey' on restore. */
export const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const;
export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A tab as captured from the browser, before it becomes a database row. */
export interface CapturedTab {
  url: string;
  title: string;
  favIconUrl: string;
  pinned: boolean;
  groupName: string | null;
  groupColor: TabGroupColor | null;
  groupCollapsed: boolean;
  keywords: string[];
  urlTruncated: boolean;
  /** Browser tab id at capture time; never stored. */
  sourceTabId?: number;
}

export interface CapturedWindow {
  name: string;
  focused: boolean;
  bounds: WindowBounds | null;
  state: WindowState | null;
  tabs: CapturedTab[];
  /** Browser window id at capture time; never stored. */
  sourceWindowId?: number;
  /** Folded from an Incognito window (only with "Fold Incognito windows too"). */
  incognito?: boolean;
}

export type SessionSource =
  | 'save-all'
  | 'save-window'
  | 'save-tabs'
  | 'import'
  | 'snapshot'
  | 'duplicate'
  | 'manual';

export interface TabPreview {
  url: string;
  title: string;
}

/**
 * IndexedDB cannot index booleans, so flags that are queried (`pinned`, `deletedAt`) are numbers:
 * pinned is 0/1, deletedAt is 0 while the session is live.
 */
export interface SessionRecord {
  id: string;
  name: string;
  tags: string[];
  pinned: 0 | 1;
  color: string | null;
  kind: 'session' | 'unsorted';
  source: SessionSource;
  createdAt: number;
  updatedAt: number;
  deletedAt: number;
  deviceId: string;
  version: number;
  tabCount: number;
  windowCount: number;
  preview: TabPreview[];
  /** A name the AI gave the fold (Pro AI), shown instead of its time. */
  smartName?: string;
}

export interface WindowRecord {
  id: string;
  sessionId: string;
  name: string;
  order: number;
  wasFocused: boolean;
  bounds: WindowBounds | null;
  state: WindowState | null;
  /** An Incognito window: it reopens only as an Incognito window. */
  incognito?: true;
}

export interface TabRecord {
  id: string;
  sessionId: string;
  windowId: string;
  url: string;
  title: string;
  favIconUrl: string;
  pinned: boolean;
  groupName: string | null;
  groupColor: TabGroupColor | null;
  groupCollapsed: boolean;
  order: number;
  savedAt: number;
  keywords: string[];
  urlTruncated: boolean;
  /**
   * Folded from an Incognito window: kept on this computer only (never in Chrome sync) and
   * reopened only in Incognito.
   */
  incognito?: true;
  /** The AI project it was put in (Pro AI, By project view). */
  project?: string;
}

export type SnapshotReason =
  | 'timer'
  | 'shutdown'
  | 'before-restore'
  | 'before-bulk-close'
  | 'before-import'
  | 'manual';

export interface SnapshotRecord {
  id?: number;
  createdAt: number;
  reason: SnapshotReason;
  tabCount: number;
  windowCount: number;
  hash: string;
  windows: CapturedWindow[];
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

export interface SessionGraph {
  session: SessionRecord;
  windows: Array<WindowRecord & { tabs: TabRecord[] }>;
}

export interface SessionDraft {
  session: SessionRecord;
  windows: WindowRecord[];
  tabs: TabRecord[];
}
