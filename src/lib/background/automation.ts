import { browser, type Browser } from 'wxt/browser';
import { rawTabUrl } from '../capture';
import { db } from '../db';
import { FREE_LIMITS } from '../limits';
import { CommandError, type Command, type CommandResults, type WorkerEvent } from '../messages';
import { ProError } from '../pro/api';
import { removeTabs } from '../repo';
import { getSettings, hostMatchesDomain, type AutoFoldRule, type Settings } from '../settings';
import {
  autoFoldLast,
  autoFoldNotice,
  getDeviceId,
  lastAction,
  liveFolders,
  recoveryOffer,
  snoozeBack,
  type LastAction,
  type SnoozeBack,
} from '../state';
import { isTeamSession } from '../teams';
import type { TabRecord } from '../types';
import { classifyUrl, displayHost } from '../urls';
import { broadcast, currentNormalWindowId, getNormalWindows, incognitoAllowed, ownOrigin, setAttentionBadge } from './browserState';
import { foldTabs, handleFold } from './fold';
import { refuseToOpen } from './restorePlan';
import { freeLimitsNow, limitCode } from './room';
import { recordChangeUndo } from './save';

/**
 * Snooze and Fold automatically (Mx-Auto board).
 *
 * Snooze: a folded tab gets `snoozeUntil` and `snoozedOn` (this computer); an open tab is folded
 * first. One alarm wakes at the earliest snooze this computer made: the tabs reopen in the
 * background in the last window you used, leave the list, and the toolbar icon counts them until
 * a page shows them (`snooze-seen`). Tabs snoozed on another computer are only shown here.
 *
 * Fold automatically: every 5 minutes the rules in Settings run (Free: the first "not looked at for
 * N days" rule only). Pinned and playing tabs, the tab you're looking at, Tabfold's own pages,
 * Incognito (unless folding it is on) and live folders' groups always stay.
 */

export type AutomationCommand = Extract<Command, { type: 'snooze' | 'snooze-wake' | 'snooze-seen' | 'autofold-run' }>;
type SnoozeCommand = Extract<Command, { type: 'snooze' }>;

export const SNOOZE_ALARM = 'tabfold-snooze';
export const AUTOFOLD_ALARM = 'tabfold-autofold';
export const AUTOFOLD_MINUTES = 5;
/** The toolbar number for tabs that came back (the accent colour). */
export const SNOOZE_BADGE_COLOR = '#4F5BD5';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export async function handleAutomationCommand(command: AutomationCommand): Promise<CommandResults[AutomationCommand['type']]> {
  switch (command.type) {
    case 'snooze':
      return snooze(command);
    case 'snooze-wake':
      return wakeNow(command.tabRecordIds);
    case 'snooze-seen':
      await snoozeSeen();
      return { ok: true };
    case 'autofold-run':
      return { folded: await runRuleNow(command.ruleId) };
  }
}

// ---------------------------------------------------------------------------------------------
// Snooze

/** Snoozed tabs in live folds, from every computer. */
export async function snoozedTabs(): Promise<TabRecord[]> {
  const rows = await db.tabs.where('snoozeUntil').above(0).toArray();
  if (rows.length === 0) return [];
  const sessions = await db.sessions.bulkGet([...new Set(rows.map((r) => r.sessionId))]);
  const live = new Set(sessions.filter((s) => !!s && !s.deletedAt).map((s) => s!.id));
  return rows.filter((r) => live.has(r.sessionId));
}

function snoozeLimitError(): CommandError {
  const limit = FREE_LIMITS.snoozes;
  return new CommandError(`Free has ${limit} snoozed tabs at a time. Wake one, or upgrade to snooze as many as you like.`, 'snooze-limit', {
    limit,
  });
}

const before = (t: TabRecord): NonNullable<LastAction['patches']>[number] => ({
  id: t.id,
  before: { folderId: t.folderId, snoozeUntil: t.snoozeUntil, snoozedOn: t.snoozedOn },
});

/**
 * Snooze folded tabs (`tabRecordIds`), or fold open tabs and snooze them (`tabIds`). Free has 3
 * snoozed tabs at a time (`snooze-limit`); folding open tabs also needs room in the free list
 * (`list-full`). Undo with the action id.
 */
