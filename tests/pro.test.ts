import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterFold, ensureMilestoneStart, recordFreedMemory } from '@/lib/background/pro';
import { route } from '@/lib/background/router';
import { db } from '@/lib/db';
import { CommandError, type Command } from '@/lib/messages';
import { PROJECT_COLORS } from '@/lib/pro/ai';
import { api, errorFromResponse, PRO_ERROR_MESSAGES, ProError } from '@/lib/pro/api';
import { getApiKey } from '@/lib/pro/extpay';
import { milestoneDue, monthKey } from '@/lib/pro/milestone';
import { getPageWatch, NOT_AVAILABLE, onPageClosed, pollPageWatch, refreshPlan, TRIAL_END_ALARM } from '@/lib/pro/plan';
import { aiRuns, milestoneState, planEnded, planState, projectsState } from '@/lib/pro/state';
import { planFromUser } from '@/lib/pro/tiers';
import { FREE_PLAN, type AiGroup, type PlanState } from '@/lib/pro/types';
import { getSessionGraph, listFoldedTabs, listLiveSessions, saveCapture } from '@/lib/repo';
import { getSettings } from '@/lib/settings';
import { CLOUD_LIMITS, pack, syncId, toSyncTime, type SyncRecord } from '@/lib/sync/records';
import { FakeChrome } from './chrome';
import { capturedTab, capturedWindow } from './fixtures';
import { API_URL, EXTPAY_ID, extpayUser, FakeServer, giveKey, installPro } from './proServer';

const DAY = 24 * 60 * 60 * 1000;

let pro: ReturnType<typeof installPro>;
let server: FakeServer;

beforeEach(() => {
  pro = installPro();
  server = pro.server;
});

afterEach(() => {
  pro.restore();
  vi.restoreAllMocks();
});

async function send<C extends Command>(command: C) {
  return route(command);
}

/** This install pays for `nickname` (or is in the trial), and the server agrees. */
async function onPlan(nickname: string): Promise<PlanState> {
  const key = await giveKey();
  server.users.set(key, extpayUser({ nickname }));
  server.proKeys.add(key);
  const plan = planFromUser(server.users.get(key)!, Date.now());
  await planState.set(plan);
  return plan;
}

async function fold(urls: string[], now: number, extra: { incognito?: boolean; titles?: Record<string, string> } = {}) {
  const window = capturedWindow(urls, extra.incognito ? { incognito: true } : {});
  for (const tab of window.tabs) if (extra.titles?.[tab.url]) tab.title = extra.titles[tab.url]!;
  return saveCapture([window], { source: 'save-all', deviceId: 'd', now }, { dedupe: false });
}

// ---------------------------------------------------------------------------------------------

