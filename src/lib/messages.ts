import { browser } from 'wxt/browser';
import type { CategoryId } from './categories';
import type { AiGroup, BackupInfo, BillingInterval, CheckoutPlan, OrganiseResult, PlanState, SigninPurpose, SigninResult } from './pro/types';
import type { TidyState } from './state';
import type { ActiveFold } from './state';
import type { FolderRecord, TabGroupColor } from './types';

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
  | {
      type: 'fold';
      windowId?: number;
      keepWindowOpen?: boolean;
      /** Only these open tabs (snoozing an open tab, a rule that folds some tabs). */
      tabIds?: number[];
      /** Put the folded tabs in this folder (a rule's "Into"). */
      intoFolderId?: string;
      /** Who asked: a person (default), or an auto-fold rule (shown in its notice). */
      source?: 'person' | 'rule';
    }
  /** Open folded tabs ("Open all" on a group). With `asGroup`, they open as one Chrome tab group. */
  | { type: 'open-tabs'; tabRecordIds: string[]; asGroup?: { name: string; color: TabGroupColor }; windowId?: number }
  /** Push folded tabs to Chrome sync now (normally it runs a few seconds after each change). */
  | { type: 'sync-now' }
  // ---- Pro and Pro AI (src/lib/pro) ----
  /** Read the plan from the server (`GET /me`), at most once a minute unless `force`. */
  | { type: 'plan-refresh'; force?: boolean }
  /**
   * Open Stripe Checkout for a plan in a new tab and watch it: paying turns the tab into the
   * welcome page, cancelling closes it. With a live subscription already, opens Stripe's billing page.
   */
  | {
      type: 'checkout-open';
      tier: CheckoutPlan;
      /** Not used for 'pro-lifetime' (one payment). */
      interval: BillingInterval;
      /** Teams: how many people (the owner included), and the team's name. */
      seats?: number;
      teamName?: string;
    }
  /** "Go to the Stripe tab": bring the watched checkout tab to the front. */
  | { type: 'checkout-focus' }
  /** Open Stripe's billing page (change plan, card, invoices, cancel) in a new tab; `payment-method` opens on the card form. */
  | { type: 'billing-open'; flow?: 'payment-method' }
  /** Email a 6-digit sign-in code. */
  | { type: 'signin-start'; email: string; purpose: SigninPurpose }
  /** Check the code and sign this computer in; with `startTrial`, start the Pro AI trial if this email never had one. */
  | { type: 'signin-finish'; email: string; code: string; startTrial: boolean }
  /** Start the Pro AI trial for the account this computer is signed in to. */
  | { type: 'trial-start' }
  /** Sign out on this computer (other computers stay signed in). */
  | { type: 'signout' }
  /** Ask the AI for folders for the folded tabs not in one yet (a preview; nothing changes). */
  | { type: 'ai-organise' }
  /** Put tabs in the folders the person kept (after the preview), making the new ones. */
  | { type: 'ai-apply'; groups: AiGroup[] }
  /** A group's tabs as Markdown context for Claude, ChatGPT or Cursor, with a short AI summary. */
  | { type: 'ai-context'; tabRecordIds: string[]; name: string }
  | { type: 'backups-list' }
  /** Bring back tabs from a daily backup that aren't in the list now (nothing is deleted). */
  | { type: 'backup-restore'; day: string }
  /** Sync with the Tabfold account now. */
  | { type: 'cloud-sync-now' }
  | { type: 'milestone-dismiss' }
  /** Before removing Tabfold: reopen every folded tab, lazily, one window per fold. */
  | { type: 'reopen-everything' }
  // ---- 0.6: folders and kinds of site (src/lib/background/folders.ts) ----
  /** A new folder (Free: 3 live folders, else `folder-limit`). With tabs, they move into it. */
  | { type: 'folder-create'; name: string; color?: TabGroupColor; tabRecordIds?: string[] }
  | { type: 'folder-update'; id: string; name?: string; color?: TabGroupColor }
  /** The folders' order in the left column, top first. */
  | { type: 'folder-reorder'; ids: string[] }
  /** Delete a folder; its tabs go back to their kind of site (Undo with `undo`). */
  | { type: 'folder-delete'; id: string }
  /** Move tabs into a folder, or out of their folder (`folderId: null`). Undo with `undo`. */
  | { type: 'tabs-move'; tabRecordIds: string[]; folderId: string | null }
  /** Move a site to another kind (remembered for its new tabs), or put it back (`kind: null`). */
  | { type: 'site-kind-set'; host: string; kind: CategoryId | null }
  // ---- The free list's 500 tabs ("Make room", src/lib/background/folders.ts) ----
  | { type: 'room-list' }
  /** Remove these folds, or every tab folded more than `olderThanDays` days ago. Undo with `undo`. */
  | { type: 'room-free'; sessionIds?: string[]; olderThanDays?: number }
  /** The same page saved twice or more. */
  | { type: 'duplicates-list' }
  /** Remove the extra copies (the newest stays, with its folder). Only these groups' extras when given. */
  | { type: 'duplicates-remove'; urls?: string[] }
  // ---- Snooze and Fold automatically (src/lib/background/automation.ts) ----
  /** Snooze folded tabs, or fold and snooze open tabs, until `until` (Free: 3 at a time, `snooze-limit`). */
  | { type: 'snooze'; until: number; tabRecordIds?: string[]; tabIds?: number[] }
  /** Reopen snoozed tabs now ("Wake now"). */
  | { type: 'snooze-wake'; tabRecordIds: string[] }
  /** The person saw the tabs that came back: clear the toolbar number. */
  | { type: 'snooze-seen' }
  /** Run an auto-fold rule now. */
  | { type: 'autofold-run'; ruleId: string }
  // ---- Live folders, Pro (src/lib/background/live.ts) ----
  /** Open a folder as a Chrome tab group that saves itself. `foldOthers` folds other live folders first. */
  | { type: 'live-open'; folderId: string; newWindow?: boolean; foldOthers?: boolean }
  /** Save and close a live folder's group ("Fold the group"). */
  | { type: 'live-fold'; folderId: string }
  | { type: 'live-focus'; folderId: string }
  // ---- Share a folder, Pro (src/lib/background/share.ts) ----
  | { type: 'share-create'; folderId: string; live: boolean }
  /** Send the folder's tabs to its shared page now, and/or switch "Keep it up to date". */
  | { type: 'share-update'; folderId: string; live?: boolean }
  | { type: 'share-stop'; folderId: string }
  | { type: 'share-info'; folderId: string }
  // ---- Ask your tabs and the weekly tidy-up, Pro AI (src/lib/background/tidy.ts) ----
  | { type: 'ai-ask'; query: string }
  /** Work out this week's tidy-up now (it also runs on Mondays). */
  | { type: 'tidy-run' }
  | { type: 'tidy-apply'; suggestionId: string }
  /** "Not now": hide the card until next week. */
  | { type: 'tidy-dismiss' };

