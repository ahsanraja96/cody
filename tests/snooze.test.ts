import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  scheduleSnoozeAlarm,
  setupSnooze,
  SNOOZE_ALARM,
  SNOOZE_BADGE_COLOR,
  snoozedTabs,
  wakeDue,
} from '@/lib/background/automation';
import { resetGroupsFlagCache } from '@/lib/background/browserState';
import { MENU, onCommand, onMenuClicked } from '@/lib/background/menus';
import { route } from '@/lib/background/router';
import { handleUndo } from '@/lib/background/save';
import { resetTitleCache } from '@/lib/background/titles';
import { db } from '@/lib/db';
import { planState } from '@/lib/pro/state';
import { FREE_PLAN } from '@/lib/pro/types';
import { saveCapture } from '@/lib/repo';
import { formatSnoozeTime, snoozeChoices, snoozeTime } from '@/lib/snooze';
import { activeFold, getDeviceId, lastAction, snoozeBack } from '@/lib/state';
import type { SessionRecord } from '@/lib/types';
import { FakeChrome } from './chrome';
import { capturedWindow } from './fixtures';

vi.mock('@/lib/background/browserState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/background/browserState')>()),
  sleep: async () => undefined,
}));

let chrome: FakeChrome;

beforeEach(() => {
  chrome = new FakeChrome().install();
  // The toolbar badge as the fake browser keeps it (FakeChrome silences it).
  vi.mocked(fakeBrowser.action.setBadgeText).mockRestore();
  vi.mocked(fakeBrowser.action.setBadgeBackgroundColor).mockRestore();
  resetTitleCache();
  resetGroupsFlagCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const HOUR = 60 * 60_000;
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

async function seed(urls: string[], deviceId = 'd') {
  const result = await saveCapture([capturedWindow(urls)], { name: 'Fold', source: 'save-all', deviceId, now: Date.now() }, { dedupe: false });
  return db.tabs.where('sessionId').equals(result.sessionId).sortBy('order');
}

const badge = () => fakeBrowser.action.getBadgeText({});

describe('snooze choices', () => {
  it('on a Monday morning: later today, tomorrow, Saturday, next Monday, the same day next month', () => {
    // Mon 12 Oct 2026, 10:00.
    const choices = snoozeChoices(local(12, 10));
    expect(choices.map((c) => [c.id, c.label, c.hint])).toEqual([
      ['later-today', 'Later today', '18:00'],
      ['tomorrow', 'Tomorrow morning', 'Tue 9:00'],
      ['weekend', 'This weekend', 'Sat 9:00'],
      ['next-week', 'Next week', 'Mon 9:00'],
      ['month', 'In a month', '12 Nov'],
    ]);
    expect(choices.map((c) => c.at)).toEqual([local(12, 18), local(13, 9), local(17, 9), local(19, 9), new Date(2026, 10, 12, 9).getTime()]);
  });

  it('no "Later today" after 17:00, Sunday for the weekend on a Saturday, none on a Sunday', () => {
    expect(snoozeChoices(local(12, 17, 30)).map((c) => c.id)).toEqual(['tomorrow', 'weekend', 'next-week', 'month']);
    const saturday = snoozeChoices(local(17, 8));
    expect(saturday.find((c) => c.id === 'weekend')!.at).toBe(local(18, 9));
    const sunday = snoozeChoices(local(18, 8));
    expect(sunday.map((c) => c.id)).toEqual(['later-today', 'tomorrow', 'next-week', 'month']);
    expect(sunday.find((c) => c.id === 'next-week')!.at).toBe(local(19, 9));
    // A choice that went away (an old menu) falls back to tomorrow morning.
    expect(snoozeTime('later-today', local(12, 20))).toBe(local(13, 9));
    // The 31st becomes the next month's last day.
    expect(snoozeChoices(new Date(2026, 0, 31, 10).getTime()).at(-1)!.at).toBe(new Date(2026, 1, 28, 9).getTime());
  });

  it('formats when a tab comes back', () => {
    const now = local(12, 10);
    expect(formatSnoozeTime(local(12, 18), now)).toBe('Today 18:00');
    expect(formatSnoozeTime(local(13, 9), now)).toBe('Tomorrow 9:00');
    expect(formatSnoozeTime(local(17, 9), now)).toBe('Sat 9:00');
    expect(formatSnoozeTime(new Date(2026, 10, 11, 9).getTime(), now)).toBe('11 Nov 9:00');
  });
});

describe('snooze', () => {
  it('snoozes folded tabs on this computer, sets the alarm at the earliest, and Undo un-snoozes', async () => {
    const [a, b] = await seed(['https://a.com', 'https://b.com']);
    const device = await getDeviceId();
    const now = Date.now();
    const result = await route({ type: 'snooze', until: now + 5 * HOUR, tabRecordIds: [a!.id] });
    expect(result).toEqual({ ok: true, data: { snoozed: 1, actionId: expect.any(String) } });
    await route({ type: 'snooze', until: now + 2 * HOUR, tabRecordIds: [b!.id] });
    expect(await db.tabs.get(a!.id)).toMatchObject({ snoozeUntil: now + 5 * HOUR, snoozedOn: device });
    expect((await fakeBrowser.alarms.get(SNOOZE_ALARM))?.scheduledTime).toBe(now + 2 * HOUR);

    const action = (await lastAction.get())!;
    expect(await handleUndo(action.id)).toEqual({ undone: true });
    const back = (await db.tabs.get(b!.id))!;
    expect('snoozeUntil' in back || 'snoozedOn' in back).toBe(false);
    expect((await scheduleSnoozeAlarm(now))).toBe(now + 5 * HOUR);
  });

  it('refuses a time in the past', async () => {
    const [a] = await seed(['https://a.com']);
    expect(await route({ type: 'snooze', until: Date.now() - 1000, tabRecordIds: [a!.id] })).toMatchObject({ ok: false, code: 'invalid-time' });
  });

  it('Free has 3 snoozed tabs at a time (any computer’s); snoozing one again is fine; paid plans have no limit', async () => {
    const tabs = await seed(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com']);
    const until = Date.now() + HOUR;
    await route({ type: 'snooze', until, tabRecordIds: tabs.slice(0, 2).map((t) => t.id) });
    await db.tabs.update(tabs[2]!.id, { snoozeUntil: until, snoozedOn: 'other-computer' });
    expect(await route({ type: 'snooze', until: until + HOUR, tabRecordIds: [tabs[0]!.id] })).toMatchObject({ ok: true });
    expect(await route({ type: 'snooze', until, tabRecordIds: [tabs[3]!.id] })).toEqual({
      ok: false,
      error: 'Free has 3 snoozed tabs at a time. Wake one, or upgrade to snooze as many as you like.',
      code: 'snooze-limit',
      details: { limit: 3 },
    });
    // Open tabs count before anything folds.
    const { tabIds } = chrome.openWindow(['https://open.com', 'https://x.com'], { focused: true });
    expect(await route({ type: 'snooze', until, tabIds: [tabIds[0]!] })).toMatchObject({ ok: false, code: 'snooze-limit' });
    expect(chrome.tab(tabIds[0]!)).toBeDefined();

    await planState.set({ ...FREE_PLAN, tier: 'pro' });
    expect(await route({ type: 'snooze', until, tabRecordIds: [tabs[3]!.id] })).toMatchObject({ ok: true, data: { snoozed: 1 } });
  });

  it('an open tab folds quietly and is snoozed; Undo reopens it', async () => {
    const { tabIds } = chrome.openWindow(['https://a.com', { url: 'https://b.com', active: true }], { focused: true });
    const until = Date.now() + HOUR;
    const result = await route({ type: 'snooze', until, tabIds: [tabIds[1]!] });
    expect(result).toMatchObject({ ok: true, data: { snoozed: 1 } });
    expect(chrome.tab(tabIds[1]!)).toBeUndefined();
    const [row] = await db.tabs.toArray();
    expect(row).toMatchObject({ url: 'https://b.com', snoozeUntil: until, snoozedOn: await getDeviceId() });
    expect(await activeFold.get()).toBeUndefined();

    await handleUndo((result as { data: { actionId: string } }).data.actionId);
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://a.com', 'https://b.com']);
    expect(await db.tabs.count()).toBe(0);
  });

  it('an open tab already folded closes, and its copy is snoozed (Undo un-snoozes it)', async () => {
    const [copy] = await seed(['https://a.com']);
    const { tabIds } = chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    const result = await route({ type: 'snooze', until: Date.now() + HOUR, tabIds: [tabIds[0]!] });
    expect(result).toMatchObject({ ok: true, data: { snoozed: 1 } });
    expect((await db.tabs.get(copy!.id))!.snoozeUntil).toBeGreaterThan(Date.now());
    await handleUndo((result as { data: { actionId: string } }).data.actionId);
    expect((await db.tabs.get(copy!.id))!.snoozeUntil).toBeUndefined();
  });

  it('snoozing an open tab needs room in the free list', async () => {
    const now = Date.now();
    await db.sessions.add({ id: 'full', name: 'Full', tags: [], pinned: 0, color: null, kind: 'session', source: 'save-all', createdAt: now, updatedAt: now, deletedAt: 0, deviceId: 'd', version: 1, tabCount: 500, windowCount: 1, preview: [] } satisfies SessionRecord);
    const { tabIds } = chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    expect(await route({ type: 'snooze', until: now + HOUR, tabIds: [tabIds[0]!] })).toMatchObject({ ok: false, code: 'list-full' });
    expect(chrome.tab(tabIds[0]!)).toBeDefined();
  });
});

describe('waking snoozed tabs', () => {
  it('reopens due tabs in the background in the last window used, takes them out of the list and counts them on the icon', async () => {
    const here = chrome.openWindow([{ url: 'https://work.com', active: true }], { focused: true });
    chrome.openWindow(['https://elsewhere.com']);
    const [a, b, c, d] = await seed(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com']);
    const device = await getDeviceId();
    const now = Date.now();
    await db.tabs.update(a!.id, { snoozeUntil: now - 1000, snoozedOn: device, title: 'Stripe pricing' });
    await db.tabs.update(b!.id, { snoozeUntil: now - 500, snoozedOn: device });
    await db.tabs.update(c!.id, { snoozeUntil: now + HOUR, snoozedOn: device });
    // Snoozed on another computer: only shown here, never woken.
    await db.tabs.update(d!.id, { snoozeUntil: now - 1000, snoozedOn: 'other-computer' });

    expect(await wakeDue(now)).toBe(2);
    const opened = chrome.tabs.filter((t) => t.url === 'https://a.com' || t.url === 'https://b.com');
    expect(opened.every((t) => t.windowId === here.windowId && !t.active)).toBe(true);
    expect(chrome.tab(here.tabIds[0]!)!.active).toBe(true);
    expect(await db.tabs.bulkGet([a!.id, b!.id])).toEqual([undefined, undefined]);
    expect((await snoozedTabs()).map((t) => t.id).sort()).toEqual([c!.id, d!.id].sort());
    expect(await snoozeBack.get()).toEqual({ tabRecordIds: [a!.id, b!.id], titles: ['Stripe pricing', 'Title of https://b.com'], at: now });
    expect(await badge()).toBe('2');
    expect(await fakeBrowser.action.getBadgeBackgroundColor({})).toEqual([0x4f, 0x5b, 0xd5, 255]);
    expect(SNOOZE_BADGE_COLOR).toBe('#4F5BD5');
    // The next alarm: the one still snoozed here.
    expect((await fakeBrowser.alarms.get(SNOOZE_ALARM))?.scheduledTime).toBe(now + HOUR);

    // More come back later: the number adds up until a page shows them.
    await db.tabs.update(c!.id, { snoozeUntil: now + 10 });
    await wakeDue(now + 20);
    expect(await badge()).toBe('3');
    expect(await route({ type: 'snooze-seen' })).toEqual({ ok: true, data: { ok: true } });
    expect(await snoozeBack.get()).toBeUndefined();
    expect(await badge()).toBe('');
    expect(await fakeBrowser.alarms.get(SNOOZE_ALARM)).toBeUndefined();
  });

  it('with no window open, they come back in a new one; a tab that can’t open stays folded, no longer snoozed', async () => {
    const device = await getDeviceId();
    const [a, b] = await seed(['https://a.com', 'javascript:alert(1)']);
    await db.tabs.where('id').anyOf([a!.id, b!.id]).modify({ snoozeUntil: 1, snoozedOn: device });
    expect(await wakeDue()).toBe(1);
    expect(chrome.windows).toHaveLength(1);
    expect(chrome.tabs.map((t) => t.url)).toEqual(['https://a.com']);
    const stays = (await db.tabs.get(b!.id))!;
    expect(stays.snoozeUntil).toBeUndefined();
  });

  it('"Wake now" opens them at once, any computer’s', async () => {
    chrome.openWindow(['https://work.com'], { focused: true });
    const [a] = await seed(['https://a.com']);
    await db.tabs.update(a!.id, { snoozeUntil: Date.now() + HOUR, snoozedOn: 'other-computer' });
    expect(await route({ type: 'snooze-wake', tabRecordIds: [a!.id] })).toEqual({ ok: true, data: { opened: 1 } });
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://a.com', 'https://work.com']);
    expect(await snoozeBack.get()).toBeUndefined();
  });

  it('after a restart: the icon’s number comes back, and tabs due while Chrome was closed come back now', async () => {
    const device = await getDeviceId();
    const [a] = await seed(['https://a.com']);
    await db.tabs.update(a!.id, { snoozeUntil: Date.now() - 3 * HOUR, snoozedOn: device });
    await snoozeBack.set({ tabRecordIds: ['x', 'y'], titles: ['X', 'Y'], at: 1 });
    await setupSnooze();
    expect(await badge()).toBe('2');
    const alarm = await fakeBrowser.alarms.get(SNOOZE_ALARM);
    expect(alarm!.scheduledTime).toBeGreaterThan(Date.now() - 1000);
    expect(alarm!.scheduledTime).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('snoozing from a page’s menu and the shortcut', () => {
  it('right-click › Snooze this tab › Next week folds it until Monday 9:00', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(local(12, 10));
    const { tabIds } = chrome.openWindow(['https://a.com', { url: 'https://b.com', active: true }], { focused: true });
    await onMenuClicked({ menuItemId: `${MENU.snoozeTab}:next-week`, parentMenuItemId: MENU.snoozeTab } as never, await fakeBrowser.tabs.get(tabIds[0]!));
    expect(chrome.tab(tabIds[0]!)).toBeUndefined();
    expect((await db.tabs.toArray()).map((t) => t.snoozeUntil)).toEqual([local(19, 9)]);
    expect(await badge()).toBe('Zz');
  });

  it('Alt+Shift+Z snoozes the tab you’re on until tomorrow morning; on a full snooze list it opens the popup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(local(12, 10));
    const openPopup = vi.spyOn(fakeBrowser.action, 'openPopup').mockResolvedValue(undefined as never);
    const { tabIds } = chrome.openWindow(['https://a.com', { url: 'https://b.com', active: true }, 'https://c.com'], { focused: true });
    await onCommand('snooze-tab');
    expect(chrome.tab(tabIds[1]!)).toBeUndefined();
    expect((await db.tabs.toArray()).map((t) => [t.url, t.snoozeUntil])).toEqual([['https://b.com', local(13, 9)]]);
    expect(openPopup).not.toHaveBeenCalled();

    const [x, y] = await seed(['https://x.com', 'https://y.com']);
    await db.tabs.where('id').anyOf([x!.id, y!.id]).modify({ snoozeUntil: local(20, 9), snoozedOn: 'd' });
    chrome.tab(tabIds[2]!)!.active = true;
    await onCommand('snooze-tab', await fakeBrowser.tabs.get(tabIds[2]!));
    expect(chrome.tab(tabIds[2]!)).toBeDefined();
    expect(chrome.events('limit-hit')).toEqual([{ type: 'limit-hit', code: 'snooze-limit' }]);
    expect(openPopup).toHaveBeenCalledTimes(1);
  });
});
