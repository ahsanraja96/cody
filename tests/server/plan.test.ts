import { describe, expect, it } from 'vitest';
import {
  AI_MAX_TABS,
  AI_MAX_TITLE,
  AI_RUNS_PER_MONTH,
  bestSubscription,
  hasPro,
  hasProAi,
  isLive,
  LIFETIME_LOOKUP_KEY,
  planFor,
  TEAMS_LOOKUP_KEYS,
  tierOfLookupKey,
  TRIAL_DAYS,
  type PlanInput,
  type Purchase,
  type Subscription,
  type TeamInput,
  type TeamRole,
} from '../../server/supabase/functions/_shared/plan.ts';
import { DAY, NOW } from './fakes';

let ids = 0;
const sub = (patch: Partial<Subscription> = {}): Subscription => ({
  id: `sub_${++ids}`,
  customerId: 'cus_1',
  status: 'active',
  lookupKey: 'tabfold-pro-monthly',
  interval: 'month',
  currentPeriodEnd: NOW + 20 * DAY,
  cancelAt: null,
  cancelAtPeriodEnd: false,
  trialEnd: null,
  createdAt: NOW - 10 * DAY,
  ...patch,
});

const account = (trialStartedAt: number | null = null) => ({ email: 'sam@example.com', trialStartedAt });
const plan = (input: Partial<PlanInput>, now = NOW) => planFor({ account: account(), subscriptions: [], ...input }, now);

