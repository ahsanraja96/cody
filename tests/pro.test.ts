import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterFold, ensureMilestoneStart, recordFreedMemory } from '@/lib/background/pro';
import { route } from '@/lib/background/router';
import { db } from '@/lib/db';
import { CommandError, type Command } from '@/lib/messages';
import {
  DEVICE_TOKEN_KEY,
  ensureProfileKey,
  getDeviceToken,
  isToken,
  newToken,
  peekDeviceToken,
  PROFILE_KEY,
  SIGNED_OUT_KEY,
} from '@/lib/pro/account';
import { PROJECT_COLORS } from '@/lib/pro/ai';
import { api, errorFromResponse, PRO_ERROR_MESSAGES, ProError } from '@/lib/pro/api';
import { CHECKOUT_MAX_MS, onTabClosed, onTabUrl, pollCheckout, returnPage } from '@/lib/pro/checkout';
import { milestoneDue, monthKey } from '@/lib/pro/milestone';
import { refreshPlan, resetPlanRuntime, setupPlan, TRIAL_END_ALARM } from '@/lib/pro/plan';
import { aiRuns, checkoutNotice, checkoutState, milestoneState, needsSignIn, planEnded, planState, projectsState } from '@/lib/pro/state';
import { FREE_PLAN, type AiGroup, type PlanState } from '@/lib/pro/types';
import { getSessionGraph, listFoldedTabs, listLiveSessions, saveCapture } from '@/lib/repo';
import { getSettings } from '@/lib/settings';
import { CLOUD_LIMITS, pack, syncId, toSyncTime, type SyncRecord } from '@/lib/sync/records';
import { FakeChrome } from './chrome';
import { capturedTab, capturedWindow } from './fixtures';
import { API_URL, CODE, EMAIL, FakeServer, giveToken, installPro, planOf, signedIn, TOKEN } from './proServer';

const DAY = 24 * 60 * 60 * 1000;
const PROFILE = 'profile-key-'.padEnd(43, 'p');

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

async function send<C extends Command>(command: C, source: { tabId?: number } = {}) {
  return route(command, source);
}

/** Signed in here to an account paying for `nickname` ("pro-monthly", "pro-ai-yearly"), the server agreeing. */
async function onPlan(nickname: string): Promise<PlanState> {
  return signedIn(server, nickname.startsWith('pro-ai') ? 'pro-ai' : 'pro', { interval: nickname.endsWith('yearly') ? 'year' : 'month' });
}

async function fold(urls: string[], now: number, extra: { incognito?: boolean; titles?: Record<string, string> } = {}) {
  const window = capturedWindow(urls, extra.incognito ? { incognito: true } : {});
  for (const tab of window.tabs) if (extra.titles?.[tab.url]) tab.title = extra.titles[tab.url]!;
  return saveCapture([window], { source: 'save-all', deviceId: 'd', now }, { dedupe: false });
}

const local = async (key: string) => (await fakeBrowser.storage.local.get(key))[key];
const synced = async (key: string) => (await fakeBrowser.storage.sync.get(key))[key];
const paths = () => server.requests.map((r) => `${r.method} ${r.path}`);

// ---------------------------------------------------------------------------------------------

