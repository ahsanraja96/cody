import { browser } from 'wxt/browser';
import { refreshDataGuard } from '../dataGuard';
import { db } from '../db';
import { extUrl } from '../extUrl';
import { countNamedSessions, pruneSnapshots, purgeTrash } from '../repo';
import { getSettings } from '../settings';
import { activeRestore, backup, getDeviceId, windowNames } from '../state';
import type { Command, CommandResponse } from '../messages';
import { setupSync, syncTick } from '../sync/engine';
import { forgetUnfinishedFold } from './fold';
import { createMenus, onCommand, onMenuClicked } from './menus';
import { route } from './router';
import { checkRecovery, promoteShutdownSnapshot, scheduleSnapshot, takeSnapshot } from './snapshots';
import { autoSuspendTick } from './suspend';
import { forgetPendingTitle, onTabUpdated } from './titles';
import { onUpdateAvailable, onUpdated } from './update';

/**
 * The service worker. It keeps no state in memory between wake-ups: everything lives in
 * IndexedDB or extension storage, and every scheduled job uses chrome.alarms.
 * All listeners are registered synchronously at the top level, exactly once.
 */

const ALARMS = {
  snapshot: { name: 'tabfold-snapshot', periodInMinutes: 5 },
  autoSuspend: { name: 'tabfold-auto-suspend', periodInMinutes: 1 },
  daily: { name: 'tabfold-daily', periodInMinutes: 24 * 60 },
  /** Catches folded-tab changes made while the worker slept; cheap when nothing changed. */
  sync: { name: 'tabfold-sync', periodInMinutes: 1 },
} as const;

const INSTALLED_AT = 'installedAt';
const BACKUP_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

async function ensureAlarms(): Promise<void> {
  for (const alarm of Object.values(ALARMS)) {
    const existing = await browser.alarms.get(alarm.name);
    if (!existing) await browser.alarms.create(alarm.name, { periodInMinutes: alarm.periodInMinutes, delayInMinutes: 1 });
  }
}

async function dailyMaintenance(): Promise<void> {
  await purgeTrash();
  await pruneSnapshots();
  await refreshDataGuard();
  const settings = await getSettings();
  if (!settings.backupReminder) return;
  const stored = await browser.storage.local.get(INSTALLED_AT);
  const since = (await backup.lastAt()) ?? (stored[INSTALLED_AT] as number | undefined) ?? Date.now();
  if (Date.now() < (await backup.snoozedUntil())) return;
  if (Date.now() - since > BACKUP_INTERVAL_MS && (await countNamedSessions()) > 0) await backup.setDue(true);
}

function safely(label: string, task: () => Promise<unknown>): void {
  task().catch((error) => console.error(`[tabfold] ${label} failed`, error));
}

/**
 * Runs once per browser session. Extension session storage is cleared whenever the browser
 * restarts, so a missing flag means "the browser just started" (or Tabfold was just installed or
 * updated). This is sturdier than runtime.onStartup, which Chrome does not fire in every case.
 */
const SESSION_FLAG = 'browserSessionStartedAt';
let startup: Promise<void> | null = null;

function ensureStartup(): Promise<void> {
  startup ??= (async () => {
    const flag = await browser.storage.session.get(SESSION_FLAG);
    if (flag[SESSION_FLAG]) return;
    await browser.storage.session.set({ [SESSION_FLAG]: Date.now() });
    await promoteShutdownSnapshot();
    // Give Chrome a moment to bring back its own tabs before deciding whether to offer recovery.
    setTimeout(() => safely('recovery check', checkRecovery), 8000);
  })().catch((error) => console.error('[tabfold] startup failed', error));
  return startup;
}

/**
 * A command from a Tabfold page. Only this extension's own pages may send them: anything else
 * (another extension, a web page) is ignored. Returns undefined for messages that aren't ours.
 */
export function handleMessage(
  message: unknown,
  sender: { id?: string; tab?: { id?: number } },
): Promise<CommandResponse<unknown>> | undefined {
  if (sender.id !== browser.runtime.id) return undefined;
  if (!message || typeof message !== 'object' || !(message as { __tabfold?: boolean }).__tabfold) return undefined;
  return route((message as { command: Command }).command, { tabId: sender.tab?.id });
}

export function setupBackground(): void {
  browser.runtime.onInstalled.addListener((details) => {
    safely('install', async () => {
      await createMenus();
      await ensureAlarms();
      await getDeviceId();
      await db.open();
      if (details.reason === 'install') {
        await browser.storage.local.set({ [INSTALLED_AT]: Date.now() });
        await browser.tabs.create({ url: extUrl('/onboarding.html') });
      }
      if (details.reason === 'update') await onUpdated();
      await ensureStartup();
      await takeSnapshot('timer');
      await refreshDataGuard();
    });
  });

  browser.runtime.onUpdateAvailable.addListener((details) => {
    safely('update available', () => onUpdateAvailable(details.version));
  });

  browser.runtime.onStartup.addListener(() => {
    safely('startup', async () => {
      await ensureStartup();
      await ensureAlarms();
    });
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const response = handleMessage(message, sender);
    if (!response) return false;
    response.then(sendResponse);
    return true;
  });

  browser.contextMenus.onClicked.addListener((info, tab) => safely('menu', () => onMenuClicked(info, tab)));
  browser.commands.onCommand.addListener((command, tab) => safely('shortcut', () => onCommand(command, tab)));

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARMS.snapshot.name) {
      safely('snapshot', async () => {
        await ensureStartup();
        await takeSnapshot('timer');
        // A cheap count, kept outside IndexedDB, so a wiped database can be noticed.
        await refreshDataGuard();
      });
    }
    else if (alarm.name === ALARMS.autoSuspend.name) safely('auto-suspend', () => autoSuspendTick());
    else if (alarm.name === ALARMS.daily.name) safely('daily', dailyMaintenance);
    else if (alarm.name === ALARMS.sync.name) safely('sync', syncTick);
  });

  // Snapshots follow tab changes, debounced. Events fired while a window is closing are ignored so a
  // quitting browser never overwrites the last good snapshot with an empty one.
  browser.tabs.onCreated.addListener(() => scheduleSnapshot());
  browser.tabs.onRemoved.addListener((id, info) => {
    if (!info.isWindowClosing) scheduleSnapshot();
    safely('pending title', () => forgetPendingTitle(id));
  });
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.url || change.pinned !== undefined || change.groupId !== undefined) scheduleSnapshot();
    // A tab saved (kept open) before its title arrived gets its real title.
    if (change.title !== undefined || change.status === 'complete') safely('title fill-in', () => onTabUpdated(id, change, tab));
  });
  browser.tabs.onMoved.addListener(() => scheduleSnapshot());
  browser.tabs.onAttached.addListener(() => scheduleSnapshot());
  browser.windows.onRemoved.addListener((windowId) => {
    safely('window names', async () => {
      const names = await windowNames.get();
      if (names[windowId]) await windowNames.set(windowId, '');
    });
  });

  safely('startup', ensureStartup);
  safely('alarms', ensureAlarms);
  // A restore or a fold runs inside one worker life; a fresh worker means any recorded one is over.
  safely('restore state', () => activeRestore.set(null));
  safely('fold state', forgetUnfinishedFold);
  // Chrome sync of folded tabs: listeners now, and a first run shortly after start.
  setupSync();
}