export async function snooze(command: Pick<SnoozeCommand, 'until' | 'tabRecordIds' | 'tabIds'>, now = Date.now()): Promise<{ snoozed: number; actionId: string | null }> {
  const until = command.until;
  if (!Number.isFinite(until) || until <= now) throw new CommandError('Pick a time later than now.', 'invalid-time');
  const deviceId = await getDeviceId();
  const free = await freeLimitsNow();
  const already = free ? new Set((await snoozedTabs()).map((t) => t.id)) : new Set<string>();
  const marks = { snoozeUntil: until, snoozedOn: deviceId };

  if (command.tabIds?.length) {
    if (free && already.size + command.tabIds.length > FREE_LIMITS.snoozes) throw snoozeLimitError();
    const run = await foldTabs({ tabIds: command.tabIds, quiet: true });
    // A copy already in a team folder stays as it is for the team.
    const teamFolds = new Set(
      (await db.sessions.bulkGet([...new Set(run.existingCopies.map((c) => c.sessionId))])).filter((s) => isTeamSession(s)).map((s) => s!.id),
    );
    const copies = run.existingCopies.filter((c) => !teamFolds.has(c.sessionId));
    const patches = copies.map(before);
    await db.transaction('rw', db.tabs, async () => {
      if (run.savedTabIds.length) await db.tabs.where('id').anyOf(run.savedTabIds).modify(marks);
      for (const copy of copies) await db.tabs.update(copy.id, marks);
    });
    // Undo of the fold also un-snoozes the copies that were already folded.
    const actionId = run.outcome.actionId;
    if (actionId && patches.length) {
      const action = await lastAction.get();
      if (action?.id === actionId) await lastAction.set({ ...action, patches: [...(action.patches ?? []), ...patches] });
    }
    await scheduleSnoozeAlarm(now);
    return { snoozed: run.savedTabIds.length + copies.length, actionId };
  }

  const ids = [...new Set(command.tabRecordIds ?? [])];
  const rows = (await db.tabs.bulkGet(ids)).filter((t): t is TabRecord => !!t);
  const sessions = await db.sessions.bulkGet([...new Set(rows.map((r) => r.sessionId))]);
  // A team's tabs are everyone's: snoozing one would hide it from the whole team.
  const live = new Set(sessions.filter((s) => !!s && !s.deletedAt && !isTeamSession(s)).map((s) => s!.id));
  const tabs = rows.filter((r) => live.has(r.sessionId));
  if (tabs.length === 0) return { snoozed: 0, actionId: null };
  if (free && already.size + tabs.filter((t) => !already.has(t.id)).length > FREE_LIMITS.snoozes) throw snoozeLimitError();
  await db.transaction('rw', db.tabs, async () => {
    for (const tab of tabs) await db.tabs.update(tab.id, marks);
  });
  const actionId = await recordChangeUndo({ patches: tabs.map(before), now });
  await scheduleSnoozeAlarm(now);
  return { snoozed: tabs.length, actionId };
}

/**
 * The one snooze alarm, at the earliest snooze this computer made (tabs snoozed on another
 * computer are woken there). Cleared when there's none. Returns that time.
 */
export async function scheduleSnoozeAlarm(now = Date.now()): Promise<number | null> {
  const deviceId = await getDeviceId();
  const next = (await snoozedTabs())
    .filter((t) => t.snoozedOn === deviceId)
    .reduce((min, t) => Math.min(min, t.snoozeUntil!), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(next)) {
    await browser.alarms.clear(SNOOZE_ALARM).catch(() => undefined);
    return null;
  }
  // Due already (Chrome was closed at the time): as soon as Chrome allows.
  await browser.alarms.create(SNOOZE_ALARM, { when: Math.max(next, now + 1000) });
  return next;
}

/**
 * Open folded tabs again in the background, in the last window you used (a new one if none is
 * open; Incognito tabs only in Incognito), and take them out of the list. Tabs that can't open stay
 * folded, no longer snoozed. Returns the ones that opened.
 */