describe('account', () => {
  it('device tokens and profile keys are 32 random bytes in base64url', async () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
    expect(isToken(a)).toBe(true);
    expect(isToken('short')).toBe(false);
    expect(isToken('has space'.padEnd(43, 'x'))).toBe(false);
  });

  it('makes the device token once, on first need, and keeps it in local storage', async () => {
    expect(await peekDeviceToken()).toBeNull();
    const [one, two] = await Promise.all([getDeviceToken(), getDeviceToken()]);
    expect(one).toBe(two);
    expect(await local(DEVICE_TOKEN_KEY)).toBe(one);
    expect(await getDeviceToken()).toBe(one);
    // A damaged one is replaced.
    await fakeBrowser.storage.local.set({ [DEVICE_TOKEN_KEY]: 'nope' });
    expect(await peekDeviceToken()).toBeNull();
    expect(isToken(await getDeviceToken())).toBe(true);
  });

  it('the profile key lives in Chrome sync; without sync storage there is none, and nothing breaks', async () => {
    const key = await ensureProfileKey();
    expect(isToken(key)).toBe(true);
    expect(await synced(PROFILE_KEY)).toBe(key);
    expect(await ensureProfileKey()).toBe(key);

    fakeBrowser.reset();
    vi.spyOn(fakeBrowser.storage.sync, 'get').mockRejectedValue(new Error('sync is off'));
    vi.spyOn(fakeBrowser.storage.sync, 'set').mockRejectedValue(new Error('sync is off'));
    expect(await ensureProfileKey()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('plan', () => {
  it('is Free without a device token, and asks the server nothing', async () => {
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'free', trial: null, email: null });
    expect(server.requests).toHaveLength(0);
    expect(await peekDeviceToken()).toBeNull();
    expect((await planState.get()).checkedAt).toBeGreaterThan(0);
  });

  it('reads the plan from /me with the device token, at most once a minute unless forced', async () => {
    server.account(EMAIL, { tier: 'pro-ai', interval: 'year', status: 'active', renewsAt: Date.UTC(2027, 9, 12) });
    server.link(await giveToken());
    expect(await refreshPlan()).toEqual({
      ...FREE_PLAN,
      tier: 'pro-ai',
      email: EMAIL,
      interval: 'year',
      status: 'active',
      renewsAt: Date.UTC(2027, 9, 12),
      checkedAt: expect.any(Number),
    });
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: `${API_URL}/me`, auth: `Bearer ${TOKEN}` });
    expect(await aiRuns.get()).toEqual(server.runs);
    expect(await refreshPlan()).toMatchObject({ tier: 'pro-ai' });
    // A page opening asks too: still within the minute.
    expect(await send({ type: 'plan-refresh' })).toMatchObject({ ok: true, data: { tier: 'pro-ai' } });
    expect(server.apiCalls('/me')).toBe(1);
    await refreshPlan({ force: true });
    expect(await send({ type: 'plan-refresh', force: true })).toMatchObject({ ok: true });
    expect(server.apiCalls('/me')).toBe(3);
  });

  it('keeps the cached plan when the server is unreachable, failing or makes no sense', async () => {
    const plan = await onPlan('pro-monthly');
    server.offline = true;
    expect(await refreshPlan({ force: true })).toEqual(plan);
    server.offline = false;
    server.overrides.set('GET /me', { status: 500, body: { error: 'server' } });
    expect(await refreshPlan({ force: true })).toEqual(plan);
    server.overrides.set('GET /me', { status: 200, body: { plan: { tier: 'gold' } } });
    expect(await refreshPlan({ force: true })).toEqual(plan);
    expect(await planState.get()).toEqual(plan);
    expect(await planEnded.get()).toBeUndefined();
  });

  it('the server trial gives Pro AI; when it runs out the plan ends once, and paying clears that', async () => {
    const account = server.account(EMAIL);
    account.trialStartedAt = Date.now() - 2 * DAY;
    server.link(await giveToken());
    const trial = await refreshPlan({ force: true });
    expect(trial).toMatchObject({ tier: 'pro-ai', trialUsed: true, status: null, trial: { endsAt: account.trialStartedAt + 7 * DAY } });
    // The plan is read again right when the trial ends.
    expect((await fakeBrowser.alarms.get(TRIAL_END_ALARM))?.scheduledTime).toBe(trial.trial!.endsAt + 30_000);

    account.trialStartedAt = Date.now() - 8 * DAY;
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'free', trial: null, trialUsed: true, email: EMAIL });
    const ended = await planEnded.get();
    expect(ended).toMatchObject({ tier: 'pro-ai', wasTrial: true });
    expect(await fakeBrowser.alarms.get(TRIAL_END_ALARM)).toBeUndefined();
    // Still Free: the notice isn't set again.
    await refreshPlan({ force: true });
    expect(await planEnded.get()).toEqual(ended);

    account.subscription = { tier: 'pro', interval: 'month', status: 'active' };
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'pro', status: 'active' });
    expect(await planEnded.get()).toBeUndefined();
  });

  it('a cancelled subscription that runs out ends a paid plan', async () => {
    await onPlan('pro-monthly');
    server.account(EMAIL).subscription = { tier: 'pro', interval: 'month', status: 'canceled' };
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'free', email: EMAIL });
    expect(await planEnded.get()).toMatchObject({ tier: 'pro', wasTrial: false });
  });

  it('a plan stored by the previous version still reads, and is read again at once', async () => {
    const old = { tier: 'pro', trial: null, email: 'old@example.com', interval: 'month', status: 'active', cancelAt: null, checkedAt: Date.now() };
    await fakeBrowser.storage.local.set({ plan: old });
    expect(await planState.get()).toEqual({ ...old, trialUsed: false, renewsAt: null, checkedAt: 0 });
    // No device token here: Free, and no "plan ended" notice (this computer isn't signed in).
    expect(await refreshPlan({ maxAgeMs: 60 * 60_000 })).toMatchObject({ tier: 'free', email: null });
    expect(await planEnded.get()).toBeUndefined();
    expect(server.requests).toHaveLength(0);
  });

  it('a build without Pro is always Free, opens nothing and calls nothing', async () => {
    pro.restore();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await planState.set(planOf({ tier: 'pro' }));
    expect(await refreshPlan({ force: true })).toEqual(FREE_PLAN);
    expect(await planState.get()).toEqual(FREE_PLAN);
    expect(await send({ type: 'checkout-open', tier: 'pro', interval: 'month' })).toMatchObject({ ok: false, code: 'not-configured' });
    expect(await send({ type: 'signin-start', email: EMAIL, purpose: 'signin' })).toMatchObject({ ok: false, code: 'not-configured' });
    expect(await send({ type: 'ai-organise' })).toMatchObject({ ok: false, code: 'not-configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------

describe('signing in with an emailed code', () => {
  it('emails a code, signs in with it, and registers the Chrome profile key', async () => {
    server.account(EMAIL, { tier: 'pro-ai', interval: 'year', status: 'active' });
    expect(await send({ type: 'signin-start', email: ' Ada@Example.com ', purpose: 'signin' })).toEqual({ ok: true, data: { sent: true } });
    const token = await peekDeviceToken();
    expect(isToken(token)).toBe(true);
    expect(server.sentCodes).toEqual([{ email: EMAIL, purpose: 'signin' }]);
    expect(server.requests[0]).toMatchObject({ path: '/signin/start', auth: `Bearer ${token}`, body: { email: 'Ada@Example.com', purpose: 'signin' } });

    const result = await send({ type: 'signin-finish', email: EMAIL, code: CODE, startTrial: false });
    expect(result).toMatchObject({
      ok: true,
      data: { plan: { tier: 'pro-ai', interval: 'year', email: EMAIL }, trialStarted: false, trialUsed: false },
    });
    expect(await planState.get()).toMatchObject({ tier: 'pro-ai', email: EMAIL });
    expect(await aiRuns.get()).toEqual(server.runs);
    // Other computers on this Chrome profile can now sign themselves in.
    const key = await synced(PROFILE_KEY);
    expect(isToken(key)).toBe(true);
    // Made on its own, never the device token (the server refuses that).
    expect(key).not.toBe(token);
    expect(server.profileKeys.get(key as string)).toBe(EMAIL);
    expect(paths()).toEqual(['POST /signin/start', 'POST /signin/finish', 'POST /profile']);
    expect(server.requests.every((r) => r.auth === `Bearer ${token}`)).toBe(true);
    expect(await local(SIGNED_OUT_KEY)).toBeUndefined();
  });

  it('a wrong code says how many tries are left; five wrong tries or an old code has expired', async () => {
    await send({ type: 'signin-start', email: EMAIL, purpose: 'signin' });
    expect(await send({ type: 'signin-finish', email: EMAIL, code: '000000', startTrial: false })).toEqual({
      ok: false,
      code: 'wrong-code',
      error: 'That code doesn’t match.',
      details: { triesLeft: 4 },
    });
    for (let i = 0; i < 3; i += 1) await send({ type: 'signin-finish', email: EMAIL, code: '000000', startTrial: false });
    expect(await send({ type: 'signin-finish', email: EMAIL, code: '000000', startTrial: false })).toMatchObject({ ok: false, code: 'code-expired' });
    // Used up: even the right code no longer works.
    expect(await send({ type: 'signin-finish', email: EMAIL, code: CODE, startTrial: false })).toMatchObject({ ok: false, code: 'code-expired' });
    expect(await planState.get()).toMatchObject({ tier: 'free', email: null });
  });

  it('starts the trial with the code, once per email', async () => {
    await send({ type: 'signin-start', email: EMAIL, purpose: 'trial' });
    expect(server.sentCodes[0]).toEqual({ email: EMAIL, purpose: 'trial' });
    const started = await send({ type: 'signin-finish', email: EMAIL, code: CODE, startTrial: true });
    expect(started).toMatchObject({ ok: true, data: { trialStarted: true, trialUsed: false, plan: { tier: 'pro-ai', trial: { endsAt: expect.any(Number) } } } });
    expect(await fakeBrowser.alarms.get(TRIAL_END_ALARM)).toBeDefined();

    // Signed out, and back for another trial with the same email: no.
    await send({ type: 'signout' });
    server.account(EMAIL).trialStartedAt = Date.now() - 10 * DAY;
    await send({ type: 'signin-start', email: EMAIL, purpose: 'trial' });
    const again = await send({ type: 'signin-finish', email: EMAIL, code: CODE, startTrial: true });
    expect(again).toMatchObject({ ok: true, data: { trialStarted: false, trialUsed: true, plan: { tier: 'free', trialUsed: true, email: EMAIL } } });
    // Signed in all the same.
    expect(await planState.get()).toMatchObject({ email: EMAIL });
  });

  it('trial-start starts the trial for a signed-in account without a code', async () => {
    expect(await send({ type: 'trial-start' })).toMatchObject({ ok: false, code: 'not-signed-in' });
    await signedIn(server, null);
    expect(await send({ type: 'trial-start' })).toMatchObject({ ok: true, data: { trialStarted: true, plan: { tier: 'pro-ai' } } });
    expect(await planState.get()).toMatchObject({ tier: 'pro-ai', trial: { startedAt: expect.any(Number) } });
    expect(server.sentCodes).toHaveLength(0);
  });

  it('says why a code couldn’t be sent', async () => {
    expect(await send({ type: 'signin-start', email: 'not an email', purpose: 'signin' })).toMatchObject({ ok: false, code: 'invalid-email' });
    server.overrides.set('POST /signin/start', { status: 429, body: { error: 'rate-limited', message: 'Too many codes.', retryAfter: 1800 } });
    expect(await send({ type: 'signin-start', email: EMAIL, purpose: 'signin' })).toEqual({
      ok: false,
      code: 'rate-limited',
      error: 'Too many codes.',
      details: { retryAfter: 1800 },
    });
    server.overrides.set('POST /signin/start', { status: 502, body: { error: 'send-failed' } });
    expect(await send({ type: 'signin-start', email: EMAIL, purpose: 'signin' })).toMatchObject({ ok: false, code: 'send-failed' });
    server.offline = true;
    expect(await send({ type: 'signin-start', email: EMAIL, purpose: 'signin' })).toMatchObject({ ok: false, code: 'offline' });
  });
});

// ---------------------------------------------------------------------------------------------

describe('the Chrome profile key', () => {
  beforeEach(async () => {
    server.account(EMAIL, { tier: 'pro', interval: 'year', status: 'active' });
    server.profileKeys.set(PROFILE, EMAIL);
  });

  it('another computer on the same Chrome profile signs itself in with it, without a code', async () => {
    await fakeBrowser.storage.sync.set({ [PROFILE_KEY]: PROFILE });
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'pro', email: EMAIL });
    expect(paths()).toEqual(['POST /signin/profile']);
    expect(server.requests[0]!.body).toEqual({ profileKey: PROFILE });
    const token = await peekDeviceToken();
    expect(server.tokens.get(token!)).toBe(EMAIL);
    // Already registered: not sent again.
    expect(server.apiCalls('/profile', 'POST')).toBe(0);
  });

  it('a computer with a token that isn’t signed in reads /me first, then uses the key', async () => {
    await giveToken();
    await fakeBrowser.storage.sync.set({ [PROFILE_KEY]: PROFILE });
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'pro', email: EMAIL });
    expect(paths()).toEqual(['GET /me', 'POST /signin/profile']);
  });

  it('an unknown key is tried once (not again after the worker restarts), and Free stays without a token', async () => {
    await fakeBrowser.storage.sync.set({ [PROFILE_KEY]: 'unknown-key-'.padEnd(43, 'u') });
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'free', email: null });
    expect(await peekDeviceToken()).toBeNull();
    await refreshPlan({ force: true });
    expect(server.requests).toHaveLength(1);
    // 1.0: the server's refusal is remembered on this computer, so a fresh worker doesn't ask again.
    resetPlanRuntime();
    await refreshPlan({ force: true });
    expect(server.requests).toHaveLength(1);
    // A new key (another computer signed in) is tried.
    server.account(EMAIL, { tier: 'pro', interval: 'month', status: 'active' });
    server.profileKeys.set(PROFILE, EMAIL);
    await fakeBrowser.storage.sync.set({ [PROFILE_KEY]: PROFILE });
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'pro', email: EMAIL });
  });

  it('follows the key arriving through Chrome sync (another computer signed in)', async () => {
    setupPlan();
    await vi.waitFor(async () => expect((await planState.get()).checkedAt).toBeGreaterThan(0));
    expect(server.requests).toHaveLength(0);
    await fakeBrowser.storage.sync.set({ [PROFILE_KEY]: PROFILE });
    await vi.waitFor(async () => expect(await planState.get()).toMatchObject({ tier: 'pro', email: EMAIL }));
  });

  it('every sign-in with a code registers the key again, even one that exists (the server may have dropped it)', async () => {
    await signedIn(server, 'pro');
    await fakeBrowser.storage.sync.set({ [PROFILE_KEY]: PROFILE });
    server.profileKeys.clear();
    await send({ type: 'signin-start', email: EMAIL, purpose: 'signin' });
    await send({ type: 'signin-finish', email: EMAIL, code: CODE, startTrial: false });
    expect(await synced(PROFILE_KEY)).toBe(PROFILE);
    expect(server.profileKeys.get(PROFILE)).toBe(EMAIL);
    expect(server.requests.at(-1)).toMatchObject({ path: '/profile', body: { profileKey: PROFILE } });
    // Starting the trial (no code) doesn't.
    const calls = server.apiCalls('/profile', 'POST');
    await send({ type: 'trial-start' });
    expect(server.apiCalls('/profile', 'POST')).toBe(calls);
  });

  it('after signing out here, the key is left alone until the person signs in again', async () => {
    await signedIn(server, 'pro');
    await fakeBrowser.storage.sync.set({ [PROFILE_KEY]: PROFILE });
    expect(await send({ type: 'signout' })).toEqual({ ok: true, data: { ok: true } });
    expect(await local(SIGNED_OUT_KEY)).toBe(true);
    // The key stays for the other computers.
    expect(await synced(PROFILE_KEY)).toBe(PROFILE);
    const before = server.requests.length;
    resetPlanRuntime();
    expect(await refreshPlan({ force: true })).toMatchObject({ tier: 'free', email: null });
    expect(server.requests).toHaveLength(before);

    await send({ type: 'signin-start', email: EMAIL, purpose: 'signin' });
    await send({ type: 'signin-finish', email: EMAIL, code: CODE, startTrial: false });
    expect(await local(SIGNED_OUT_KEY)).toBeUndefined();
    expect(server.profileKeys.get(PROFILE)).toBe(EMAIL);
  });
});

