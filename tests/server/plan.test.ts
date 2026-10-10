import { describe, expect, it } from 'vitest';
import * as extension from '@/lib/pro/tiers';
import * as extensionTypes from '@/lib/pro/types';
import * as server from '../../server/supabase/functions/_shared/plan.ts';
import { DAY, NOW, USERS } from './fakes';

// The server keeps its own copy of the plan rules (an Edge Function can't import src/). These
// tests hold the two copies together.

const MOMENTS = {
  now: NOW,
  'a day later': NOW + DAY,
  'six days later': NOW + 6 * DAY,
  'a month later': NOW + 30 * DAY,
};

const EXTRA_USERS: Record<string, server.ExtPayUser> = {
  'nothing known': { paid: false },
  'paid, no plan details': { paid: true, email: 'x@example.com' },
  'paid once': { paid: true, email: 'x@example.com', plan: { nickname: 'pro-ai-lifetime', interval: 'once' } },
  'bad dates': { paid: false, email: 'x@example.com', trialStartedAt: 'not a date', subscriptionCancelAt: '' },
  'ai nickname with underscores': { paid: true, email: 'x@example.com', plan: { nickname: 'PRO_AI_MONTHLY' } },
  'nickname containing "ai" inside a word': { paid: true, email: 'x@example.com', plan: { nickname: 'pro-trail' } },
};

const TABLE: [string, server.ExtPayUser][] = [...Object.entries(USERS), ...Object.entries(EXTRA_USERS)];

describe('server plan rules match the extension', () => {
  for (const [name, user] of TABLE) {
    for (const [when, now] of Object.entries(MOMENTS)) {
      it(`${name}, ${when}`, () => {
        const fromServer = server.planFromUser(user, now);
        // The same type both ways, so the server's PlanState can't drift from the extension's.
        const asExtension: extensionTypes.PlanState = fromServer;
        const asServer: server.PlanState = extension.planFromUser(user, now);
        expect(asExtension).toEqual(asServer);
        expect(server.hasPro(fromServer)).toBe(extension.hasPro(asServer));
        expect(server.hasProAi(fromServer)).toBe(extension.hasProAi(asServer));
      });
    }
  }

  it('gives the expected tiers', () => {
    const tier = (user: server.ExtPayUser, now = NOW) => server.planFromUser(user, now).tier;
    expect(tier(USERS.free)).toBe('free');
    expect(tier(USERS.proMonthly)).toBe('pro');
    expect(tier(USERS.proYearly)).toBe('pro');
    expect(tier(USERS.proAiMonthly)).toBe('pro-ai');
    expect(tier(USERS.proAiYearly)).toBe('pro-ai');
    expect(tier(USERS.trialRunning)).toBe('pro-ai');
    expect(tier(USERS.trialRunning, NOW + 6 * DAY)).toBe('free');
    expect(tier(USERS.trialEnded)).toBe('free');
    expect(tier(USERS.proDuringTrial)).toBe('pro-ai');
    expect(tier(USERS.proDuringTrial, NOW + 7 * DAY)).toBe('pro');
    expect(tier(USERS.cancelled)).toBe('free');
    expect(tier(USERS.pastDue)).toBe('pro-ai');
    expect(server.planFromUser(USERS.noEmail, NOW).email).toBeNull();
  });

  it('reads plan nicknames the same way', () => {
    for (const nickname of ['pro-monthly', 'pro-yearly', 'pro-ai-monthly', 'pro-ai-yearly', 'ai', 'Pro AI', '', null, undefined]) {
      expect(server.tierOfNickname(nickname)).toBe(extension.tierOfNickname(nickname));
    }
  });

  it('uses the same limits', () => {
    expect(server.TRIAL_DAYS).toBe(extensionTypes.TRIAL_DAYS);
    expect(server.AI_RUNS_PER_MONTH).toBe(extensionTypes.AI_RUNS_PER_MONTH);
    expect(server.AI_MAX_TABS).toBe(extensionTypes.AI_MAX_TABS);
    expect(server.AI_MAX_TITLE).toBe(extensionTypes.AI_MAX_TITLE);
  });
});