describe('plan', () => {
  it('is Free without a key, and asks ExtensionPay nothing', async () => {
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'free', trial: null });
    expect(server.extpayCalls('user')).toBe(0);
    expect((await planState.get()).checkedAt).toBeGreaterThan(0);
  });

  it('reads a paid plan, at most once a minute unless forced', async () => {
    const key = await giveKey();
    server.users.set(key, extpayUser({ nickname: 'pro-ai-yearly', interval: 'year' }));
    expect(await refreshPlan()).toMatchObject({ tier: 'pro-ai', interval: 'year', email: 'ada@example.com', trial: null, status: 'active' });
    expect(server.requests.find((r) => r.url.includes('/api/v2/user'))!.url).toBe(
      `https://extensionpay.com/extension/${EXTPAY_ID}/api/v2/user?api_key=key-1`,
    );
    expect(await refreshPlan()).toMatchObject({ tier: 'pro-ai' });
    // A page opening asks too: still within the minute.
    expect(await send({ type: 'plan-refresh' })).toMatchObject({ ok: true, data: { tier: 'pro-ai' } });
    expect(server.extpayCalls('user')).toBe(1);
    await refreshPlan({ force: true });
    expect(server.extpayCalls('user')).toBe(2);
  });

  it('keeps the cached plan when ExtensionPay is unreachable or failing', async () => {
    const plan = await onPlan('pro-monthly');
    server.offline = true;
    expect(await refreshPlan({ force: true })).toEqual(plan);
    server.offline = false;
    server.extpayDown = true;
    expect(await refreshPlan({ force: true })).toEqual(plan);
    expect(await planState.get()).toEqual(plan);
    expect(await planEnded.get()).toBeUndefined();
  });

  it('a trial gives Pro AI; when it runs out the plan ends once, and paying clears that', async () => {
    const key = await giveKey();
    server.users.set(key, extpayUser({ trialDaysAgo: 2 }));
    const trial = await refreshPlan({ force: true });
    expect(trial).toMatchObject({ tier: 'pro-ai', trial: { endsAt: expect.any(Number) } });
    // The plan is read again right when the trial ends.
    expect((await fakeBrowser.alarms.get(TRIAL_END_ALARM))?.scheduledTime).toBe(trial.trial!.endsAt + 30_000);

    server.users.set(key, extpayUser({ trialDaysAgo: 8 }));
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'free', trial: null });
    const ended = await planEnded.get();
    expect(ended).toMatchObject({ tier: 'pro-ai', wasTrial: true });
    expect(await fakeBrowser.alarms.get(TRIAL_END_ALARM)).toBeUndefined();
    // Still Free: the notice isn't set again.
    await refreshPlan({ force: true });
    expect(await planEnded.get()).toEqual(ended);

    server.users.set(key, extpayUser({ nickname: 'pro-monthly', trialDaysAgo: 8 }));
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'pro' });
    expect(await planEnded.get()).toBeUndefined();
  });

  it('a cancelled or failed payment ends a paid plan', async () => {
    const key = await giveKey();
    server.users.set(key, extpayUser({ nickname: 'pro-monthly' }));
    await refreshPlan({ force: true });
    server.users.set(key, extpayUser({ nickname: 'pro-monthly', status: 'canceled' }));
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'free' });
    expect(await planEnded.get()).toMatchObject({ tier: 'pro', wasTrial: false });
  });

  it('a build without Pro is always Free, opens nothing and calls nothing', async () => {
    pro.restore();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await planState.set({ ...FREE_PLAN, tier: 'pro', checkedAt: 1 });
    expect(await refreshPlan({ force: true })).toEqual(FREE_PLAN);
    expect(await planState.get()).toEqual(FREE_PLAN);
    expect(await send({ type: 'plan-open', page: 'payment', tier: 'pro', interval: 'month' })).toEqual({
      ok: true,
      data: { opened: false, reason: NOT_AVAILABLE },
    });
    expect(await send({ type: 'ai-organise' })).toMatchObject({ ok: false, code: 'not-configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------

describe('ExtensionPay pages', () => {
  let chrome: FakeChrome;

  beforeEach(() => {
    chrome = new FakeChrome().install();
    chrome.openWindow(['https://work.com'], { focused: true });
  });

  it('creates the key on first use, opens checkout in a tab, and notices the payment there', async () => {
    vi.spyOn(fakeBrowser.management, 'getSelf').mockResolvedValue({ installType: 'development' } as never);
    expect(await send({ type: 'plan-open', page: 'payment', tier: 'pro', interval: 'year' })).toEqual({ ok: true, data: { opened: true } });
    expect(server.keysCreated).toEqual([{ key: 'key-1', development: true }]);
    expect(await getApiKey()).toBe('key-1');
    const tab = chrome.tabs.find((t) => t.url.startsWith('https://extensionpay.com'))!;
    expect(tab).toMatchObject({ url: `https://extensionpay.com/extension/${EXTPAY_ID}/choose-plan/pro-yearly?api_key=key-1`, active: true });
    expect(await getPageWatch()).toMatchObject({ kind: 'tab', id: tab.id });

    expect(await pollPageWatch()).toBe('watching');
    expect((await planState.get()).tier).toBe('free');
    // The person pays in that tab: the next poll sees it.
    server.users.set('key-1', extpayUser({ nickname: 'pro-yearly', interval: 'year' }));
    expect(await pollPageWatch()).toBe('watching');
    expect(await planState.get()).toMatchObject({ tier: 'pro', interval: 'year' });

    // The tab closes: one more read, then it stops.
    const reads = server.extpayCalls('user');
    await fakeBrowser.tabs.remove(tab.id);
    await onPageClosed('tab', tab.id);
    expect(server.extpayCalls('user')).toBe(reads + 1);
    expect(await getPageWatch()).toBeUndefined();
    expect(await pollPageWatch()).toBe('idle');
  });

  it('a key made outside development says so, and an existing key is reused', async () => {
    vi.spyOn(fakeBrowser.management, 'getSelf').mockResolvedValue({ installType: 'normal' } as never);
    await send({ type: 'plan-open', page: 'manage' });
    await send({ type: 'plan-open', page: 'payment' });
    expect(server.keysCreated).toEqual([{ key: 'key-1', development: false }]);
    const urls = chrome.tabs.filter((t) => t.url.startsWith('https://extensionpay.com')).map((t) => t.url);
    expect(urls).toEqual([
      `https://extensionpay.com/extension/${EXTPAY_ID}/choose-plan?api_key=key-1`,
      `https://extensionpay.com/extension/${EXTPAY_ID}/choose-plan?api_key=key-1`,
    ]);
    // The second page took over the watch.
    expect(await getPageWatch()).toMatchObject({ kind: 'tab', id: chrome.tabs.at(-1)!.id });
  });

  it('opens the trial and sign-in as small windows centred over the current one', async () => {
    await giveKey('key-9');
    await send({ type: 'plan-open', page: 'trial' });
    expect(chrome.createdWindows.at(-1)).toEqual({
      url: `https://extensionpay.com/extension/${EXTPAY_ID}/trial?api_key=key-9&period=7%20days`,
      type: 'popup',
      width: 500,
      height: 700,
      focused: true,
      left: 350,
      top: 50,
    });
    const trialWindow = chrome.windows.at(-1)!;
    expect(await getPageWatch()).toMatchObject({ kind: 'window', id: trialWindow.id });

    await send({ type: 'plan-open', page: 'login' });
    expect(chrome.createdWindows.at(-1)).toMatchObject({
      url: `https://extensionpay.com/extension/${EXTPAY_ID}/reactivate?api_key=key-9&back=choose-plan&v2`,
      type: 'popup',
      width: 500,
      height: 800,
      top: 0,
    });
    expect(server.keysCreated).toEqual([]);
  });

  it('stops watching after 15 minutes even if the page stays open', async () => {
    await giveKey();
    await send({ type: 'plan-open', page: 'trial' });
    expect(await pollPageWatch(Date.now() + 16 * 60_000)).toBe('done');
    expect(await getPageWatch()).toBeUndefined();
  });

  it('explains when ExtensionPay is unreachable', async () => {
    server.offline = true;
    const result = await send({ type: 'plan-open', page: 'payment', tier: 'pro-ai', interval: 'month' });
    expect(result).toMatchObject({ ok: true, data: { opened: false, reason: expect.stringContaining('ExtensionPay') } });
    expect(chrome.tabs.some((t) => t.url.startsWith('https://extensionpay.com'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe('server client', () => {
  it('maps HTTP errors to ProError codes, with the server’s message or a friendly one', () => {
    const runs = { used: 300, limit: 300, resetsAt: 1 };
    expect(errorFromResponse(401, {})).toMatchObject({ code: 'not-signed-in', status: 401, message: PRO_ERROR_MESSAGES['not-signed-in'] });
    expect(errorFromResponse(402, { error: 'needs-pro-ai', message: 'Pro AI only.' })).toMatchObject({ code: 'needs-pro-ai', message: 'Pro AI only.' });
    expect(errorFromResponse(402, null).code).toBe('needs-pro');
    expect(errorFromResponse(429, { error: 'runs-used-up', runs })).toMatchObject({ code: 'runs-used-up', body: { runs } });
    expect(errorFromResponse(502, null, '/ai').code).toBe('ai-failed');
    expect(errorFromResponse(502, null, '/sync').code).toBe('server');
    expect(errorFromResponse(409, { error: 'conflict', version: 7 })).toMatchObject({ code: 'server', status: 409, body: { version: 7 } });
    expect(errorFromResponse(413, { error: 'server', message: 'Too large.' }).message).toBe('Too large.');
    expect(errorFromResponse(500, 'oops')).toMatchObject({ code: 'server', message: PRO_ERROR_MESSAGES.server });
    expect(errorFromResponse(401, {})).toBeInstanceOf(CommandError);
  });

  it('sends the key as a bearer token; no key, no network, or no Pro build each fail clearly', async () => {
    await expect(api('/sync')).rejects.toMatchObject({ code: 'not-signed-in' });
    expect(server.requests).toHaveLength(0);

    const key = await giveKey();
    server.proKeys.add(key);
    expect(await api('/sync')).toEqual({ items: {}, version: 0 });
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: `${API_URL}/sync`, auth: 'Bearer key-1' });

    server.offline = true;
    await expect(api('/sync')).rejects.toMatchObject({ code: 'offline', message: PRO_ERROR_MESSAGES.offline });
    pro.restore();
    await expect(api('/sync')).rejects.toBeInstanceOf(ProError);
    await expect(api('/sync')).rejects.toMatchObject({ code: 'not-configured' });
  });

  it('a Pro feature without the plan reaches the page as a readable error with its code', async () => {
    await giveKey();
    expect(await send({ type: 'ai-organise' })).toEqual({ ok: false, code: 'needs-pro-ai', error: PRO_ERROR_MESSAGES['needs-pro-ai'] });
    expect(await send({ type: 'backups-list' })).toMatchObject({ ok: false, code: 'needs-pro' });
    // It read the plan again before saying no (the person may have just paid).
    expect(server.extpayCalls('user')).toBeGreaterThan(0);
    expect(server.apiCalls('/ai', 'POST')).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('Organise with AI', () => {
  const T = Date.UTC(2026, 9, 1);

  async function seed() {
    const longTitle = 'L'.repeat(300);
    await fold(Array.from({ length: 10 }, (_, i) => `https://old${i}.com/`), T);
    const recent = await fold(Array.from({ length: 300 }, (_, i) => `https://new${i}.example.com/p`), T + DAY, {
      titles: { 'https://new0.example.com/p': longTitle },
    });
    await fold(['https://secret.com/a', 'https://secret.com/b'], T + 2 * DAY, { incognito: true });
    return recent.savedTabIds;
  }

  it('sends the newest 300 tabs that aren’t Incognito, titles and sites only, and colours the projects', async () => {
    await onPlan('pro-ai-monthly');
    const ids = await seed();
    const pairs = Array.from({ length: 9 }, (_, i) => ({ name: `Project ${i + 1}`, tabIds: [ids[i * 2]!, ids[i * 2 + 1]!] }));
    server.ai = () => ({
      status: 200,
      body: {
        groups: [
          ...pairs,
          { name: 'Ghost', tabIds: ['not-sent'] },
          { name: 'Again', tabIds: [ids[0]!, ids[40]!] },
          { name: '   ', tabIds: [ids[41]!] },
          { name: 'A very long project name that goes on and on', tabIds: [ids[42]!] },
        ],
        runs: { used: 5, limit: 300, resetsAt: Date.UTC(2026, 10, 1) },
      },
    });

    const result = await send({ type: 'ai-organise' });
    expect(result.ok).toBe(true);
    const data = (result as { data: import('@/lib/pro/types').OrganiseResult }).data;

    const request = server.aiRequests[0]!;
    expect(request.task).toBe('organise');
    expect(request.tabs).toHaveLength(300);
    for (const tab of request.tabs) expect(Object.keys(tab).sort()).toEqual(['host', 'id', 'title']);
    expect(request.tabs.some((t) => t.host.includes('secret') || t.host.startsWith('old'))).toBe(false);
    expect(request.tabs.find((t) => t.id === ids[0])!).toMatchObject({ title: 'L'.repeat(200), host: 'new0.example.com' });

    expect(data.notSent).toBe(12);
    expect(data.groups.map((g) => g.color)).toEqual([...PROJECT_COLORS, 'blue', 'purple', 'yellow']);
    expect(data.groups.map((g) => g.color)).not.toContain('grey');
    expect(data.groups.map((g) => g.name)).toEqual([
      ...pairs.map((p) => p.name),
      'Again',
      'A very long project name that go',
    ]);
    // Only ids that were sent, each tab once.
    expect(data.groups.find((g) => g.name === 'Again')!.tabIds).toEqual([ids[40]]);
    const grouped = data.groups.flatMap((g) => g.tabIds);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(data.ungrouped).toHaveLength(300 - grouped.length);
    expect(data.runs).toEqual({ used: 5, limit: 300, resetsAt: Date.UTC(2026, 10, 1) });
    expect(await aiRuns.get()).toEqual(data.runs);
    // A preview: nothing changed.
    expect((await listFoldedTabs()).some((t) => t.project)).toBe(false);
  });

  it('keeps the count when this month’s runs are used up', async () => {
    await onPlan('pro-ai-monthly');
    await fold(['https://a.com'], T);
    const runs = { used: 300, limit: 300, resetsAt: Date.UTC(2026, 10, 1) };
    server.ai = () => ({ status: 429, body: { error: 'runs-used-up', message: 'All 300 used.', runs } });
    expect(await send({ type: 'ai-organise' })).toEqual({ ok: false, code: 'runs-used-up', error: 'All 300 used.' });
    expect(await aiRuns.get()).toEqual(runs);

    server.ai = () => ({ status: 502, body: { error: 'ai-failed', message: 'Try again.' } });
    expect(await send({ type: 'ai-organise' })).toMatchObject({ ok: false, code: 'ai-failed' });
  });

  it('with nothing to send, asks nothing', async () => {
    await onPlan('pro-ai-yearly');
    await fold(['https://private.com'], T, { incognito: true });
    expect(await send({ type: 'ai-organise' })).toMatchObject({ ok: true, data: { groups: [], ungrouped: [], notSent: 1 } });
    expect(server.aiRequests).toHaveLength(0);
  });

  it('applies the kept projects, clears the old ones, and switches the list to By project', async () => {
    const ids = (await fold(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'], T)).savedTabIds;
    await db.tabs.update(ids[3]!, { project: 'Old project' });
    const groups: AiGroup[] = [
      { name: 'Checkout app', color: 'blue', tabIds: [ids[0]!, ids[1]!] },
      { name: 'Holiday in Lisbon', color: 'purple', tabIds: [ids[2]!, 'gone'] },
      { name: 'Empty', color: 'yellow', tabIds: ['gone-too'] },
    ];
    const now = Date.now();
    expect(await send({ type: 'ai-apply', groups })).toEqual({ ok: true, data: { applied: 3 } });
    const byId = new Map((await db.tabs.toArray()).map((t) => [t.id, t.project]));
    expect([byId.get(ids[0]!), byId.get(ids[1]!), byId.get(ids[2]!), byId.get(ids[3]!)]).toEqual([
      'Checkout app',
      'Checkout app',
      'Holiday in Lisbon',
      undefined,
    ]);
    const state = await projectsState.get();
    expect(state.projects).toEqual([
      { name: 'Checkout app', color: 'blue' },
      { name: 'Holiday in Lisbon', color: 'purple' },
    ]);
    expect(state.organisedAt).toBeGreaterThanOrEqual(now);
    expect((await getSettings()).groupBy).toBe('project');
  });
});

// ---------------------------------------------------------------------------------------------

describe('Copy as context', () => {
  it('a heading, the AI’s summary and a link per tab', async () => {
    await onPlan('pro-ai-monthly');
    const window = capturedWindow([]);
    window.tabs = [
      capturedTab('https://github.com/acme/checkout/pull/12', { title: 'Fix [webhooks] retries' }),
      capturedTab('https://en.wikipedia.org/wiki/Foo_(bar)', { title: 'Foo (bar)' }),
      capturedTab('https://docs.stripe.com/webhooks', { title: '' }),
    ];
    const saved = await saveCapture([window], { source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: false });
    const result = await send({ type: 'ai-context', tabRecordIds: saved.savedTabIds, name: 'Checkout app' });
    expect(result).toEqual({
      ok: true,
      data: {
        markdown: [
          '## Checkout app',
          '',
          'Tabs about a checkout app.',
          '',
          '- [Fix \\[webhooks\\] retries](https://github.com/acme/checkout/pull/12)',
          '- [Foo (bar)](https://en.wikipedia.org/wiki/Foo_%28bar%29)',
          '- [docs.stripe.com](https://docs.stripe.com/webhooks)',
          '',
        ].join('\n'),
      },
    });
    expect(server.aiRequests[0]).toMatchObject({ task: 'context', name: 'Checkout app' });
    expect(server.aiRequests[0]!.tabs).toHaveLength(3);
  });

  it('still copies the links when the AI fails, and never sends Incognito tabs', async () => {
    await onPlan('pro-ai-monthly');
    const normal = await fold(['https://a.com/x'], Date.now());
    const secret = await fold(['https://secret.com/y'], Date.now(), { incognito: true });
    server.ai = () => ({ status: 502, body: { error: 'ai-failed' } });
    const result = await send({ type: 'ai-context', tabRecordIds: [...normal.savedTabIds, ...secret.savedTabIds], name: 'Mixed' });
    expect(result).toEqual({
      ok: true,
      data: { markdown: '## Mixed\n\n- [Title of https://a.com/x](https://a.com/x)\n- [Title of https://secret.com/y](https://secret.com/y)\n' },
    });
    expect(server.aiRequests[0]!.tabs.map((t) => t.host)).toEqual(['a.com']);
  });

  it('without Pro AI, copies the links and asks nothing', async () => {
    const saved = await fold(['https://a.com'], Date.now());
    expect(await send({ type: 'ai-context', tabRecordIds: saved.savedTabIds, name: 'Dev' })).toEqual({
      ok: true,
      data: { markdown: '## Dev\n\n- [Title of https://a.com](https://a.com)\n' },
    });
    expect(server.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('smart names and the milestone after a fold', () => {
  it('names a fold with Pro AI, from its titles and sites only', async () => {
    await onPlan('pro-ai-monthly');
    const window = capturedWindow(['https://dashboard.stripe.com/webhooks', 'https://github.com/acme/checkout']);
    const secret = { ...capturedWindow(['https://private.com']), incognito: true };
    const saved = await saveCapture([window, secret], { source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: true });
    const before = (await db.sessions.get(saved.sessionId))!;
    await afterFold({ sessionId: saved.sessionId, savedTabs: 3, freedBytes: 0 });
    const after = (await db.sessions.get(saved.sessionId))!;
    expect(after.smartName).toBe('Checkout app');
    // The fold keeps its place in the list.
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(server.aiRequests[0]).toEqual({
      task: 'name',
      tabs: [
        expect.objectContaining({ host: 'dashboard.stripe.com' }),
        expect.objectContaining({ host: 'github.com' }),
      ],
    });
  });

  it('a failed or empty answer, or no Pro AI, changes nothing and throws nothing', async () => {
    const saved = await fold(['https://a.com'], Date.now());
    await afterFold({ sessionId: saved.sessionId, savedTabs: 1, freedBytes: 0 });
    expect(server.aiRequests).toHaveLength(0);

    await onPlan('pro-ai-monthly');
    server.ai = () => ({ status: 502, body: { error: 'ai-failed' } });
    await expect(afterFold({ sessionId: saved.sessionId, savedTabs: 1, freedBytes: 0 })).resolves.toBeUndefined();
    server.ai = () => ({ status: 200, body: { name: '   ' } });
    await afterFold({ sessionId: saved.sessionId, savedTabs: 1, freedBytes: 0 });
    server.offline = true;
    await afterFold({ sessionId: saved.sessionId, savedTabs: 1, freedBytes: 0 });
    expect((await db.sessions.get(saved.sessionId))!.smartName).toBeUndefined();

    // Pro (without AI) doesn't name folds.
    server.offline = false;
    await planState.set(planFromUser(extpayUser({ nickname: 'pro-monthly' }), Date.now()));
    const requests = server.aiRequests.length;
    await afterFold({ sessionId: saved.sessionId, savedTabs: 1, freedBytes: 0 });
    expect(server.aiRequests).toHaveLength(requests);
  });

  it('adds up the memory folds freed this month, starting again each month', async () => {
    const oct = new Date(2026, 9, 10).getTime();
    await fakeBrowser.storage.local.set({ installedAt: oct - 10 * DAY });
    await ensureMilestoneStart(oct);
    expect(await milestoneState.get()).toEqual({ firstSeenAt: oct - 10 * DAY, month: '2026-10', freedBytes: 0, lastShownAt: 0, dismissedUntil: 0 });
    // Already there: kept.
    await ensureMilestoneStart(oct + DAY);
    expect((await milestoneState.get())!.firstSeenAt).toBe(oct - 10 * DAY);

    const GB = 1024 ** 3;
    await recordFreedMemory(0.75 * GB, oct);
    await recordFreedMemory(0, oct);
    await recordFreedMemory(0.5 * GB, oct + DAY);
    expect((await milestoneState.get())!.freedBytes).toBe(1.25 * GB);
    expect(milestoneDue(await milestoneState.get(), FREE_PLAN, oct + DAY)).toEqual({ freedBytes: 1.25 * GB });

    const nov = new Date(2026, 10, 2).getTime();
    await recordFreedMemory(0.25 * GB, nov);
    expect(await milestoneState.get()).toMatchObject({ month: monthKey(nov), freedBytes: 0.25 * GB, firstSeenAt: oct - 10 * DAY });
  });

  it('"Not now" hides the milestone for 30 days', async () => {
    const now = Date.now();
    await recordFreedMemory(2 * 1024 ** 3, now);
    await milestoneState.set({ ...(await milestoneState.get())!, firstSeenAt: now - 10 * DAY });
    expect(milestoneDue(await milestoneState.get(), FREE_PLAN, now)).not.toBeNull();
    expect(await send({ type: 'milestone-dismiss' })).toEqual({ ok: true, data: { ok: true } });
    const state = (await milestoneState.get())!;
    expect(state.dismissedUntil).toBeGreaterThanOrEqual(now + 30 * DAY);
    expect(milestoneDue(state, FREE_PLAN, now + DAY)).toBeNull();
  });

  it('a fold that frees memory counts toward the milestone', async () => {
    const chrome = new FakeChrome().install();
    chrome.openWindow(['https://a.com', 'https://b.com', { url: 'https://c.com', discarded: true }], { focused: true });
    chrome.openWindow(['https://d.com']);
    const result = await send({ type: 'fold' });
    expect(result.ok).toBe(true);
    const freed = (result as { data: { freedBytes: number } }).data.freedBytes;
    expect(freed).toBeGreaterThan(0);
    await vi.waitFor(async () => expect((await milestoneState.get())?.freedBytes).toBe(freed));
  });
});

// ---------------------------------------------------------------------------------------------

describe('backups', () => {
  const T = Date.UTC(2026, 9, 8, 12);

  function backupOf(urls: string[], keywords: string[] = []): Record<string, unknown> {
    const records: SyncRecord[] = urls.map((url, i) => ({
      id: syncId(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`),
      url,
      title: `Backed up ${url}`,
      savedAt: toSyncTime(T - i * 1000),
      keywords,
    }));
    return pack(records, [], { floor: 0, limits: CLOUD_LIMITS }).items;
  }

  it('lists the daily backups, newest first', async () => {
    await onPlan('pro-monthly');
    server.backups.set('2026-10-07', { items: {}, tabCount: 12, createdAt: T - DAY });
    server.backups.set('2026-10-08', { items: {}, tabCount: 14, createdAt: T });
    expect(await send({ type: 'backups-list' })).toEqual({
      ok: true,
      data: [
        { day: '2026-10-08', tabCount: 14, createdAt: T },
        { day: '2026-10-07', tabCount: 12, createdAt: T - DAY },
      ],
    });
  });

  it('restores only the missing tabs as one fold, and deletes nothing', async () => {
    await onPlan('pro-monthly');
    const kept = await fold(['https://kept.com/', 'https://other.com'], Date.now());
    await fold(['https://private.com/x'], Date.now(), { incognito: true });
    server.backups.set('2026-10-08', {
      items: backupOf(['https://kept.com', 'https://gone.com/a', 'https://gone.com/b', 'https://private.com/x'], ['work']),
      tabCount: 4,
      createdAt: T,
    });
    const before = await listFoldedTabs();

    const result = await send({ type: 'backup-restore', day: '2026-10-08' });
    expect(result).toMatchObject({ ok: true, data: { restored: 3 } });
    const sessionId = (result as { data: { sessionId: string } }).data.sessionId;
    const graph = (await getSessionGraph(sessionId))!;
    expect(graph.session.name).toBe('Restored · 8 Oct');
    expect(graph.windows.flatMap((w) => w.tabs.map((t) => t.url)).sort()).toEqual([
      'https://gone.com/a',
      'https://gone.com/b',
      'https://private.com/x',
    ]);
    expect(graph.windows[0]!.tabs.every((t) => t.keywords.join() === 'work' && t.title.startsWith('Backed up'))).toBe(true);
    // Everything that was there is still there, unchanged.
    const after = await listFoldedTabs();
    for (const tab of before) expect(after.find((t) => t.id === tab.id)).toEqual(tab);
    expect((await db.sessions.get(kept.sessionId))!.deletedAt).toBe(0);

    // Again: nothing is missing now, so no empty fold.
    expect(await send({ type: 'backup-restore', day: '2026-10-08' })).toEqual({ ok: true, data: { restored: 0, sessionId: null } });
    expect(await listLiveSessions()).toHaveLength(3);
  });

  it('a missing or malformed day is an error, not a fold', async () => {
    await onPlan('pro-monthly');
    expect(await send({ type: 'backup-restore', day: '2026-01-01' })).toMatchObject({ ok: false, code: 'server', error: 'No backup for that day.' });
    expect(await send({ type: 'backup-restore', day: '../sync' })).toMatchObject({ ok: false, code: 'server' });
    expect(server.requests.some((r) => r.url.includes('..'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe('reopen everything', () => {
  it('reopens every live fold as its windows, in the background and lazily', async () => {
    const chrome = new FakeChrome().install();
    chrome.openWindow(['https://current.com'], { focused: true });
    await saveCapture(
      [capturedWindow(['https://a.com', 'https://b.com']), capturedWindow(['https://c.com'])],
      { source: 'save-all', deviceId: 'd', now: Date.now() - 1000 },
      { dedupe: false },
    );
    await fold(['https://d.com', 'chrome://crash'], Date.now());

    const result = await send({ type: 'reopen-everything' });
    expect(result).toEqual({ ok: true, data: { opened: 4, failed: 1 } });
    expect(chrome.createdWindows).toHaveLength(3);
    expect(chrome.createdWindows.every((w) => w?.focused === false)).toBe(true);
    const urls = chrome.webTabs().map((t) => t.url).sort();
    expect(urls).toEqual(['https://a.com', 'https://b.com', 'https://c.com', 'https://current.com', 'https://d.com']);
    // Lazily: background tabs went to sleep after loading.
    expect(chrome.discardLog.length).toBeGreaterThan(0);
    // Nothing was removed from the list.
    expect(await listFoldedTabs()).toHaveLength(5);
  });
});