// ---------------------------------------------------------------------------------------------

describe('signing out', () => {
  it('signs out this computer only: Free here with no “plan ended” notice, the token goes, the key stays', async () => {
    await onPlan('pro-ai-yearly');
    server.link('other-computer-'.padEnd(43, 'o'));
    await fakeBrowser.storage.sync.set({ [PROFILE_KEY]: PROFILE });
    await aiRuns.set(server.runs);

    expect(await send({ type: 'signout' })).toEqual({ ok: true, data: { ok: true } });
    expect(server.requests.at(-1)).toMatchObject({ method: 'POST', path: '/signout', auth: `Bearer ${TOKEN}` });
    expect(server.tokens.has(TOKEN)).toBe(false);
    expect(server.tokens.size).toBe(1);
    expect(await peekDeviceToken()).toBeNull();
    expect(await planState.get()).toMatchObject({ tier: 'free', email: null, checkedAt: expect.any(Number) });
    expect(await planEnded.get()).toBeUndefined();
    expect(await aiRuns.get()).toBeUndefined();
    expect(await synced(PROFILE_KEY)).toBe(PROFILE);
  });

  it('offline, it signs out here all the same', async () => {
    await onPlan('pro-monthly');
    server.offline = true;
    expect(await send({ type: 'signout' })).toEqual({ ok: true, data: { ok: true } });
    expect(await planState.get()).toMatchObject({ tier: 'free', email: null });
    expect(await peekDeviceToken()).toBeNull();
    expect(await planEnded.get()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe('Stripe Checkout and billing tabs', () => {
  let chrome: FakeChrome;
  let pageTab: number;

  beforeEach(() => {
    chrome = new FakeChrome().install();
    chrome.openWindow(['https://work.com']);
    pageTab = chrome.openWindow([{ url: 'chrome-extension://test/library.html#/pro', active: true }], { focused: true }).tabIds[0]!;
  });

  const stripeTab = () => chrome.tabs.find((t) => t.url.startsWith('https://checkout.stripe.test'));
  const updates = () => vi.mocked(fakeBrowser.tabs.update).mock.calls;
  /** The server sees the payment (webhook or /me asking Stripe) and signs this computer's token in. */
  const pays = async (tier: 'pro' | 'pro-ai' = 'pro', interval: 'month' | 'year' = 'year') => {
    server.account(EMAIL, { tier, interval, status: 'active' });
    server.link((await peekDeviceToken())!);
  };

  it('opens checkout in a tab next to the page, waits, and turns it into the welcome page once paid', async () => {
    expect(await send({ type: 'checkout-open', tier: 'pro', interval: 'year' }, { tabId: pageTab })).toEqual({ ok: true, data: { opened: true } });
    expect(server.checkouts).toMatchObject([{ tier: 'pro', interval: 'year', sessionId: 'cs_test_1' }]);
    const tab = stripeTab()!;
    expect(tab).toMatchObject({ url: server.checkouts[0]!.url, active: true, windowId: chrome.tab(pageTab)!.windowId });
    expect(await checkoutState.get()).toEqual({
      tabId: tab.id,
      sessionId: 'cs_test_1',
      tier: 'pro',
      interval: 'year',
      startedAt: expect.any(Number),
      openerTabId: pageTab,
    });

    // Every 5 seconds while the tab is open: the plan.
    expect(await pollCheckout()).toBe('watching');
    expect(server.apiCalls('/me')).toBe(1);
    await pays();
    expect(await pollCheckout()).toBe('watching');
    expect(await planState.get()).toMatchObject({ tier: 'pro', email: EMAIL });

    // Stripe sends the tab back: it becomes the welcome page.
    await onTabUrl(tab.id, `${API_URL}/checkout/done?session_id=cs_test_1`);
    expect(updates().at(-1)).toEqual([tab.id, { url: 'chrome-extension://test-extension-id/library.html#/pro/welcome' }]);
    expect(await checkoutState.get()).toBeUndefined();
    expect(await checkoutNotice.get()).toBeUndefined();
    // Paying signed this computer in: the profile key is registered for the account.
    expect(server.profileKeys.get((await synced(PROFILE_KEY)) as string)).toBe(EMAIL);
    expect(await pollCheckout()).toBe('idle');
  });

  it('cancel closes the tab, says nothing was charged, and brings the page back', async () => {
    await send({ type: 'checkout-open', tier: 'pro-ai', interval: 'month' }, { tabId: pageTab });
    const tab = stripeTab()!;
    chrome.tab(pageTab)!.active = false;
    await onTabUrl(tab.id, `${API_URL}/checkout/cancel`);
    expect(chrome.tab(tab.id)).toBeUndefined();
    expect(await checkoutState.get()).toBeUndefined();
    expect(await checkoutNotice.get()).toEqual({ kind: 'closed', at: expect.any(Number) });
    expect(chrome.tab(pageTab)!.active).toBe(true);
    expect(chrome.focusCalls.at(-1)).toBe(chrome.tab(pageTab)!.windowId);
  });

  it('closing the Stripe tab without paying says so too; after paying it doesn’t', async () => {
    await send({ type: 'checkout-open', tier: 'pro', interval: 'month' }, { tabId: pageTab });
    let tab = stripeTab()!;
    await fakeBrowser.tabs.remove(tab.id);
    await onTabClosed(tab.id);
    expect(await checkoutState.get()).toBeUndefined();
    expect(await checkoutNotice.get()).toMatchObject({ kind: 'closed' });

    await checkoutNotice.set(null);
    await send({ type: 'checkout-open', tier: 'pro', interval: 'month' }, { tabId: pageTab });
    tab = stripeTab()!;
    await pays('pro', 'month');
    await fakeBrowser.tabs.remove(tab.id);
    await onTabClosed(tab.id);
    expect(await checkoutNotice.get()).toBeUndefined();
    expect(await planState.get()).toMatchObject({ tier: 'pro', status: 'active' });
    // Other tabs closing cost nothing.
    const calls = server.requests.length;
    await onTabClosed(pageTab + 999);
    expect(server.requests).toHaveLength(calls);
  });

  it('“Go to the Stripe tab” brings it to the front; the watch stops after 15 minutes', async () => {
    await send({ type: 'checkout-open', tier: 'pro', interval: 'month' }, { tabId: pageTab });
    const tab = stripeTab()!;
    await fakeBrowser.tabs.update(pageTab, { active: true });
    expect(await send({ type: 'checkout-focus' })).toEqual({ ok: true, data: { focused: true } });
    expect(chrome.tab(tab.id)!.active).toBe(true);
    expect(chrome.focusCalls.at(-1)).toBe(tab.windowId);

    expect(await pollCheckout(Date.now() + CHECKOUT_MAX_MS + 1000)).toBe('done');
    expect(await checkoutState.get()).toBeUndefined();
    expect(await send({ type: 'checkout-focus' })).toEqual({ ok: true, data: { focused: false } });
  });

  it('already paying: Stripe’s billing page opens instead, where plans change', async () => {
    await onPlan('pro-monthly');
    expect(await send({ type: 'checkout-open', tier: 'pro-ai', interval: 'year' }, { tabId: pageTab })).toEqual({ ok: true, data: { opened: true } });
    expect(server.checkouts).toHaveLength(0);
    expect(server.billingSessions).toHaveLength(1);
    expect(chrome.tabs.some((t) => t.url === server.billingSessions[0]!.url)).toBe(true);
    expect(await checkoutState.get()).toBeUndefined();
  });

  it('paid with an email that already had an account: the pages ask to sign in, and nothing says “not charged”', async () => {
    await send({ type: 'checkout-open', tier: 'pro', interval: 'year' }, { tabId: pageTab });
    const tab = stripeTab()!;
    const token = (await peekDeviceToken())!;
    server.account('sam@example.com', { tier: 'pro', interval: 'year', status: 'active' });
    server.paidElsewhere.set(token, 'sam@example.com');
    expect(await pollCheckout()).toBe('watching');
    expect(await needsSignIn.get()).toEqual({ email: 'sam@example.com' });
    expect(await planState.get()).toMatchObject({ tier: 'free', email: null });

    await fakeBrowser.tabs.remove(tab.id);
    await onTabClosed(tab.id);
    expect(await checkoutNotice.get()).toBeUndefined();

    // Signing in with the code clears it.
    await send({ type: 'signin-start', email: 'sam@example.com', purpose: 'signin' });
    expect(await send({ type: 'signin-finish', email: 'sam@example.com', code: CODE, startTrial: false })).toMatchObject({
      ok: true,
      data: { plan: { tier: 'pro', email: 'sam@example.com' } },
    });
    expect(await needsSignIn.get()).toBeUndefined();
  });

  it('billing: back at billing/done the tab closes, the page comes back, and the plan is read again', async () => {
    await onPlan('pro-ai-yearly');
    expect(await send({ type: 'billing-open', flow: 'payment-method' }, { tabId: pageTab })).toEqual({ ok: true, data: { opened: true } });
    expect(server.billingSessions[0]).toMatchObject({ flow: 'payment-method', token: TOKEN });
    const tab = chrome.tabs.find((t) => t.url === server.billingSessions[0]!.url)!;
    expect(tab.active).toBe(true);

    // The person cancels on Stripe's page.
    const cancelAt = Date.now() + 200 * DAY;
    server.account(EMAIL).subscription!.cancelAt = cancelAt;
    await onTabUrl(tab.id, `${API_URL}/billing/done`);
    expect(chrome.tab(tab.id)).toBeUndefined();
    expect(chrome.tab(pageTab)!.active).toBe(true);
    expect(await planState.get()).toMatchObject({ tier: 'pro-ai', cancelAt, renewsAt: null });

    // Never paid: there's no billing page.
    await signedIn(server, null, { email: 'new@example.com' });
    expect(await send({ type: 'billing-open' })).toMatchObject({ ok: false, code: 'needs-pro' });
  });

  it('only the server’s own return pages count', async () => {
    expect(returnPage(`${API_URL}/checkout/done?session_id=cs_1`)).toBe('checkout-done');
    expect(returnPage(`${API_URL}/checkout/cancel`)).toBe('checkout-cancel');
    expect(returnPage(`${API_URL}/billing/done/`)).toBe('billing-done');
    expect(returnPage('https://evil.test/functions/v1/tabfold/checkout/done')).toBeNull();
    expect(returnPage('https://api.tabfold.test/functions/v1/other/checkout/done')).toBeNull();
    expect(returnPage(`${API_URL}/me`)).toBeNull();
    const tab = chrome.tabs[0]!;
    await onTabUrl(tab.id, 'https://example.com/checkout/done');
    expect(chrome.tab(tab.id)).toBeDefined();
    expect(server.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('server client', () => {
  it('maps HTTP errors to ProError codes, with the server’s message or a friendly one', () => {
    const runs = { used: 300, limit: 300, resetsAt: 1 };
    expect(errorFromResponse(400, { error: 'wrong-code', triesLeft: 3 })).toMatchObject({ code: 'wrong-code', details: { triesLeft: 3 } });
    expect(errorFromResponse(400, { error: 'code-expired' }).code).toBe('code-expired');
    expect(errorFromResponse(400, { error: 'invalid-email' }).code).toBe('invalid-email');
    expect(errorFromResponse(400, { error: 'server', message: 'Bad request.' })).toMatchObject({ code: 'server', message: 'Bad request.' });
    expect(errorFromResponse(401, {})).toMatchObject({ code: 'not-signed-in', status: 401, message: PRO_ERROR_MESSAGES['not-signed-in'] });
    expect(errorFromResponse(402, { error: 'needs-pro-ai', message: 'Pro AI only.' })).toMatchObject({ code: 'needs-pro-ai', message: 'Pro AI only.' });
    expect(errorFromResponse(402, null).code).toBe('needs-pro');
    expect(errorFromResponse(409, { error: 'conflict', version: 7 })).toMatchObject({ code: 'conflict', status: 409, body: { version: 7 } });
    expect(errorFromResponse(409, { error: 'already-subscribed' }).code).toBe('already-subscribed');
    expect(errorFromResponse(429, { error: 'runs-used-up', runs })).toMatchObject({ code: 'runs-used-up', body: { runs } });
    expect(errorFromResponse(429, { error: 'rate-limited', retryAfter: 600 })).toMatchObject({ code: 'rate-limited', details: { retryAfter: 600 } });
    expect(errorFromResponse(429, null, '/signin/start').code).toBe('rate-limited');
    expect(errorFromResponse(429, null, '/ai').code).toBe('runs-used-up');
    expect(errorFromResponse(502, null, '/ai').code).toBe('ai-failed');
    expect(errorFromResponse(502, { error: 'send-failed' }).code).toBe('send-failed');
    expect(errorFromResponse(502, null, '/signin/start').code).toBe('send-failed');
    expect(errorFromResponse(502, null, '/checkout').code).toBe('server');
    expect(errorFromResponse(413, { error: 'server', message: 'Too large.' }).message).toBe('Too large.');
    expect(errorFromResponse(500, 'oops')).toMatchObject({ code: 'server', message: PRO_ERROR_MESSAGES.server });
    // A code that doesn't belong to the status isn't trusted.
    expect(errorFromResponse(500, { error: 'wrong-code' }).code).toBe('server');
    expect(errorFromResponse(401, {})).toBeInstanceOf(CommandError);
    expect(errorFromResponse(401, {}).details).toBeUndefined();
  });

  it('sends the device token as a bearer token, made on first use; offline or no Pro build fail clearly', async () => {
    expect(await api('/me')).toMatchObject({ plan: { tier: 'free' } });
    const token = await peekDeviceToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: `${API_URL}/me`, auth: `Bearer ${token}` });
    await api('/me');
    expect(server.requests[1]!.auth).toBe(`Bearer ${token}`);

    server.offline = true;
    await expect(api('/me')).rejects.toMatchObject({ code: 'offline', message: PRO_ERROR_MESSAGES.offline });
    pro.restore();
    await expect(api('/me')).rejects.toBeInstanceOf(ProError);
    await expect(api('/me')).rejects.toMatchObject({ code: 'not-configured' });
  });

  it('a Pro feature without the plan reaches the page as a readable error with its code', async () => {
    await signedIn(server, null);
    expect(await send({ type: 'ai-organise' })).toEqual({ ok: false, code: 'needs-pro-ai', error: PRO_ERROR_MESSAGES['needs-pro-ai'] });
    expect(await send({ type: 'backups-list' })).toMatchObject({ ok: false, code: 'needs-pro' });
    // It read the plan again before saying no (the person may have just paid).
    expect(server.apiCalls('/me')).toBeGreaterThan(0);
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

  it('applies the kept groups into folders: an existing one by name, new ones (source ai), and leaves By site alone', async () => {
    await onPlan('pro-ai-monthly');
    const ids = (await fold(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com', 'https://e.com'], T)).savedTabIds;
    const holiday = (await send({ type: 'folder-create', name: 'Holiday in Lisbon', color: 'green' })) as {
      ok: true;
      data: { folder: import('@/lib/types').FolderRecord };
    };
    const folderId = holiday.data.folder.id;
    // Organise maps a group named like that folder (any case) onto it.
    server.ai = () => ({
      status: 200,
      body: { groups: [{ name: 'holiday in lisbon', tabIds: [ids[2]] }, { name: 'Checkout app', tabIds: [ids[0], ids[1]] }], runs: server.runs },
    });
    const preview = (await send({ type: 'ai-organise' })) as { ok: true; data: import('@/lib/pro/types').OrganiseResult };
    expect(preview.data.groups.map((g) => [g.name, g.folderId ?? null, g.color])).toEqual([
      ['holiday in lisbon', folderId, 'green'],
      ['Checkout app', null, 'purple'],
    ]);

    const groups: AiGroup[] = [
      ...preview.data.groups,
      { name: 'Reading', color: 'yellow', tabIds: [ids[3]!, ids[0]!, 'gone'] },
      { name: 'Empty', color: 'pink', tabIds: ['gone-too'] },
    ];
    expect(await send({ type: 'ai-apply', groups })).toEqual({ ok: true, data: { applied: 4, folders: 2 } });
    const folders = await db.folders.where('deletedAt').equals(0).toArray();
    expect(folders.map((f) => [f.name, f.source]).sort()).toEqual([
      ['Checkout app', 'ai'],
      ['Holiday in Lisbon', 'person'],
      ['Reading', 'ai'],
    ]);
    const byName = new Map(folders.map((f) => [f.name, f.id]));
    const placed = new Map((await db.tabs.toArray()).map((t) => [t.id, t.folderId]));
    // A tab listed twice stays in the first group; tabs in no group stay by site.
    expect(ids.map((id) => placed.get(id))).toEqual([
      byName.get('Checkout app'),
      byName.get('Checkout app'),
      folderId,
      byName.get('Reading'),
      undefined,
    ]);
    expect((await db.tabs.get(ids[0]!))!.placedAt).toBeGreaterThan(0);
    expect(await projectsState.get()).toEqual({ projects: [], organisedAt: 0 });
    expect((await getSettings()).groupBy).toBe('site');

    // The next Organise only sends tabs that aren't in a folder.
    server.ai = () => ({ status: 200, body: { groups: [], runs: server.runs } });
    await send({ type: 'ai-organise' });
    expect(server.aiRequests.at(-1)!.tabs.map((t) => t.id)).toEqual([ids[4]]);
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
    await planState.set(planOf({ tier: 'pro' }));
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

  it('puts restored tabs back in their folders when those folders still exist', async () => {
    await onPlan('pro-monthly');
    const kept = (await send({ type: 'folder-create', name: 'Kept' })) as { ok: true; data: { folder: { id: string } } };
    const folderId = kept.data.folder.id;
    const records: SyncRecord[] = [
      { id: syncId('a'), url: 'https://in-folder.com', title: 'In', savedAt: toSyncTime(T), keywords: [], folderId, placedAt: toSyncTime(T) },
      { id: syncId('b'), url: 'https://gone-folder.com', title: 'Gone', savedAt: toSyncTime(T - 1000), keywords: [], folderId: 'zzzzzzzzzzzz' },
    ];
    server.backups.set('2026-10-08', { items: pack(records, [], { floor: 0, limits: CLOUD_LIMITS }).items, tabCount: 2, createdAt: T });
    expect(await send({ type: 'backup-restore', day: '2026-10-08' })).toMatchObject({ ok: true, data: { restored: 2 } });
    const tabs = await listFoldedTabs();
    expect(tabs.find((t) => t.url === 'https://in-folder.com')!.folderId).toBe(folderId);
    expect(tabs.find((t) => t.url === 'https://gone-folder.com')!.folderId).toBeUndefined();
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
