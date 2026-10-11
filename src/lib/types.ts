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
  /**
   * Before 0.6: the AI project it was put in. Read once by the migration to folders
   * (`folderId`), then cleared; nothing else uses it.
   */
  project?: string;
  /** The folder it's in (`FolderRecord.id`). Unset: it's grouped by kind of site. */
  folderId?: string;
  /** Snoozed: hidden in "Snoozed" until this time (ms), then reopened by the computer that snoozed it. */
  snoozeUntil?: number;
  /** The device id (`getDeviceId()`) of the computer that snoozed it; only that one reopens it. */
  snoozedOn?: string;
  /** Last time it was opened from Tabfold (ms), for the weekly tidy-up's "not opened in a month". */
  lastOpenedAt?: number;
}

/**
 * A folder the person named (Fo-* boards). Folders come first in the list and in the left column;
 * tabs not in a folder are grouped by kind of site. Free has 3 live folders; paid plans have no
 * limit. Organise with AI fills folders (it replaced the By project view). Folders sync with the
 * folded tabs (`tf.f`, src/lib/sync/records.ts).
 */
export interface FolderRecord {
  /** Stable id, the same on every computer: 12 characters [0-9a-z]. */
  id: string;
  /** At most 60 characters. */
  name: string;
  color: TabGroupColor;
  /** Position in the left column and the list, ascending. */
  order: number;
  createdAt: number;
  /** Last change to name, colour, order or deletion: when two computers disagree, the newest wins. */
  updatedAt: number;
  /** 0 while live; when deleted, its tabs went back to their kind of site. */
  deletedAt: number;
  /** Who made it: the person, Organise with AI (Pro AI), or an import. */
  source?: 'person' | 'ai' | 'import';
  /** Shared as a link (Pro): the share's id on the server (`POST /shares`). */
  shareId?: string;
  /** The shared page follows the folder's changes ("Keep it up to date"). */
  shareLive?: boolean;
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
