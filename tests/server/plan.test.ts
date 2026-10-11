import { describe, expect, it } from 'vitest';
import {
  AI_MAX_TABS,
  AI_MAX_TITLE,
  AI_RUNS_PER_MONTH,
  bestSubscription,
  hasPro,
  hasProAi,
  planFor,
  tierOfLookupKey,
  TRIAL_DAYS,
  type PlanInput,
  type Subscription,
} from '../../server/supabase/functions/_shared/plan.ts';
import { DAY, NOW } from './fakes';

let ids = 0;
const sub = (patch: Partial<Subscription> = {}): Subscription => ({
  id: `sub_${++ids}`,
  customerId: 'cus_1',
  status: 'active',
  lookupKey: 'pro-monthly',
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
    expect(plan({ subscriptions: [sub({ lookupKey: 'pro-ai-yearly', interval: 'year' })] })).toMatchObject({
      tier: 'pro-ai',
      interval: 'year',
    });
  });

  it('counts trialing as active, renewing when Stripe’s trial ends', () => {
    const trialEnd = NOW + 3 * DAY;
    expect(plan({ subscriptions: [sub({ status: 'trialing', lookupKey: 'pro-ai-monthly', trialEnd, currentPeriodEnd: trialEnd })] })).toMatchObject({
      tier: 'pro-ai',
      status: 'active',
      renewsAt: trialEnd,
      trial: null,
    });
    // No trial_end: the period end.
    expect(plan({ subscriptions: [sub({ status: 'trialing', trialEnd: null })] }).renewsAt).toBe(NOW + 20 * DAY);
  });

  it('keeps the plan while past due', () => {
    expect(plan({ subscriptions: [sub({ status: 'past_due', lookupKey: 'pro-ai-monthly' })] })).toMatchObject({
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
    const pro = sub({ lookupKey: 'pro-yearly', interval: 'year', createdAt: NOW - DAY });
    const ai = sub({ lookupKey: 'pro-ai-monthly', createdAt: NOW - 5 * DAY });
    const oldAi = sub({ lookupKey: 'pro-ai-monthly', createdAt: NOW - 50 * DAY, cancelAtPeriodEnd: true });
    const deadAi = sub({ lookupKey: 'pro-ai-yearly', status: 'canceled', createdAt: NOW });
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
    expect(tierOfLookupKey('pro-monthly')).toBe('pro');
    expect(tierOfLookupKey('pro-yearly')).toBe('pro');
    expect(tierOfLookupKey('pro-ai-monthly')).toBe('pro-ai');
    expect(tierOfLookupKey('pro-ai-yearly')).toBe('pro-ai');
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
