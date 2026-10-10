import { browser } from 'wxt/browser';
import type { ActiveFold } from './state';
import type { TabGroupColor } from './types';

/**
 * Commands the popup and library send to the service worker. The worker owns every tab and window
 * action (save, close, restore, suspend) so a closing popup can never interrupt one halfway.
 */

export type SaveScope = 'all' | 'window' | 'tabs';
export type RestoreMode = 'original' | 'current' | 'new-window';

export interface ScreenArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** An open browser tab, as reported back to a page (for "Show tab" and per-tab lists). */
export interface TabRef {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
}

export type Command =
  | {
      type: 'preflight-save';
      scope: SaveScope;
      windowId?: number;
      tabIds?: number[];
      targetSessionId?: string | null;
      /** Only with scope 'window' or 'tabs': the user chose to save an Incognito window. */
      includeIncognito?: boolean;
    }
  | {
      type: 'save';
      scope: SaveScope;
      windowId?: number;
      tabIds?: number[];
      close: boolean;
      audible?: 'keep' | 'close';
      keywordsByTabId?: Record<number, string[]>;
      targetSessionId?: string | null;
      name?: string;
      /**
       * Tabs already saved elsewhere: the answer from the popup's "Ask" sheet. Without it the
       * setting decides, and a setting of "ask" saves them again.
       */
      duplicates?: 'skip' | 'keep';
      /** Only with scope 'window' or 'tabs': the user confirmed saving an Incognito window. */
      includeIncognito?: boolean;
    }
  | { type: 'undo'; actionId: string }
  | {
      type: 'restore';
      sessionId: string;
      windowRecordId?: string;
      mode: RestoreMode;
      currentWindowId?: number;
      screen?: ScreenArea;
      force?: boolean;
      /**
       * Open new windows without focusing them and focus the first one at the end, so the popup
       * (which closes when it loses focus) can show progress.
       */
      background?: boolean;
    }
  | { type: 'restore-snapshot'; snapshotId: number; mode: RestoreMode; currentWindowId?: number; screen?: ScreenArea }
  | { type: 'snapshot-to-session'; snapshotId: number }
  | { type: 'cancel-restore'; restoreId: string }
  | { type: 'open-saved-tab'; tabRecordId: string; active: boolean; windowId?: number }
  | { type: 'suspend-inactive'; windowId?: number }
  | { type: 'suspend-tab'; tabId: number }
  | { type: 'take-snapshot'; reason?: 'manual' | 'before-import' }
  | { type: 'dismiss-recovery' }
  /** After the database was wiped: turn the copy of the last snapshot kept in chrome.storage into a session. */
  | { type: 'recover-from-mirror' }
  /**
   * Fold: save every tab in every normal window, then close them. Pinned tabs (per the setting)
   * and tabs playing sound stay open; tabs already folded are not saved twice. Progress is kept
   * in `activeFold` (state.ts) and broadcast as `fold-progress`, so a popup that closes and
   * reopens mid-fold picks it up.
   */
  /**
   * Fold every window, or with `windowId` only that window ("Just this window", or a window's own
   * Fold). `keepWindowOpen` leaves that window open with a new tab (the window you're in).
   */
  | { type: 'fold'; windowId?: number; keepWindowOpen?: boolean }
  /** Open folded tabs ("Open all" on a group). With `asGroup`, they open as one Chrome tab group. */
  | { type: 'open-tabs'; tabRecordIds: string[]; asGroup?: { name: string; color: TabGroupColor }; windowId?: number }
  /** Push folded tabs to Chrome sync now (normally it runs a few seconds after each change). */
  | { type: 'sync-now' };

export interface DuplicateTab extends TabRef {
  sessionId: string;
  sessionName: string;
}

export interface PreflightResult {
  /** Tabs that would be saved. */
  tabs: number;
  windows: number;
  audible: number;
  pinnedKept: number;
  /** Tabs that would close (saved tabs plus skipped new tab pages). */
  closeTabs: number;
  /** Estimated memory freed by closing the loaded ones. */
  freedBytes: number;
  audibleTabs: TabRef[];
  /** Addresses longer than Tabfold stores in full (8,192 characters); `length` is the full length. */
  longUrls: Array<TabRef & { length: number }>;
  /** Tabs already saved in a live session (the target session or any other). */
  duplicates: DuplicateTab[];
  /** Only pinned (kept open), blank or Tabfold pages: Save would do nothing. */
  nothingToSave: boolean;
}

