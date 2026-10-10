import { browser } from 'wxt/browser';
import { db } from '../db';
import { extUrl } from '../extUrl';
import { countNamedSessions, pruneSnapshots, purgeTrash } from '../repo';
import { getSettings } from '../settings';
import { backup, getDeviceId, windowNames } from '../state';
import type { Command } from '../messages';
import { createMenus, onCommand, onMenuClicked } from './menus';
import { route } from './router';
import { checkRecovery, promoteShutdownSnapshot, scheduleSnapshot, takeSnapshot } from './snapshots';
import { autoSuspendTick } from './suspend';

/**
 * The service worker. It keeps no state in memory between wake-ups: everything lives in
 * IndexedDB or extension storage, and every scheduled job uses chrome.alarms.
 * All listeners are registered synchronously at the top level, exactly once.
 */

const ALARMS = {
  snapshot: { name: 'tabfold-snapshot', periodInMinutes: 5 },
  autoSuspend: { name: 'tabfold-auto-suspend', periodInMinutes: 1 },
  daily: { name: 'tabfold-daily', periodInMinutes: 24 * 60 },
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
  const settings = await getSettings();
  if (!settings.backupReminder) return;
  const stored = await browser.storage.local.get(INSTALLED_AT);
  const since = (await backup.lastAt()) ?? (stored[INSTALLED_AT] as number | undefined) ?? Date.now();
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
      await ensureStartup();
      await takeSnapshot('timer');
    });
  });

  browser.runtime.onStartup.addListener(() => {
    safely('startup', async () => {
      await ensureStartup();
      await ensureAlarms();
    });
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !(message as { __tabfold?: boolean }).__tabfold) return false;
    route((message as { command: Command }).command).then(sendResponse);
    return true;
  });

  browser.contextMenus.onClicked.addListener((info, tab) => safely('menu', () => onMenuClicked(info, tab)));
  browser.commands.onCommand.addListener((command, tab) => safely('shortcut', () => onCommand(command, tab)));

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARMS.snapshot.name) {
      safely('snapshot', async () => {
        await ensureStartup();
        await takeSnapshot('timer');
      });
    }
    else if (alarm.name === ALARMS.autoSuspend.name) safely('auto-suspend', () => autoSuspendTick());
    else if (alarm.name === ALARMS.daily.name) safely('daily', dailyMaintenance);
  });

  // Snapshots follow tab changes, debounced. Events fired while a window is closing are ignored so a
  // quitting browser never overwrites the last good snapshot with an empty one.
  browser.tabs.onCreated.addListener(() => scheduleSnapshot());
  browser.tabs.onRemoved.addListener((_id, info) => {
    if (!info.isWindowClosing) scheduleSnapshot();
  });
  browser.tabs.onUpdated.addListener((_id, change) => {
    if (change.url || change.pinned !== undefined || change.groupId !== undefined) scheduleSnapshot();
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
}