describe('planFor', () => {
  it('is Free when signed out', () => {
    expect(planFor({ account: null, subscriptions: [] }, NOW)).toEqual({
      tier: 'free',
      trial: null,
      trialUsed: false,
      email: null,
      interval: null,
      status: null,
      cancelAt: null,
      renewsAt: null,
      checkedAt: NOW,
    });
  });

  it('is Free, with the email, when signed in without a plan', () => {
    expect(plan({})).toEqual({
      tier: 'free',
      trial: null,
      trialUsed: false,
      email: 'sam@example.com',
      interval: null,
      status: null,
      cancelAt: null,
      renewsAt: null,
      checkedAt: NOW,
    });
  });

  it('gives the tier, period and next charge of an active subscription', () => {
    expect(plan({ subscriptions: [sub()] })).toMatchObject({
      tier: 'pro',
      interval: 'month',
      status: 'active',
      cancelAt: null,
      renewsAt: NOW + 20 * DAY,
      trial: null,
    });
    expect(plan({ subscriptions: [sub({ lookupKey: 'tabfold-pro-ai-yearly', interval: 'year' })] })).toMatchObject({
      tier: 'pro-ai',
      interval: 'year',
    });
  });

  it('counts trialing as active, renewing when Stripe’s trial ends', () => {
    const trialEnd = NOW + 3 * DAY;
    expect(plan({ subscriptions: [sub({ status: 'trialing', lookupKey: 'tabfold-pro-ai-monthly', trialEnd, currentPeriodEnd: trialEnd })] })).toMatchObject({
      tier: 'pro-ai',
      status: 'active',
      renewsAt: trialEnd,
      trial: null,
    });
    // No trial_end: the period end.
    expect(plan({ subscriptions: [sub({ status: 'trialing', trialEnd: null })] }).renewsAt).toBe(NOW + 20 * DAY);
  });

  it('keeps the plan while past due', () => {
    expect(plan({ subscriptions: [sub({ status: 'past_due', lookupKey: 'tabfold-pro-ai-monthly' })] })).toMatchObject({
      tier: 'pro-ai',
      status: 'past_due',
      renewsAt: NOW + 20 * DAY,
    });
  });

  it.each(['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])('ignores a %s subscription', (status) => {
    expect(plan({ subscriptions: [sub({ status })] })).toMatchObject({ tier: 'free', status: null, interval: null, renewsAt: null });
  });

  it('ignores prices that aren’t Tabfold’s', () => {
    expect(plan({ subscriptions: [sub({ lookupKey: 'other-monthly' }), sub({ lookupKey: null })] }).tier).toBe('free');
  });

  it('reads cancel_at, or the period end with cancel_at_period_end; no next charge then', () => {
    expect(plan({ subscriptions: [sub({ cancelAt: NOW + 5 * DAY })] })).toMatchObject({
      tier: 'pro',
      status: 'active',
      cancelAt: NOW + 5 * DAY,
      renewsAt: null,
    });
    expect(plan({ subscriptions: [sub({ cancelAtPeriodEnd: true })] })).toMatchObject({
      cancelAt: NOW + 20 * DAY,
      renewsAt: null,
    });
    expect(plan({ subscriptions: [sub({ cancelAtPeriodEnd: true, cancelAt: NOW + 2 * DAY })] }).cancelAt).toBe(NOW + 2 * DAY);
  });

  it('picks the best of several: Pro AI over Pro, then the latest', () => {
    const pro = sub({ lookupKey: 'tabfold-pro-yearly', interval: 'year', createdAt: NOW - DAY });
    const ai = sub({ lookupKey: 'tabfold-pro-ai-monthly', createdAt: NOW - 5 * DAY });
    const oldAi = sub({ lookupKey: 'tabfold-pro-ai-monthly', createdAt: NOW - 50 * DAY, cancelAtPeriodEnd: true });
    const deadAi = sub({ lookupKey: 'tabfold-pro-ai-yearly', status: 'canceled', createdAt: NOW });
    expect(bestSubscription([pro, oldAi, ai, deadAi])).toBe(ai);
    expect(plan({ subscriptions: [pro, deadAi] })).toMatchObject({ tier: 'pro', interval: 'year' });
    expect(bestSubscription([sub({ createdAt: 1 }), pro])).toBe(pro);
    expect(bestSubscription([])).toBeNull();
  });

  it('runs the server trial for 7 days: Pro AI, no subscription fields', () => {
    const started = NOW - 2 * DAY;
    expect(plan({ account: account(started) })).toEqual({
      tier: 'pro-ai',
      trial: { startedAt: started, endsAt: started + 7 * DAY },
      trialUsed: true,
      email: 'sam@example.com',
      interval: null,
      status: null,
      cancelAt: null,
      renewsAt: null,
      checkedAt: NOW,
    });
    expect(plan({ account: account(started) }, started + 7 * DAY - 1).tier).toBe('pro-ai');
  });

  it('is Free once the trial has ended, with trialUsed', () => {
    const started = NOW - 8 * DAY;
    expect(plan({ account: account(started) })).toMatchObject({ tier: 'free', trial: null, trialUsed: true });
    expect(plan({ account: account(NOW - 2 * DAY) }, NOW + 5 * DAY).tier).toBe('free');
  });

  it('lets a live subscription win over a running trial', () => {
    const started = NOW - DAY;
    expect(plan({ account: account(started), subscriptions: [sub()] })).toMatchObject({
      tier: 'pro',
      trial: null,
      trialUsed: true,
      status: 'active',
    });
    // A cancelled subscription doesn't hide the trial.
    expect(plan({ account: account(started), subscriptions: [sub({ status: 'canceled' })] })).toMatchObject({
      tier: 'pro-ai',
      trial: { startedAt: started, endsAt: started + 7 * DAY },
    });
  });

  it('works out the plan at the time given', () => {
    expect(plan({}, NOW + 123).checkedAt).toBe(NOW + 123);
  });
});

describe('plan helpers', () => {
  it('reads lookup keys', () => {
    expect(tierOfLookupKey('tabfold-pro-monthly')).toBe('pro');
    expect(tierOfLookupKey('tabfold-pro-yearly')).toBe('pro');
    expect(tierOfLookupKey('tabfold-pro-ai-monthly')).toBe('pro-ai');
    expect(tierOfLookupKey('tabfold-pro-ai-yearly')).toBe('pro-ai');
    for (const other of ['', null, undefined, 'team-monthly', 'pro', 'ai-pro-monthly']) expect(tierOfLookupKey(other)).toBeNull();
  });

  it('says what each tier includes', () => {
    expect([hasPro({ tier: 'free' }), hasPro({ tier: 'pro' }), hasPro({ tier: 'pro-ai' })]).toEqual([false, true, true]);
    expect([hasProAi({ tier: 'free' }), hasProAi({ tier: 'pro' }), hasProAi({ tier: 'pro-ai' })]).toEqual([false, false, true]);
  });

  it('keeps the limits', () => {
    expect([TRIAL_DAYS, AI_RUNS_PER_MONTH, AI_MAX_TABS, AI_MAX_TITLE]).toEqual([7, 300, 300, 200]);
  });
});