export interface SaveOutcome {
  sessionId: string | null;
  sessionName: string;
  savedTabs: number;
  closedTabs: number;
  skippedDuplicates: number;
  keptOpen: { pinned: number; audible: number };
  /** Tabs that refused to close (for example a "Leave site?" prompt). They are saved. */
  failedToClose: TabRef[];
  freedBytes: number;
  intoUnsorted: boolean;
  actionId: string | null;
  /** Tabs whose address was too long and was saved in part. */
  truncatedTabs: number;
  /** Tabs opened in the saved windows while the save ran; they were left open. */
  newTabsLeftOpen: number;
}

export interface RestoreFailure {
  url: string;
  title: string;
  /**
   * 'file-access': a file:// page and "Allow access to file URLs" is off. 'blocked': Chrome never
   * lets extensions open it. 'incognito': folded from Incognito and "Allow in Incognito" is off.
   */
  reason?: 'file-access' | 'blocked' | 'incognito' | 'error';
}

export interface RestoreOutcome {
  restoreId: string;
  opened: number;
  failed: RestoreFailure[];
  cancelled: boolean;
  /** Set instead of restoring when the same window is already open. */
  alreadyOpenWindowId?: number;
  /** Details for the "already open" prompt: the windows holding the open copy. */
  alreadyOpen?: { windowIds: number[]; openTabs: number; totalTabs: number };
  /** Local files that couldn't open because file access is off (also listed in `failed`). */
  needsFileAccess: number;
  trashed: boolean;
}

export type KeptAwakeReason = 'active' | 'pinned' | 'audible' | 'protectedSite' | 'failed';

export interface SuspendOutcome {
  suspended: number;
  skipped: { active: number; pinned: number; audible: number; protectedSite: number; already: number; failed: number };
  freedBytes: number;
  /** Each tab that was eligible by idleness but kept loaded, with why (active tabs included). */
  keptAwake: Array<TabRef & { reason: KeptAwakeReason }>;
}

/** The computer's memory, read with chrome.system.memory. Null when the reading isn't available. */
export interface MemoryReading {
  /** Bytes free before the fold. */
  freeBefore: number | null;
  /** Bytes free about 2 seconds after the tabs closed. */
  freeAfter: number | null;
  capacity: number | null;
}

export interface FoldOutcome extends SaveOutcome {
  foldId: string;
  /** Set when only this window was folded. */
  windowId?: number;
  /**
   * Tabs that stayed open on purpose: pinned, playing sound, in app or pop-up windows, and in
   * Incognito windows while "Fold Incognito windows too" is off (counted only when Chrome lets
   * Tabfold see them).
   */
  stayedOpen: { pinned: number; audible: number; apps?: number; incognito?: number };
  memory: MemoryReading;
}

export interface CommandResults {
  'preflight-save': PreflightResult;
  save: SaveOutcome;
  undo: { undone: boolean; reason?: string };
  restore: RestoreOutcome;
  'restore-snapshot': RestoreOutcome;
  'snapshot-to-session': { sessionId: string | null };
  'cancel-restore': { cancelled: boolean };
  'open-saved-tab': { opened: boolean; reason?: string };
  'suspend-inactive': SuspendOutcome;
  'suspend-tab': SuspendOutcome;
  'take-snapshot': { snapshotId: number | null };
  'dismiss-recovery': { ok: true };
  'recover-from-mirror': { sessionId: string | null };
  fold: FoldOutcome;
  'open-tabs': { opened: number; reason?: string };
  'sync-now': { ok: boolean };
}

export type CommandResponse<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export async function send<C extends Command>(command: C): Promise<CommandResults[C['type']]> {
  const response = (await browser.runtime.sendMessage({ __tabfold: true, command })) as
    | CommandResponse<CommandResults[C['type']]>
    | undefined;
  if (!response) throw new CommandError('Tabfold is starting up. Try again in a moment.', 'no-response');
  if (!response.ok) throw new CommandError(response.error, response.code);
  return response.data;
}

/** Events the worker broadcasts to open extension pages. */
export type WorkerEvent =
  | {
      type: 'restore-progress';
      restoreId: string;
      done: number;
      total: number;
      /** 0-based window being opened, out of windowCount. */
      windowIndex: number;
      windowCount: number;
      sessionId: string | null;
    }
  | { type: 'restore-done'; restoreId: string; outcome: RestoreOutcome }
  | { type: 'fold-progress'; fold: ActiveFold };

export function isWorkerEvent(message: unknown): message is { __tabfoldEvent: true; event: WorkerEvent } {
  return !!message && typeof message === 'object' && (message as { __tabfoldEvent?: boolean }).__tabfoldEvent === true;
}