async function reopen(rows: TabRecord[]): Promise<TabRecord[]> {
  const origin = ownOrigin();
  const opened: TabRecord[] = [];
  const failed: TabRecord[] = [];
  for (const incognito of [false, true]) {
    const group = rows.filter((r) => !!r.incognito === incognito);
    if (group.length === 0) continue;
    if (incognito && !(await incognitoAllowed())) {
      failed.push(...group);
      continue;
    }
    let windowId = await currentNormalWindowId(incognito);
    let placeholder: number | undefined;
    if (windowId === undefined) {
      const created = await browser.windows.create({ focused: false, incognito }).catch(() => undefined);
      windowId = created?.id;
      placeholder = created?.tabs?.[0]?.id;
    }
    let here = 0;
    for (const row of group) {
      if (windowId === undefined || refuseToOpen(row.url, origin)) {
        failed.push(row);
        continue;
      }
      try {
        await browser.tabs.create({ windowId, url: row.url, active: false });
        opened.push(row);
        here += 1;
      } catch {
        failed.push(row);
      }
    }
    if (placeholder !== undefined && here > 0) await browser.tabs.remove(placeholder).catch(() => undefined);
  }
  if (opened.length) await removeTabs(opened.map((r) => r.id));
  if (failed.length) {
    await db.tabs
      .where('id')
      .anyOf(failed.map((r) => r.id))
      .modify((tab) => {
        delete tab.snoozeUntil;
        delete tab.snoozedOn;
      });
  }
  return opened;
}

async function setBadge(count: number): Promise<void> {
  try {
    if (count > 0) {
      await browser.action.setBadgeText({ text: String(Math.min(count, 99)) });
      await browser.action.setBadgeBackgroundColor({ color: SNOOZE_BADGE_COLOR });
    } else if (await recoveryOffer.get()) {
      // The recovery offer had the badge before.
      await setAttentionBadge(true);
    } else {
      await browser.action.setBadgeText({ text: '' });
    }
  } catch {
    // The badge is a nicety.
  }
}

/** The toolbar badge as it should be now: tabs that came back, if any. */
export async function refreshSnoozeBadge(): Promise<void> {
  const back = await snoozeBack.get();
  await setBadge(back?.tabRecordIds.length ?? 0);
}

/** The alarm: reopen this computer's snoozed tabs that are due, count them on the toolbar icon, and set the next alarm. */
export async function wakeDue(now = Date.now()): Promise<number> {
  const deviceId = await getDeviceId();
  const due = (await snoozedTabs()).filter((t) => t.snoozedOn === deviceId && t.snoozeUntil! <= now);
  let opened = 0;
  if (due.length) {
    const back = await reopen(due.sort((a, b) => a.snoozeUntil! - b.snoozeUntil!));
    opened = back.length;
    if (back.length) {
      const current = await snoozeBack.get();
      const next: SnoozeBack = {
        tabRecordIds: [...(current?.tabRecordIds ?? []), ...back.map((t) => t.id)],
        titles: [...(current?.titles ?? []), ...back.map((t) => t.title || displayHost(t.url))],
        at: now,
      };
      await snoozeBack.set(next);
      await setBadge(next.tabRecordIds.length);
    }
  }
  await scheduleSnoozeAlarm(now);
  return opened;
}

/** "Wake now": reopen these snoozed tabs at once (any computer's; the person asked here). */
export async function wakeNow(tabRecordIds: string[]): Promise<{ opened: number }> {
  const rows = (await db.tabs.bulkGet([...new Set(tabRecordIds)])).filter((t): t is TabRecord => !!t && !!t.snoozeUntil);
  const opened = rows.length ? await reopen(rows) : [];
  await scheduleSnoozeAlarm();
  return { opened: opened.length };
}

/** A page showed the tabs that came back: clear the toolbar number. */
export async function snoozeSeen(): Promise<void> {
  await snoozeBack.set(null);
  await setBadge(0);
}

/** "Zz" on the toolbar icon for a moment: the snooze shortcut's quiet confirmation. */
export async function flashSnoozed(ms = 1500): Promise<void> {
  try {
    await browser.action.setBadgeText({ text: 'Zz' });
    await browser.action.setBadgeBackgroundColor({ color: SNOOZE_BADGE_COLOR });
  } catch {
    return;
  }
  setTimeout(() => void refreshSnoozeBadge(), ms);
}

/** At worker start: the toolbar number again (it's gone after a browser restart), and the alarm (due ones fire at once). */
export async function setupSnooze(): Promise<void> {
  const back = await snoozeBack.get();
  if (back?.tabRecordIds.length) await setBadge(back.tabRecordIds.length);
  await scheduleSnoozeAlarm();
}

// ---------------------------------------------------------------------------------------------
// Fold automatically

