import { browser } from 'wxt/browser';
import type { TabLike } from '../capture';
import { estimateBytes } from '../format';
import type { KeptAwakeReason, SuspendOutcome, TabRef } from '../messages';
import { getSettings, hostMatchesDomain, type Settings } from '../settings';
import { classifyUrl, displayHost } from '../urls';

/**
 * Suspending uses Chrome's own tab discarding: the tab stays in its place with its real address
 * and reloads when clicked. Nothing is lost if Tabfold is removed or updated.
 */

export type SuspendDecision = 'suspend' | 'active' | 'pinned' | 'audible' | 'protectedSite' | 'already' | 'not-web' | 'recent';

export function suspendDecision(
  tab: TabLike,
  settings: Pick<Settings, 'neverSuspendPinned' | 'neverSuspendAudible' | 'neverSuspendDomains'>,
  idleBefore?: number,
): SuspendDecision {
  const url = tab.url || tab.pendingUrl || '';
  if (tab.discarded) return 'already';
  if (tab.active) return 'active';
  if (classifyUrl(url) !== 'web') return 'not-web';
  if (tab.pinned && settings.neverSuspendPinned) return 'pinned';
  if (tab.audible && settings.neverSuspendAudible) return 'audible';
  const host = displayHost(url);
  if (settings.neverSuspendDomains.some((domain) => hostMatchesDomain(host, domain))) return 'protectedSite';
  if (idleBefore !== undefined && (tab.lastAccessed === undefined || tab.lastAccessed > idleBefore)) return 'recent';
  return 'suspend';
}

function emptyOutcome(): SuspendOutcome {
  return { suspended: 0, skipped: { active: 0, pinned: 0, audible: 0, protectedSite: 0, already: 0, failed: 0 }, freedBytes: 0, keptAwake: [] };
}

function keptAwake(tab: TabLike, reason: KeptAwakeReason): TabRef & { reason: KeptAwakeReason } {
  const url = tab.url || tab.pendingUrl || '';
  return { tabId: tab.id ?? -1, windowId: tab.windowId ?? -1, title: tab.title?.trim() || displayHost(url) || url, url, reason };
}

async function discardTabs(tabs: TabLike[], idleBefore?: number): Promise<SuspendOutcome> {
  const settings = await getSettings();
  const outcome = emptyOutcome();
  for (const tab of tabs) {
    if (tab.incognito || tab.id === undefined) continue;
    const decision = suspendDecision(tab, settings, idleBefore);
    if (decision === 'suspend') {
      try {
        await browser.tabs.discard(tab.id);
        outcome.suspended += 1;
      } catch {
        // Chrome refuses some tabs (for example ones it is about to show); skip and report.
        outcome.skipped.failed += 1;
        outcome.keptAwake.push(keptAwake(tab, 'failed'));
      }
    } else if (decision !== 'not-web' && decision !== 'recent') {
      outcome.skipped[decision] += 1;
      // Tabs Chrome already unloaded are left alone and not shown, nor are active pages that aren't
      // web pages (a New Tab, the Tabfold library): those could never be suspended anyway.
      const web = classifyUrl(tab.url || tab.pendingUrl || '') === 'web';
      if (decision !== 'already' && (decision !== 'active' || web)) outcome.keptAwake.push(keptAwake(tab, decision));
    }
  }
  outcome.freedBytes = estimateBytes(outcome.suspended);
  return outcome;
}

export async function suspendInactive(windowId?: number): Promise<SuspendOutcome> {
  const tabs = await browser.tabs.query(windowId !== undefined ? { windowId } : { windowType: 'normal' });
  return discardTabs(tabs);
}

export async function suspendTab(tabId: number): Promise<SuspendOutcome> {
  const tab = await browser.tabs.get(tabId);
  // Suspending one tab by hand ignores the protected-site list; the active tab still can't be.
  const outcome = emptyOutcome();
  if (tab.active) {
    outcome.skipped.active = 1;
    outcome.keptAwake.push(keptAwake(tab, 'active'));
    return outcome;
  }
  if (tab.discarded) {
    outcome.skipped.already = 1;
    return outcome;
  }
  try {
    await browser.tabs.discard(tabId);
    outcome.suspended = 1;
    outcome.freedBytes = estimateBytes(1);
  } catch {
    outcome.skipped.failed = 1;
    outcome.keptAwake.push(keptAwake(tab, 'failed'));
  }
  return outcome;
}

/**
 * Runs from a 1-minute alarm. Uses each tab's last-accessed time, so a laptop waking from sleep
 * runs the missed work once instead of many times.
 */
export async function autoSuspendTick(now = Date.now()): Promise<void> {
  const settings = await getSettings();
  if (!settings.autoSuspend) return;
  const idleBefore = now - settings.autoSuspendMinutes * 60_000;
  const tabs = await browser.tabs.query({ windowType: 'normal', discarded: false });
  await discardTabs(tabs, idleBefore);
}