describe('planFor: Pro for life and Teams', () => {
  const lifetime: Purchase = { id: 'cs_1', lookupKey: 'tabfold-pro-lifetime', customerId: 'cus_1', paymentIntentId: 'pi_1', createdAt: NOW - DAY };
  const teamSub = (patch: Partial<Subscription> = {}) =>
    sub({ lookupKey: 'tabfold-teams-yearly', interval: 'year', quantity: 5, itemId: 'si_1', currentPeriodEnd: NOW + 200 * DAY, ...patch });
  const team = (role: TeamRole, subscription: Subscription | null = teamSub()): TeamInput => ({
    id: 'team-1',
    name: 'Truewidgets',
    role,
    seats: subscription?.quantity ?? 1,
    subscription,
  });

  it('gives Pro for life alone: Pro, nothing renews', () => {
    expect(plan({ purchases: [lifetime] })).toEqual({
      tier: 'pro',
      trial: null,
      trialUsed: false,
      email: 'sam@example.com',
      interval: null,
      status: null,
      cancelAt: null,
      renewsAt: null,
      checkedAt: NOW,
      lifetime: true,
    });
  });

  it('ignores purchases of anything else', () => {
    expect(plan({ purchases: [{ ...lifetime, lookupKey: 'other' }] })).toMatchObject({ tier: 'free' });
    expect(plan({ purchases: [{ ...lifetime, lookupKey: 'other' }] }).lifetime).toBeUndefined();
  });

  it('lets a Pro AI subscription on top of Pro for life give Pro AI', () => {
    expect(plan({ purchases: [lifetime], subscriptions: [sub({ lookupKey: 'tabfold-pro-ai-monthly' })] })).toMatchObject({
      tier: 'pro-ai',
      lifetime: true,
      interval: 'month',
      status: 'active',
      renewsAt: NOW + 20 * DAY,
    });
    // A Pro subscription adds nothing, but still shows (it renews).
    expect(plan({ purchases: [lifetime], subscriptions: [sub()] })).toMatchObject({ tier: 'pro', lifetime: true, renewsAt: NOW + 20 * DAY });
  });

  it('lets the trial give Pro AI on top of Pro for life, then falls back to Pro', () => {
    const started = NOW - 2 * DAY;
    expect(plan({ account: account(started), purchases: [lifetime] })).toMatchObject({
      tier: 'pro-ai',
      lifetime: true,
      trial: { startedAt: started, endsAt: started + 7 * DAY },
    });
    expect(plan({ account: account(started), purchases: [lifetime] }, started + 8 * DAY)).toMatchObject({ tier: 'pro', lifetime: true, trial: null });
  });

  it('keeps Pro for life when a subscription ends', () => {
    expect(plan({ purchases: [lifetime], subscriptions: [sub({ lookupKey: 'tabfold-pro-ai-yearly', status: 'canceled' })] })).toMatchObject({
      tier: 'pro',
      status: null,
      lifetime: true,
    });
  });

  it('never takes the lifetime price or a team’s for a personal subscription', () => {
    expect(tierOfLookupKey('tabfold-pro-lifetime')).toBeNull();
    expect(tierOfLookupKey('tabfold-teams-monthly')).toBeNull();
    expect(plan({ subscriptions: [teamSub()] })).toMatchObject({ tier: 'free', status: null });
  });

  it('gives a team member Pro AI and the team, with no billing of their own', () => {
    expect(plan({ team: team('member') })).toEqual({
      tier: 'pro-ai',
      trial: null,
      trialUsed: false,
      email: 'sam@example.com',
      interval: null,
      status: null,
      cancelAt: null,
      renewsAt: null,
      checkedAt: NOW,
      team: { id: 'team-1', name: 'Truewidgets', role: 'member', seats: 5 },
    });
  });

  it('shows a member’s own subscription, if they keep one', () => {
    expect(plan({ team: team('member'), subscriptions: [sub()] })).toMatchObject({
      tier: 'pro-ai',
      interval: 'month',
      status: 'active',
      renewsAt: NOW + 20 * DAY,
      team: { role: 'member' },
    });
  });

  it('describes the team’s subscription for its owner', () => {
    expect(plan({ team: team('owner'), subscriptions: [teamSub()] })).toMatchObject({
      tier: 'pro-ai',
      interval: 'year',
      status: 'active',
      renewsAt: NOW + 200 * DAY,
      team: { id: 'team-1', role: 'owner', seats: 5 },
    });
    const cancelling = teamSub({ cancelAtPeriodEnd: true });
    expect(plan({ team: team('owner', cancelling) })).toMatchObject({ cancelAt: NOW + 200 * DAY, renewsAt: null });
  });

  it('keeps a past-due team on, and says so to its owner', () => {
    const late = teamSub({ status: 'past_due' });
    expect(plan({ team: team('owner', late) })).toMatchObject({ tier: 'pro-ai', status: 'past_due', team: { role: 'owner' } });
    expect(plan({ team: team('member', late) })).toMatchObject({ tier: 'pro-ai', status: null, team: { role: 'member' } });
  });

  it('falls back to each person’s own plan when the team’s subscription ends', () => {
    const ended = teamSub({ status: 'canceled', endedAt: NOW - DAY });
    expect(plan({ team: team('member', ended) })).toMatchObject({ tier: 'free', status: null });
    expect(plan({ team: team('member', ended) }).team).toBeUndefined();
    expect(plan({ team: team('member', ended), subscriptions: [sub()] })).toMatchObject({ tier: 'pro', status: 'active' });
    expect(plan({ team: team('member', ended), purchases: [lifetime] })).toMatchObject({ tier: 'pro', lifetime: true });
    expect(plan({ team: team('owner', ended), subscriptions: [ended] })).toMatchObject({ tier: 'free', status: null, renewsAt: null });
    expect(plan({ team: team('member', null) })).toMatchObject({ tier: 'free' });
  });

  it('keeps the trial for later while a team is on', () => {
    const started = NOW - DAY;
    expect(plan({ account: account(started), team: team('member') })).toMatchObject({ tier: 'pro-ai', trial: null, trialUsed: true });
    expect(plan({ account: account(started), team: team('member', teamSub({ status: 'canceled' })) })).toMatchObject({
      tier: 'pro-ai',
      trial: { startedAt: started },
    });
  });

  it('puts it all together: lifetime, a team and a trial', () => {
    expect(plan({ account: account(NOW - DAY), purchases: [lifetime], team: team('owner'), subscriptions: [teamSub()] })).toMatchObject({
      tier: 'pro-ai',
      lifetime: true,
      trial: null,
      status: 'active',
      interval: 'year',
      team: { role: 'owner' },
    });
  });

  it('is still Free when signed out, whatever else is given', () => {
    expect(planFor({ account: null, subscriptions: [], purchases: [lifetime], team: team('owner') }, NOW)).toMatchObject({ tier: 'free', email: null });
  });

  it('knows which subscriptions are live', () => {
    for (const status of ['active', 'trialing', 'past_due']) expect(isLive(sub({ status }))).toBe(true);
    for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) expect(isLive(sub({ status }))).toBe(false);
    expect(isLive(null)).toBe(false);
  });

  it('names the new prices', () => {
    expect([LIFETIME_LOOKUP_KEY, TEAMS_LOOKUP_KEYS.month, TEAMS_LOOKUP_KEYS.year]).toEqual(['tabfold-pro-lifetime', 'tabfold-teams-monthly', 'tabfold-teams-yearly']);
  });
});