/** "your weekday rule", "your 3-day rule", "your youtube.com rule" (the auto-fold notice). */
export function ruleLabel(rule: AutoFoldRule): string {
  const when = rule.when;
  if (when.type === 'idle') return `your ${when.days}-day rule`;
  if (when.type === 'site-idle') return when.hosts.length === 1 ? `your ${when.hosts[0]} rule` : 'your sites rule';
  const days = [...new Set(when.weekdays)].sort().join(',');
  if (days === '1,2,3,4,5') return 'your weekday rule';
  if (days === '0,6') return 'your weekend rule';
  if (days === '0,1,2,3,4,5,6') return 'your daily rule';
  return `your ${when.hour}:${String(when.minute).padStart(2, '0')} rule`;
}

function validRule(rule: AutoFoldRule): boolean {
  const when = rule.when;
  if (when.type === 'idle') return Number.isFinite(when.days) && when.days > 0;
  if (when.type === 'site-idle') return when.hosts.length > 0 && Number.isFinite(when.minutes) && when.minutes > 0;
  return Array.isArray(when.weekdays) && when.weekdays.length > 0 && Number.isFinite(when.hour) && Number.isFinite(when.minute);
}

/** The rules that run: every enabled one, or on Free only the first enabled "not looked at for N days" rule. */
export function runnableRules(settings: Pick<Settings, 'autoFold'>, free: boolean): AutoFoldRule[] {
  const enabled = (settings.autoFold ?? []).filter((r) => r.enabled && validRule(r));
  if (!free) return enabled;
  const first = enabled.find((r) => r.when.type === 'idle');
  return first ? [first] : [];
}

/** A time rule is due once a matching day, after its time, if it hasn't run since (nor was made since). */
export function timeRuleDue(rule: AutoFoldRule, lastAt: number | undefined, now: number): boolean {
  if (rule.when.type !== 'time') return true;
  const today = new Date(now);
  if (!rule.when.weekdays.includes(today.getDay())) return false;
  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), rule.when.hour, rule.when.minute).getTime();
  return now >= at && Math.max(lastAt ?? 0, rule.createdAt ?? 0) < at;
}

/**
 * When each tab was last looked at: Chrome's `lastAccessed` (Chrome 121+), else the time Tabfold
 * saw it activated (or first saw it), kept in session storage.
 */
const TAB_SEEN = 'autoFoldTabSeen';
let trackActivations = false;

/** tabs.onActivated: only needed (and only written) on a Chrome without `tab.lastAccessed`. */
export async function onTabActivated(tabId: number, now = Date.now()): Promise<void> {
  if (!trackActivations) return;
  const seen = ((await browser.storage.session.get(TAB_SEEN))[TAB_SEEN] as Record<string, number> | undefined) ?? {};
  seen[tabId] = now;
  await browser.storage.session.set({ [TAB_SEEN]: seen });
}

interface Foldable {
  tab: Browser.tabs.Tab;
  host: string;
  /** Last looked at (ms). */
  seen: number;
}

/** Open tabs a rule may fold, with when each was last looked at. */
async function foldableTabs(settings: Settings, now: number): Promise<Foldable[]> {
  const windows = await getNormalWindows();
  const incognito = settings.foldIncognito && (await incognitoAllowed());
  const liveGroups = new Set(Object.values(await liveFolders.get()).map((l) => l.groupId));
  const origin = ownOrigin();
  const tabs: Array<{ tab: Browser.tabs.Tab; url: string }> = [];
  for (const window of windows) {
    if (window.incognito && !incognito) continue;
    for (const tab of window.tabs ?? []) {
      if (tab.id === undefined || tab.pinned || tab.audible) continue;
      if (tab.active && window.focused) continue;
      if (tab.groupId !== undefined && tab.groupId >= 0 && liveGroups.has(tab.groupId)) continue;
      const url = rawTabUrl(tab);
      const kind = classifyUrl(url, origin);
      if (kind === 'own' || kind === 'blank') continue;
      tabs.push({ tab, url });
    }
  }
  let seen: Record<string, number> | undefined;
  if (tabs.some(({ tab }) => typeof tab.lastAccessed !== 'number')) {
    trackActivations = true;
    const stored = ((await browser.storage.session.get(TAB_SEEN))[TAB_SEEN] as Record<string, number> | undefined) ?? {};
    const open = new Set(tabs.map(({ tab }) => String(tab.id)));
    seen = Object.fromEntries(Object.entries(stored).filter(([id]) => open.has(id)));
    for (const { tab } of tabs) if (typeof tab.lastAccessed !== 'number' && !(String(tab.id) in seen)) seen[tab.id!] = now;
    await browser.storage.session.set({ [TAB_SEEN]: seen });
  }
  return tabs.map(({ tab, url }) => ({
    tab,
    host: displayHost(url).toLowerCase(),
    seen: typeof tab.lastAccessed === 'number' ? tab.lastAccessed : (seen?.[tab.id!] ?? now),
  }));
}

