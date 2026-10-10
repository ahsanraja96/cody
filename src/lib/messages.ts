import { browser } from 'wxt/browser';

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

export type Command =
  | { type: 'preflight-save'; scope: SaveScope; windowId?: number; tabIds?: number[] }
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
    }
  | { type: 'restore-snapshot'; snapshotId: number; mode: RestoreMode; currentWindowId?: number; screen?: ScreenArea }
  | { type: 'snapshot-to-session'; snapshotId: number }
  | { type: 'cancel-restore'; restoreId: string }
  | { type: 'open-saved-tab'; tabRecordId: string; active: boolean; windowId?: number }
  | { type: 'suspend-inactive'; windowId?: number }
  | { type: 'suspend-tab'; tabId: number }
  | { type: 'take-snapshot'; reason?: 'manual' | 'before-import' }
  | { type: 'dismiss-recovery' };

export interface PreflightResult {
  tabs: number;
  windows: number;
  audible: number;
  pinnedKept: number;
}

export interface SaveOutcome {
  sessionId: string | null;
  sessionName: string;
  savedTabs: number;
  closedTabs: number;
  skippedDuplicates: number;
  keptOpen: { pinned: number; audible: number };
  failedToClose: Array<{ title: string; url: string }>;
  freedBytes: number;
  intoUnsorted: boolean;
  actionId: string | null;
}

export interface RestoreFailure {
  url: string;
  title: string;
}

export interface RestoreOutcome {
  restoreId: string;
  opened: number;
  failed: RestoreFailure[];
  cancelled: boolean;
  /** Set instead of restoring when the same window is already open. */
  alreadyOpenWindowId?: number;
  trashed: boolean;
}

export interface SuspendOutcome {
  suspended: number;
  skipped: { active: number; pinned: number; audible: number; protectedSite: number; already: number; failed: number };
  freedBytes: number;
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
export type WorkerEvent = { type: 'restore-progress'; restoreId: string; done: number; total: number };

export function isWorkerEvent(message: unknown): message is { __tabfoldEvent: true; event: WorkerEvent } {
  return !!message && typeof message === 'object' && (message as { __tabfoldEvent?: boolean }).__tabfoldEvent === true;
}