/** One fold in "Make room", oldest first. */
export interface RoomFold {
  sessionId: string;
  name: string;
  createdAt: number;
  tabCount: number;
  windowCount: number;
}

export interface RoomList {
  /** Folded tabs now (snoozed included). */
  tabs: number;
  /** The plan's limit, or null when there's none. */
  limit: number | null;
  /** Oldest folds first (at most 50). */
  folds: RoomFold[];
  /** "Everything folded more than 60 days ago": how many tabs that is. */
  olderThan: { days: number; tabs: number };
}

/** The same page folded more than once: newest first (the first stays). */
export interface DuplicateGroup {
  url: string;
  title: string;
  tabRecordIds: string[];
}

/** A tab Ask your tabs found, and why (from titles and sites only). */
export interface AskMatch {
  tabRecordId: string;
  reason: string;
}

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
  'plan-refresh': PlanState;
  'checkout-open': { opened: boolean; reason?: string };
  'checkout-focus': { focused: boolean };
  'billing-open': { opened: boolean; reason?: string };
  'signin-start': { sent: true };
  'signin-finish': SigninResult;
  'trial-start': SigninResult;
  signout: { ok: true };
  'ai-organise': OrganiseResult;
  /** `folders`: new folders made (0.6). */
  'ai-apply': { applied: number; folders?: number };
  'ai-context': { markdown: string };
  'backups-list': BackupInfo[];
  /** `skippedOverLimit`: tabs left out because the free list is full (0.6). */
  'backup-restore': { restored: number; sessionId: string | null; skippedOverLimit?: number };
  'cloud-sync-now': { ok: boolean };
  'milestone-dismiss': { ok: boolean };
  'reopen-everything': { opened: number; failed: number };
  'folder-create': { folder: FolderRecord };
  'folder-update': { folder: FolderRecord };
  'folder-reorder': { ok: true };
  'folder-delete': { tabs: number; actionId: string | null };
  'tabs-move': { moved: number; actionId: string | null };
  'site-kind-set': { tabs: number; actionId: string | null };
  'room-list': RoomList;
  'room-free': { removed: number; actionId: string | null };
  'duplicates-list': { groups: DuplicateGroup[] };
  'duplicates-remove': { removed: number; actionId: string | null };
  snooze: { snoozed: number; actionId: string | null };
  'snooze-wake': { opened: number };
  'snooze-seen': { ok: true };
  'autofold-run': { folded: number };
  'live-open': { opened: number; groupId: number | null; reason?: string };
  'live-fold': { folded: number };
  'live-focus': { focused: boolean };
  'share-create': { url: string; shareId: string };
  'share-update': { url: string; views: number; live: boolean };
  'share-stop': { ok: true };
  'share-info': { url: string; views: number; live: boolean } | null;
  'ai-ask': { matches: AskMatch[] };
  'tidy-run': TidyState;
  'tidy-apply': { done: number; actionId: string | null };
  'tidy-dismiss': { ok: true };
}

/**
 * CommandError codes for the 0.6 limits, with `details`:
 * - 'list-full': the free list has no room for this ({ room, needed, limit }). Fold, save, snooze of open tabs, import.
 * - 'folder-limit': Free has 3 folders ({ limit }).
 * - 'snooze-limit': Free has 3 snoozed tabs at a time ({ limit }).
 * - 'needs-pro' / 'needs-pro-ai': a paid feature (live folders, sharing; Ask and tidy-up).
 */
export type LimitErrorCode = 'list-full' | 'folder-limit' | 'snooze-limit';

/** A failure; `details` carries a few numbers a page may show (a sign-in code's tries left, seconds to wait). */
export type CommandResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; details?: Record<string, number> };

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: Record<string, number>,
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
  if (!response.ok) throw new CommandError(response.error, response.code, response.details);
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
  | { type: 'fold-progress'; fold: ActiveFold }
  /** A Free action hit a limit where no page asked (the shortcut, a rule): pages show the banner. */
  | { type: 'limit-hit'; code: LimitErrorCode };

export function isWorkerEvent(message: unknown): message is { __tabfoldEvent: true; event: WorkerEvent } {
  return !!message && typeof message === 'object' && (message as { __tabfoldEvent?: boolean }).__tabfoldEvent === true;
}