function pickForRule(rule: AutoFoldRule, tabs: Foldable[], now: number): Foldable[] {
  const when = rule.when;
  if (when.type === 'idle') return tabs.filter((t) => t.seen <= now - when.days * DAY);
  if (when.type === 'site-idle') {
    return tabs.filter((t) => t.seen <= now - when.minutes * MINUTE && when.hosts.some((h) => hostMatchesDomain(t.host, h.toLowerCase().replace(/^www\./, ''))));
  }
  return tabs;
}

/**
 * Run one rule now: fold its tabs (into a folder, or by kind of site) as one quiet fold, remember
 * when it ran, and leave the "Folded 23 tabs (your weekday rule) · Undo" notice. Returns how many
 * tabs it folded. A full free list throws `list-full` (nothing closes).
 */
async function runRule(rule: AutoFoldRule, settings: Settings, now: number): Promise<number> {
  const tabs = pickForRule(rule, await foldableTabs(settings, now), now);
  const mark = async (folded: number) => {
    const last = await autoFoldLast.get();
    await autoFoldLast.set({ ...last, [rule.id]: { at: now, folded } });
  };
  if (tabs.length === 0) {
    // A time rule ran today, even with nothing open; a "not looked at" rule only counts when it folds.
    if (rule.when.type === 'time') await mark(0);
    return 0;
  }
  const outcome = await handleFold({
    tabIds: tabs.map((t) => t.tab.id!),
    ...(rule.into.type === 'folder' ? { intoFolderId: rule.into.folderId } : {}),
    source: 'rule',
  });
  const folded = outcome.savedTabs + outcome.skippedDuplicates;
  await mark(folded);
  if (folded > 0) {
    await autoFoldNotice.set({ ruleId: rule.id, label: ruleLabel(rule), folded, freedBytes: outcome.freedBytes, at: Date.now(), actionId: outcome.actionId });
  }
  return folded;
}

/** `limit-hit` at most this often while a rule waits for room. */
const LIMIT_HIT_EVERY_MS = 60 * MINUTE;
let lastLimitHit = 0;

/** The 5-minute alarm: run the rules that are due. A full free list skips them (and tells open pages). */
export async function autoFoldTick(now = Date.now()): Promise<number> {
  const settings = await getSettings();
  if (!settings.autoFold?.length) return 0;
  const rules = runnableRules(settings, await freeLimitsNow());
  if (rules.length === 0) return 0;
  const last = await autoFoldLast.get();
  let folded = 0;
  for (const rule of rules) {
    if (!timeRuleDue(rule, last[rule.id]?.at, now)) continue;
    try {
      folded += await runRule(rule, settings, now);
    } catch (error) {
      const code = limitCode(error);
      if (!code) throw error;
      if (now - lastLimitHit >= LIMIT_HIT_EVERY_MS) {
        lastLimitHit = now;
        const event: WorkerEvent = { type: 'limit-hit', code };
        broadcast(event);
      }
    }
  }
  return folded;
}

/** For tests: forget the in-memory throttles. */
export function resetAutomationRuntime(): void {
  lastLimitHit = 0;
  trackActivations = false;
}

/** `autofold-run`: run one rule now, whatever its schedule. On Free only "not looked at for N days" rules run. */
async function runRuleNow(ruleId: string, now = Date.now()): Promise<number> {
  const settings = await getSettings();
  const rule = (settings.autoFold ?? []).find((r) => r.id === ruleId);
  if (!rule) throw new CommandError('This rule no longer exists.', 'not-found');
  if (rule.when.type !== 'idle' && (await freeLimitsNow())) throw new ProError('needs-pro', 'Rules with times and sites are part of Tabfold Pro.');
  if (!validRule(rule)) throw new CommandError('This rule isn’t complete. Edit it, then try again.', 'invalid-rule');
  return runRule(rule, settings, now);
}
