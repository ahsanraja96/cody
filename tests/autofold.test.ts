import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { autoFoldTick, onTabActivated, resetAutomationRuntime, ruleLabel, runnableRules, timeRuleDue } from '@/lib/background/automation';
import { resetGroupsFlagCache } from '@/lib/background/browserState';
import { route } from '@/lib/background/router';
import { resetTitleCache } from '@/lib/background/titles';
import { db } from '@/lib/db';
import { planState } from '@/lib/pro/state';
import { FREE_PLAN } from '@/lib/pro/types';
import { updateSettings, type AutoFoldRule } from '@/lib/settings';
import { activeFold, autoFoldLast, autoFoldNotice, lastAction, liveFolders } from '@/lib/state';
import type { SessionRecord } from '@/lib/types';
import { FakeChrome } from './chrome';

vi.mock('@/lib/background/browserState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/background/browserState')>()),
  sleep: async () => undefined,
}));

let chrome: FakeChrome;

beforeEach(() => {
  chrome = new FakeChrome().install();
  resetTitleCache();
  resetGroupsFlagCache();
  resetAutomationRuntime();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const OWN = fakeBrowser.runtime.getURL('/');
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

function idle(days: number, extra: Partial<AutoFoldRule> = {}): AutoFoldRule {
  return { id: `idle-${days}`, enabled: true, when: { type: 'idle', days }, into: { type: 'site' }, createdAt: 0, ...extra };
}

function weekday(hour: number, minute = 0, extra: Partial<AutoFoldRule> = {}): AutoFoldRule {
  return { id: 'weekday', enabled: true, when: { type: 'time', hour, minute, weekdays: [1, 2, 3, 4, 5] }, into: { type: 'site' }, createdAt: 0, ...extra };
}

const pro = () => planState.set({ ...FREE_PLAN, tier: 'pro' });

describe('Fold automatically: tabs not looked at for N days', () => {
  it('folds old tabs quietly, by kind of site or into a folder, and says so with Undo', async () => {
    const now = Date.now();
    await db.folders.add({ id: 'readlater01', name: 'Read later', color: 'cyan', order: 0, createdAt: 1, updatedAt: 1, deletedAt: 0 });
    await updateSettings({ autoFold: [idle(3, { into: { type: 'folder', folderId: 'readlater01' } })] });
    const { tabIds } = chrome.openWindow(
      [
        { url: 'https://old.com', lastAccessed: now - 4 * DAY },
        { url: 'https://older.com', lastAccessed: now - 30 * DAY },
        { url: 'https://recent.com', lastAccessed: now - 2 * DAY },
        { url: 'https://active.com', lastAccessed: now - 9 * DAY, active: true },
      ],
      { focused: true },
    );
    expect(await autoFoldTick(now)).toBe(2);
    expect(chrome.webTabs().map((t) => t.url)).toEqual(['https://recent.com', 'https://active.com']);
    expect((await db.tabs.toArray()).map((t) => [t.url, t.folderId]).sort()).toEqual([
      ['https://old.com', 'readlater01'],
      ['https://older.com', 'readlater01'],
    ]);
    // Quiet: the popup shows no fold, but the notice has the Undo.
    expect(await activeFold.get()).toBeUndefined();
    const notice = (await autoFoldNotice.get())!;
    expect(notice).toMatchObject({ ruleId: 'idle-3', label: 'your 3-day rule', folded: 2, actionId: (await lastAction.get())!.id });
    expect(await autoFoldLast.get()).toEqual({ 'idle-3': { at: now, folded: 2 } });
    expect(tabIds).toHaveLength(4);

    // Nothing old left: nothing happens, and the last run stays as it was.
    expect(await autoFoldTick(now + 5 * MINUTE)).toBe(0);
    expect(await autoFoldLast.get()).toEqual({ 'idle-3': { at: now, folded: 2 } });
  });

  it('never folds pinned or playing tabs, the tab you’re looking at, Tabfold’s pages, Incognito or a live folder’s group', async () => {
    const old = Date.now() - 10 * DAY;
    await pro();
    await updateSettings({ autoFold: [idle(1)] });
    await liveFolders.set({ f1: { folderId: 'f1', groupId: 77, windowId: 1, openedAt: 1 } });
    chrome.openWindow(
      [
        { url: 'https://pinned.com', pinned: true, lastAccessed: old },
        { url: 'https://music.com', audible: true, lastAccessed: old },
        { url: 'https://looking.com', active: true, lastAccessed: old },
        { url: `${OWN}library.html`, lastAccessed: old },
        { url: 'chrome://newtab/', lastAccessed: old },
        { url: 'https://live.com', groupId: 77, lastAccessed: old },
        { url: 'https://gone.com', lastAccessed: old },
      ],
      { focused: true },
    );
    // The active tab of a window you're not in can go.
    chrome.openWindow([{ url: 'https://background.com', active: true, lastAccessed: old }]);
    chrome.openWindow([{ url: 'https://private.com', lastAccessed: old }], { incognito: true });
    await autoFoldTick();
    expect((await db.tabs.toArray()).map((t) => t.url).sort()).toEqual(['https://background.com', 'https://gone.com']);
    expect(chrome.tabs.some((t) => t.url === 'https://private.com')).toBe(true);

    // With "Fold Incognito windows too", Incognito tabs can go as well.
    await updateSettings({ foldIncognito: true });
    await autoFoldTick();
    expect(chrome.tabs.some((t) => t.url === 'https://private.com')).toBe(false);
  });

  it('without tab.lastAccessed, a tab counts from when Tabfold first saw it (or saw it activated)', async () => {
    const now = Date.now();
    await updateSettings({ autoFold: [idle(1)] });
    const { tabIds } = chrome.openWindow(['https://a.com', 'https://b.com', { url: 'https://here.com', active: true }], { focused: true });
    expect(await autoFoldTick(now)).toBe(0);
    await onTabActivated(tabIds[1]!, now + DAY);
    expect(await autoFoldTick(now + DAY + MINUTE)).toBe(1);
    expect(chrome.webTabs().map((t) => t.url)).toEqual(['https://b.com', 'https://here.com']);
  });

  it('Free runs only the first "not looked at" rule; paid plans run every rule', async () => {
    const now = local(12, 19);
    const rules = [weekday(18), idle(5, { enabled: false }), idle(3), idle(1, { id: 'second-idle' })];
    expect(runnableRules({ autoFold: rules }, true).map((r) => r.id)).toEqual(['idle-3']);
    expect(runnableRules({ autoFold: rules }, false).map((r) => r.id)).toEqual(['weekday', 'idle-3', 'second-idle']);
    // 1.0: Free's one rule may also be "a window has more than N tabs", when it comes first.
    const cap: AutoFoldRule = { id: 'cap', enabled: true, when: { type: 'window-cap', max: 25 }, into: { type: 'site' }, createdAt: 0 };
    expect(runnableRules({ autoFold: [weekday(18), cap, idle(3)] }, true).map((r) => r.id)).toEqual(['cap']);
    expect(runnableRules({ autoFold: [idle(3), cap] }, true).map((r) => r.id)).toEqual(['idle-3']);
    expect(runnableRules({ autoFold: [{ ...cap, when: { type: 'window-cap', max: 1 } }] }, true)).toEqual([]);

    await updateSettings({ autoFold: rules });
    chrome.openWindow([{ url: 'https://two-days.com', lastAccessed: now - 2 * DAY }, { url: 'https://fresh.com', lastAccessed: now }], { focused: true });
    expect(await autoFoldTick(now)).toBe(0);
    expect(chrome.webTabs()).toHaveLength(2);

    await pro();
    // The weekday rule folds everything that may go (the 1-day rule had nothing left after it).
    expect(await autoFoldTick(now)).toBe(2);
    expect((await autoFoldNotice.get())!.label).toBe('your weekday rule');
  });
});

describe('Fold automatically: every weekday at a time', () => {
  it('runs once a matching day, after its time; not before, not twice, not at weekends', () => {
    const rule = weekday(18);
    expect(timeRuleDue(rule, undefined, local(12, 17, 59))).toBe(false);
    expect(timeRuleDue(rule, undefined, local(12, 18))).toBe(true);
    // Chrome was closed at 18:00: it runs when the computer is back the same evening.
    expect(timeRuleDue(rule, undefined, local(12, 23))).toBe(true);
    expect(timeRuleDue(rule, local(12, 18, 5), local(12, 22))).toBe(false);
    expect(timeRuleDue(rule, local(12, 18, 5), local(13, 18, 1))).toBe(true);
    expect(timeRuleDue(rule, undefined, local(17, 19))).toBe(false);
    // Made after today's time: it starts tomorrow.
    expect(timeRuleDue(weekday(18, 0, { createdAt: local(12, 18, 30) }), undefined, local(12, 19))).toBe(false);
  });

  it('folds everything open as one fold, and remembers the run even when nothing was open', async () => {
    await pro();
    await updateSettings({ autoFold: [weekday(18)] });
    chrome.openWindow([{ url: 'https://a.com', active: true }, 'https://b.com', { url: 'https://pinned.com', pinned: true }], { focused: true });
    chrome.openWindow(['https://c.com']);
    expect(await autoFoldTick(local(12, 17))).toBe(0);
    expect(await autoFoldTick(local(12, 18, 2))).toBe(2);
    expect(new Set((await db.tabs.toArray()).map((t) => t.sessionId)).size).toBe(1);
    expect(await autoFoldTick(local(12, 18, 7))).toBe(0);
    expect((await autoFoldLast.get()).weekday).toEqual({ at: local(12, 18, 2), folded: 2 });

    // The next day, with nothing foldable: the run still counts for the day.
    chrome.tabs = chrome.tabs.filter((t) => t.pinned || t.active);
    expect(await autoFoldTick(local(13, 18, 1))).toBe(0);
    expect((await autoFoldLast.get()).weekday).toEqual({ at: local(13, 18, 1), folded: 0 });
  });

  it('labels rules for the notice', () => {
    expect(ruleLabel(weekday(18))).toBe('your weekday rule');
    expect(ruleLabel({ ...weekday(9), when: { type: 'time', hour: 9, minute: 0, weekdays: [6, 0] } })).toBe('your weekend rule');
    expect(ruleLabel({ ...weekday(9), when: { type: 'time', hour: 9, minute: 5, weekdays: [1] } })).toBe('your 9:05 rule');
    expect(ruleLabel(idle(3))).toBe('your 3-day rule');
    expect(ruleLabel({ ...idle(1), when: { type: 'site-idle', hosts: ['youtube.com'], minutes: 60 } })).toBe('your youtube.com rule');
  });
});

describe('Fold automatically: sites', () => {
  it('folds only those sites’ tabs after the minutes given', async () => {
    const now = Date.now();
    await pro();
    await updateSettings({
      autoFold: [{ id: 'yt', enabled: true, when: { type: 'site-idle', hosts: ['youtube.com'], minutes: 60 }, into: { type: 'site' }, createdAt: 0 }],
    });
    chrome.openWindow(
      [
        { url: 'https://www.youtube.com/watch?v=1', lastAccessed: now - 2 * 60 * MINUTE },
        { url: 'https://m.youtube.com/watch?v=2', lastAccessed: now - 10 * MINUTE },
        { url: 'https://example.com', lastAccessed: now - 5 * DAY },
      ],
      { focused: true },
    );
    expect(await autoFoldTick(now)).toBe(1);
    expect((await db.tabs.toArray()).map((t) => t.url)).toEqual(['https://www.youtube.com/watch?v=1']);
  });
});

describe('Fold automatically on a full free list', () => {
  async function fullList() {
    const now = Date.now();
    await db.sessions.add({ id: 'full', name: 'Full', tags: [], pinned: 0, color: null, kind: 'session', source: 'save-all', createdAt: now, updatedAt: now, deletedAt: 0, deviceId: 'd', version: 1, tabCount: 500, windowCount: 1, preview: [] } satisfies SessionRecord);
  }

  it('skips, closes nothing, and tells open pages (at most hourly)', async () => {
    await fullList();
    const now = Date.now();
    await updateSettings({ autoFold: [idle(1)] });
    chrome.openWindow([{ url: 'https://old.com', lastAccessed: now - 3 * DAY }, { url: 'https://here.com', active: true }], { focused: true });
    expect(await autoFoldTick(now)).toBe(0);
    expect(await autoFoldTick(now + 5 * MINUTE)).toBe(0);
    expect(chrome.webTabs()).toHaveLength(2);
    expect(chrome.events('limit-hit')).toEqual([{ type: 'limit-hit', code: 'list-full' }]);
    expect(await autoFoldNotice.get()).toBeUndefined();
  });

  it('"Run now" says why to the page that asked', async () => {
    await fullList();
    await updateSettings({ autoFold: [idle(1)] });
    chrome.openWindow([{ url: 'https://old.com', lastAccessed: Date.now() - 3 * DAY }, { url: 'https://here.com', active: true }], { focused: true });
    expect(await route({ type: 'autofold-run', ruleId: 'idle-1' })).toMatchObject({ ok: false, code: 'list-full' });
  });
});

describe('autofold-run', () => {
  it('runs one rule now; on Free, rules with times or sites need Pro', async () => {
    await updateSettings({ autoFold: [weekday(23, 59), idle(2)] });
    chrome.openWindow([{ url: 'https://old.com', lastAccessed: Date.now() - 3 * DAY }, { url: 'https://here.com', active: true }], { focused: true });
    expect(await route({ type: 'autofold-run', ruleId: 'weekday' })).toMatchObject({ ok: false, code: 'needs-pro' });
    expect(await route({ type: 'autofold-run', ruleId: 'idle-2' })).toEqual({ ok: true, data: { folded: 1 } });
    expect(await route({ type: 'autofold-run', ruleId: 'nope' })).toMatchObject({ ok: false, code: 'not-found' });
    await pro();
    expect(await route({ type: 'autofold-run', ruleId: 'weekday' })).toEqual({ ok: true, data: { folded: 0 } });
  });
});
