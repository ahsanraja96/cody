import { browser } from 'wxt/browser';
import type { CapturedWindow } from './types';

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
  reopenOnly?: Array<{ url: string; title: string; pinned: boolean; sourceWindowId?: number }>;
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
const RECOVERY = 'recoveryOffer';
const DEVICE_ID = 'deviceId';
const LAST_BACKUP = 'lastBackupAt';
const BACKUP_DUE = 'backupReminderDue';
const LIMIT_BANNER_DISMISSED = 'limitBannerDismissedAt';
const ACTIVE_RESTORE = 'activeRestore';
const UPDATE_READY = 'updateReady';
const DATA_GUARD = 'dataGuard';
const SNAPSHOT_MIRROR = 'snapshotMirror';
const GROUPS_UNAVAILABLE = 'groupsUnavailable';
const PENDING_TITLES = 'pendingTitles';

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
