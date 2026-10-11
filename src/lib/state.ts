import { browser } from 'wxt/browser';
import type { FoldOutcome, TabRef } from './messages';
import type { CapturedWindow } from './types';
import type { SiteKinds } from './categories';

/**
 * Small pieces of state shared between the worker and the pages. Session storage is cleared when
 * the browser closes; local storage survives restarts.
 */

export const UNDO_WINDOW_MS = 10_000;

export interface LastAction {
  id: string;
  kind: 'save';
  at: number;
  expiresAt: number;
  sessionId: string;
  sessionName: string;
  savedTabs: number;
  closedTabs: number;
  freedBytes: number;
  keptOpen: { pinned: number; audible: number };
  intoUnsorted: boolean;
  /** Tabs that were written by this action (deleted again on undo). */
  savedTabIds: string[];
  createdSession: boolean;
  /** Saved window id -> browser window id it came from, so undo reopens tabs where they were. */
  windowSources: Record<string, number>;
  closed: boolean;
  undone?: boolean;
  /**
   * Tabs the save closed without writing them (duplicates skipped because they are already saved
   * elsewhere). Undo reopens these too.
   */
  reopenOnly?: Array<{ url: string; title: string; pinned: boolean; sourceWindowId?: number; incognito?: true }>;
  /** Saved tabs whose browser tab refused to close ("Leave site?"). Undo removes them but doesn't reopen them. */
  notClosedTabIds?: string[];
}

/** A restore in progress, so a popup opened mid-restore can show it and offer Cancel. */
export interface ActiveRestore {
  restoreId: string;
  sessionId: string | null;
  snapshotId?: number;
  name: string;
  done: number;
  total: number;
  /** 0-based window being opened, out of windowCount. */
  windowIndex: number;
  windowCount: number;
  startedAt: number;
}

/**
 * A fold in progress or just finished. Phases: saving (writing to the list), closing (tabs closing,
 * `closed` of `total`), waiting (some tabs are showing Chrome's "Leave site?" dialog, listed in
 * `waiting`), done (with the outcome). Kept in session storage so a reopened popup shows it.
 */
export interface ActiveFold {
  foldId: string;
  phase: 'saving' | 'closing' | 'waiting' | 'done' | 'failed';
  /** Tabs being folded (saved and to close). */
  total: number;
  closed: number;
  waiting: TabRef[];
  startedAt: number;
  finishedAt?: number;
  outcome?: FoldOutcome;
  error?: string;
  /** Only this window is being folded. */
  windowId?: number;
}

/**
 * Chrome sync of folded tabs. `syncedTabs` are in Chrome sync (the newest ones, up to the limit);
 * `localOnly` stay on this computer because sync is full. Chrome doesn't tell extensions whether
 * the person is signed in, so "synced" means written to Chrome's sync storage.
 */
export interface SyncStatus {
  state: 'off' | 'syncing' | 'synced' | 'error';
  syncedTabs: number;
  localOnly: number;
  at: number;
  error?: string;
}

/** Chrome downloaded a new version; it installs when the pages reload (see runtime.onUpdateAvailable). */
export interface UpdateReady {
  version: string;
  at: number;
}

/**
 * How much was saved, kept outside IndexedDB. If the database is found empty while this says
 * there were sessions, the data was wiped (for example by "Clear browsing data").
 */
export interface DataGuard {
  sessions: number;
  tabs: number;
  at: number;
}

/** The latest automatic snapshot, copied outside IndexedDB so a wipe can be recovered from. */
export interface SnapshotMirror {
  createdAt: number;
  tabCount: number;
  windowCount: number;
  windows: CapturedWindow[];
}

export interface RecoveryOffer {
  snapshotId: number;
  createdAt: number;
  tabCount: number;
  windowCount: number;
}

export interface PendingKeywordSave {
  tabIds: number[];
  at: number;
}

