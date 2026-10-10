import { browser } from 'wxt/browser';

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
