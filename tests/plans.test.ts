import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { route } from '@/lib/background/router';
import { peekDeviceToken } from '@/lib/pro/account';
import { checkoutBody, isPaid, onTabClosed } from '@/lib/pro/checkout';
import { applyPlan } from '@/lib/pro/plan';
import { checkoutNotice, planEnded, planState, readPlan } from '@/lib/pro/state';
import { FREE_PLAN, type PlanState } from '@/lib/pro/types';
import { FakeChrome } from './chrome';
import { EMAIL, installPro, planOf, signedIn, type FakeServer } from './proServer';

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

const TEAM = { id: 'team_1', name: 'Truewidgets', role: 'owner' as const, seats: 3 };

describe('readPlan: Pro for life and Teams', () => {
  it('reads lifetime and team, and leaves older plans exactly as they were', () => {
    const base = { ...FREE_PLAN, tier: 'pro', email: EMAIL, checkedAt: 5 };
    expect(readPlan({ ...base, lifetime: true })).toEqual({ ...base, lifetime: true });
    expect(readPlan({ ...base, tier: 'pro-ai', team: TEAM })).toEqual({ ...base, tier: 'pro-ai', team: TEAM });
    const plain = readPlan(base)!;
    expect('lifetime' in plain || 'team' in plain).toBe(false);
    // Anything odd is left out rather than trusted.
    expect(readPlan({ ...base, lifetime: 'yes', team: { id: 'x', name: 'X', role: 'boss', seats: 2 } })).toEqual(base);
    expect(readPlan({ ...base, team: null })).toEqual(base);
    expect(readPlan({ ...base, team: { ...TEAM, seats: 'many', name: 'N'.repeat(80) } })!.team).toEqual({ ...TEAM, seats: 1, name: 'N'.repeat(60) });
  });

  it('a lifetime or team plan counts as paid', () => {
    expect(isPaid(planOf({ tier: 'pro', lifetime: true, status: null, renewsAt: null, interval: null }))).toBe(true);
    expect(isPaid(planOf({ tier: 'pro-ai', team: { ...TEAM, role: 'member' }, status: null }))).toBe(true);
    expect(isPaid(planOf({ tier: 'pro-ai', trial: { startedAt: 1, endsAt: 2 } }))).toBe(false);
  });
});

describe('a plan ending', () => {
  const member = (patch: Partial<PlanState> = {}) => planOf({ tier: 'pro-ai', team: { ...TEAM, role: 'member' }, status: null, interval: null, ...patch });

  it('a team ending leaves the notice only when the person ends up Free', async () => {
    await applyPlan(member());
    await applyPlan(planOf({ tier: 'free' }));
    expect(await planEnded.get()).toMatchObject({ tier: 'pro-ai', wasTrial: false });

    await planEnded.set(null);
    await applyPlan(member());
    // They had Pro for life too: still Pro, no notice.
    await applyPlan(planOf({ tier: 'pro', lifetime: true, status: null, interval: null }));
    expect(await planEnded.get()).toBeUndefined();
    await applyPlan(planOf({ tier: 'free' }));
    expect(await planEnded.get()).toMatchObject({ tier: 'pro' });
    // Joining a team again clears it.
    await applyPlan(member());
    expect(await planEnded.get()).toBeUndefined();
  });
});

describe('checkout for Pro for life and Teams', () => {
  it('builds the body: one payment for life, seats and a name for a team', () => {
    expect(checkoutBody('pro-lifetime', 'year')).toEqual({ tier: 'pro-lifetime' });
    expect(checkoutBody('pro', 'month')).toEqual({ tier: 'pro', interval: 'month' });
    expect(checkoutBody('teams', 'year', { seats: 5, teamName: '  Truewidgets ' })).toEqual({ tier: 'teams', interval: 'year', seats: 5, teamName: 'Truewidgets' });
    expect(checkoutBody('teams', 'month')).toEqual({ tier: 'teams', interval: 'month', seats: 3 });
    expect(checkoutBody('teams', 'month', { seats: 500, teamName: '' })).toEqual({ tier: 'teams', interval: 'month', seats: 100 });
    expect(checkoutBody('teams', 'month', { seats: 0 })).toMatchObject({ seats: 1 });
  });

  it('opens Stripe for Pro for life without a period, and closing the tab after paying says nothing about "not charged"', async () => {
    const chrome = new FakeChrome().install();
    const page = chrome.openWindow([{ url: 'chrome-extension://test/library.html#/pro', active: true }], { focused: true }).tabIds[0]!;
    expect(await route({ type: 'checkout-open', tier: 'pro-lifetime', interval: 'year' }, { tabId: page })).toEqual({ ok: true, data: { opened: true } });
    const sent = server.requests.find((r) => r.path === '/checkout')!;
    expect(sent.body).toEqual({ tier: 'pro-lifetime' });

    // Paid: the server now says Pro for life (no subscription).
    const tab = chrome.tabs.find((t) => t.url.startsWith('https://checkout.stripe.test'))!;
    const planFor = server.planFor.bind(server);
    vi.spyOn(server, 'planFor').mockImplementation((email, now) => ({ ...planFor(email, now), tier: 'pro', lifetime: true, email: EMAIL }));
    server.link((await peekDeviceToken())!);
    chrome.tabs = chrome.tabs.filter((t) => t.id !== tab.id);
    await onTabClosed(tab.id);
    expect(await checkoutNotice.get()).toBeUndefined();
    expect(await planState.get()).toMatchObject({ tier: 'pro', lifetime: true });
  });

  it('Pro for life bought already: says so instead of opening billing', async () => {
    await signedIn(server, 'pro');
    new FakeChrome().install().openWindow(['https://a.com'], { focused: true });
    expect(await route({ type: 'checkout-open', tier: 'pro-lifetime', interval: 'year' })).toMatchObject({
      ok: false,
      code: 'already-subscribed',
      error: 'You already have Tabfold Pro for life.',
    });
  });

  it('opens Stripe for a team with its seats and name', async () => {
    new FakeChrome().install().openWindow(['https://a.com'], { focused: true });
    await route({ type: 'checkout-open', tier: 'teams', interval: 'year', seats: 4, teamName: 'Truewidgets' });
    expect(server.requests.find((r) => r.path === '/checkout')!.body).toEqual({ tier: 'teams', interval: 'year', seats: 4, teamName: 'Truewidgets' });
  });
});