const LAST_ACTION = 'lastAction';
const WINDOW_NAMES = 'windowNames';
const PENDING_KEYWORDS = 'pendingKeywordSave';
const PENDING_FOLD_ASK = 'pendingFoldAsk';
const RECOVERY = 'recoveryOffer';
const DEVICE_ID = 'deviceId';
const LAST_BACKUP = 'lastBackupAt';
const BACKUP_DUE = 'backupReminderDue';
export const BACKUP_SNOOZED_UNTIL = 'backupReminderSnoozedUntil';
const LIMIT_BANNER_DISMISSED = 'limitBannerDismissedAt';
const ACTIVE_RESTORE = 'activeRestore';
const UPDATE_READY = 'updateReady';
const DATA_GUARD = 'dataGuard';
const SNAPSHOT_MIRROR = 'snapshotMirror';
const GROUPS_UNAVAILABLE = 'groupsUnavailable';
const PENDING_TITLES = 'pendingTitles';
const ACTIVE_FOLD = 'activeFold';
const SYNC_STATUS = 'syncStatus';

async function getKey<T>(area: 'local' | 'session', key: string): Promise<T | undefined> {
  const result = await browser.storage[area].get(key);
  return result[key] as T | undefined;
}

function watchKey<T>(area: 'local' | 'session', key: string, callback: (value: T | undefined) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, changedArea: string) => {
    if (changedArea === area && key in changes) callback(changes[key]?.newValue as T | undefined);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export const lastAction = {
  get: () => getKey<LastAction>('session', LAST_ACTION),
  set: (value: LastAction | null) =>
    value ? browser.storage.session.set({ [LAST_ACTION]: value }) : browser.storage.session.remove(LAST_ACTION),
  watch: (callback: (value: LastAction | undefined) => void) => watchKey('session', LAST_ACTION, callback),
};

export const windowNames = {
  get: async () => (await getKey<Record<string, string>>('session', WINDOW_NAMES)) ?? {},
  set: async (windowId: number, name: string) => {
    const names = await windowNames.get();
    if (name.trim()) names[windowId] = name.trim().slice(0, 120);
    else delete names[windowId];
    await browser.storage.session.set({ [WINDOW_NAMES]: names });
  },
  watch: (callback: (value: Record<string, string> | undefined) => void) => watchKey('session', WINDOW_NAMES, callback),
};

/** The fold shortcut with several windows open: the popup opens already asking which windows. */
export const pendingFoldAsk = {
  get: () => getKey<{ at: number }>('session', PENDING_FOLD_ASK),
  set: (value: { at: number } | null) =>
    value ? browser.storage.session.set({ [PENDING_FOLD_ASK]: value }) : browser.storage.session.remove(PENDING_FOLD_ASK),
};

export const pendingKeywordSave = {
  get: () => getKey<PendingKeywordSave>('session', PENDING_KEYWORDS),
  set: (value: PendingKeywordSave | null) =>
    value
      ? browser.storage.session.set({ [PENDING_KEYWORDS]: value })
      : browser.storage.session.remove(PENDING_KEYWORDS),
};

export const recoveryOffer = {
  get: () => getKey<RecoveryOffer>('local', RECOVERY),
  set: (value: RecoveryOffer | null) =>
    value ? browser.storage.local.set({ [RECOVERY]: value }) : browser.storage.local.remove(RECOVERY),
  watch: (callback: (value: RecoveryOffer | undefined) => void) => watchKey('local', RECOVERY, callback),
};

export async function getDeviceId(): Promise<string> {
  const existing = await getKey<string>('local', DEVICE_ID);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await browser.storage.local.set({ [DEVICE_ID]: id });
  return id;
}

export const backup = {
  lastAt: () => getKey<number>('local', LAST_BACKUP),
  markDone: () => browser.storage.local.set({ [LAST_BACKUP]: Date.now(), [BACKUP_DUE]: false }),
  isDue: async () => (await getKey<boolean>('local', BACKUP_DUE)) === true,
  setDue: (due: boolean) => browser.storage.local.set({ [BACKUP_DUE]: due }),
  watchDue: (callback: (value: boolean | undefined) => void) => watchKey('local', BACKUP_DUE, callback),
  /** "Remind me next month" pushes the reminder back until this time. */
  snoozedUntil: async () => (await getKey<number>('local', BACKUP_SNOOZED_UNTIL)) ?? 0,
};

export const limitBanner = {
  dismissedAt: () => getKey<number>('local', LIMIT_BANNER_DISMISSED),
  dismiss: () => browser.storage.local.set({ [LIMIT_BANNER_DISMISSED]: Date.now() }),
};

export const activeRestore = {
  get: () => getKey<ActiveRestore>('session', ACTIVE_RESTORE),
  set: (value: ActiveRestore | null) =>
    value ? browser.storage.session.set({ [ACTIVE_RESTORE]: value }) : browser.storage.session.remove(ACTIVE_RESTORE),
  watch: (callback: (value: ActiveRestore | undefined) => void) => watchKey('session', ACTIVE_RESTORE, callback),
};

export const updateReady = {
  get: () => getKey<UpdateReady>('local', UPDATE_READY),
  set: (value: UpdateReady | null) =>
    value ? browser.storage.local.set({ [UPDATE_READY]: value }) : browser.storage.local.remove(UPDATE_READY),
  watch: (callback: (value: UpdateReady | undefined) => void) => watchKey('local', UPDATE_READY, callback),
};

export const dataGuard = {
  get: () => getKey<DataGuard>('local', DATA_GUARD),
  set: (value: DataGuard) => browser.storage.local.set({ [DATA_GUARD]: value }),
};

export const snapshotMirror = {
  get: () => getKey<SnapshotMirror>('local', SNAPSHOT_MIRROR),
  set: (value: SnapshotMirror | null) =>
    value ? browser.storage.local.set({ [SNAPSHOT_MIRROR]: value }) : browser.storage.local.remove(SNAPSHOT_MIRROR),
};

/** Set when Chrome refuses the tab groups API (for example an organisation policy). */
export const groupsUnavailable = {
  get: async () => (await getKey<boolean>('local', GROUPS_UNAVAILABLE)) === true,
  set: (value: boolean) => browser.storage.local.set({ [GROUPS_UNAVAILABLE]: value }),
  watch: (callback: (value: boolean | undefined) => void) => watchKey('local', GROUPS_UNAVAILABLE, callback),
};

/** Browser tab id -> saved tab id, for tabs saved (kept open) before their title arrived. */
export const pendingTitles = {
  get: async () => (await getKey<Record<string, string>>('session', PENDING_TITLES)) ?? {},
  set: (value: Record<string, string>) => browser.storage.session.set({ [PENDING_TITLES]: value }),
};

export const activeFold = {
  get: () => getKey<ActiveFold>('session', ACTIVE_FOLD),
  set: (value: ActiveFold | null) =>
    value ? browser.storage.session.set({ [ACTIVE_FOLD]: value }) : browser.storage.session.remove(ACTIVE_FOLD),
  watch: (callback: (value: ActiveFold | undefined) => void) => watchKey('session', ACTIVE_FOLD, callback),
};

export const syncStatus = {
  get: () => getKey<SyncStatus>('local', SYNC_STATUS),
  set: (value: SyncStatus) => browser.storage.local.set({ [SYNC_STATUS]: value }),
  watch: (callback: (value: SyncStatus | undefined) => void) => watchKey('local', SYNC_STATUS, callback),
};

// ---- 0.6: folders, snooze, fold automatically, live folders, tidy-up -------------------------------

/** Sites moved to another kind (src/lib/categories.ts `SiteKinds`), synced in `tf.f`. */
const SITE_KINDS = 'siteKinds';

export const siteKinds = {
  get: async (): Promise<SiteKinds> => ((await browser.storage.local.get(SITE_KINDS))[SITE_KINDS] as SiteKinds | undefined) ?? {},
  set: (value: SiteKinds) => browser.storage.local.set({ [SITE_KINDS]: value }),
  watch: (callback: (value: SiteKinds) => void) =>
    watchKey('local', SITE_KINDS, (value) => callback((value as SiteKinds | undefined) ?? {})),
};

/** Snoozed tabs that came back and haven't been looked at yet: the toolbar icon's number. */
export interface SnoozeBack {
  tabRecordIds: string[];
  titles: string[];
  at: number;
}

const SNOOZE_BACK = 'snoozeBack';
export const snoozeBack = {
  get: () => getKey<SnoozeBack>('local', SNOOZE_BACK),
  set: (value: SnoozeBack | null) =>
    value === null ? browser.storage.local.remove(SNOOZE_BACK) : browser.storage.local.set({ [SNOOZE_BACK]: value }),
  watch: (callback: (value: SnoozeBack | undefined) => void) => watchKey('local', SNOOZE_BACK, callback),
};

/** The last automatic fold, for the "Folded 23 tabs at 18:00 (your weekday rule) · Undo" line. */
export interface AutoFoldNotice {
  ruleId: string;
  /** What the rule says, e.g. "your weekday rule". */
  label: string;
  folded: number;
  freedBytes: number;
  at: number;
  /** Undo for the fold (lastAction), while it lasts. */
  actionId: string | null;
}

const AUTO_FOLD_NOTICE = 'autoFoldNotice';
export const autoFoldNotice = {
  get: () => getKey<AutoFoldNotice>('local', AUTO_FOLD_NOTICE),
  set: (value: AutoFoldNotice | null) =>
    value === null ? browser.storage.local.remove(AUTO_FOLD_NOTICE) : browser.storage.local.set({ [AUTO_FOLD_NOTICE]: value }),
  watch: (callback: (value: AutoFoldNotice | undefined) => void) => watchKey('local', AUTO_FOLD_NOTICE, callback),
};

/** A folder open as a Chrome tab group that saves itself (Pro). Keyed by folder id. */
export interface LiveFolder {
  folderId: string;
  groupId: number;
  windowId: number;
  openedAt: number;
}

const LIVE_FOLDERS = 'liveFolders';
/** In chrome.storage.session: tab group ids don't survive a browser restart. */
export const liveFolders = {
  get: async (): Promise<Record<string, LiveFolder>> =>
    ((await browser.storage.session.get(LIVE_FOLDERS))[LIVE_FOLDERS] as Record<string, LiveFolder> | undefined) ?? {},
  set: (value: Record<string, LiveFolder>) => browser.storage.session.set({ [LIVE_FOLDERS]: value }),
  watch: (callback: (value: Record<string, LiveFolder>) => void) =>
    watchKey('session', LIVE_FOLDERS, (value) => callback((value as Record<string, LiveFolder> | undefined) ?? {})),
};

/** One suggestion in Pro AI's weekly tidy-up. */
export interface TidySuggestion {
  id: string;
  kind: 'fold-into' | 'duplicates' | 'remove-old';
  /** e.g. "38 tabs about Lisbon haven't been opened in a month". */
  text: string;
  /** Button label, e.g. "Fold into Holiday", "Remove duplicates". */
  action: string;
  tabRecordIds: string[];
  /** fold-into: an existing folder, or the name for a new one. */
  folderId?: string;
  folderName?: string;
}

export interface TidyState {
  at: number;
  suggestions: TidySuggestion[];
  /** "Not now": hidden until the next week's tidy-up. */
  dismissedAt?: number;
}

const TIDY = 'tidyUp';
export const tidyState = {
  get: () => getKey<TidyState>('local', TIDY),
  set: (value: TidyState | null) => (value === null ? browser.storage.local.remove(TIDY) : browser.storage.local.set({ [TIDY]: value })),
  watch: (callback: (value: TidyState | undefined) => void) => watchKey('local', TIDY, callback),
};
