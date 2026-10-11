import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanEmail, countTabs, LIMITS, newCode, sha256Hex } from '../../server/supabase/functions/tabfold/app.ts';
import { createStripe, signWebhook } from '../../server/supabase/functions/tabfold/stripe.ts';
import { createServer, DAY, EXTENSION, keyOf, newToken, NOW, PUBLIC_URL, type Server } from './fakes';

let server: Server;

beforeEach(async () => {
  server = createServer();
  await server.ready;
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A sync chunk of `n` packed records, as the extension writes them. */
const chunk = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => [`${(from + i).toString(16).padStart(12, '0')}`, `https://example.com/${from + i}`, `Page ${from + i}`, 1_790_000_000]);

const me = (key: string | null) => server.request('GET', '/me', { key });
const start = (key: string, email: string, purpose = 'signin') => server.request('POST', '/signin/start', { key, body: { email, purpose } });
const finish = (key: string, email: string, code: string | null, startTrial = false) =>
  server.request('POST', '/signin/finish', { key, body: { email, code, startTrial } });
const checkout = (key: string | null, tier = 'pro-ai', interval = 'month') =>
  server.request('POST', '/checkout', { key, body: { tier, interval } });
/** The linked account's email for a device token, or null. */
const linkedEmail = async (token: string) => server.store.linkedAccount(await sha256Hex(token))?.email ?? null;

describe('device tokens', () => {
  it('refuses a request without a token', async () => {
    const res = await me(null);
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'not-signed-in', message: expect.any(String) });
  });

  it.each([
    ['another scheme', 'Basic abcdefghijklmnopabcdefghijklmnopabcdefghij'],
    ['a short token', 'Bearer abc123'],
    ['odd characters', `Bearer ${'a'.repeat(40)}.$`],
    ['a very long token', `Bearer ${'a'.repeat(129)}`],
  ])('refuses %s', async (_name, authorization) => {
    const res = await server.request('GET', '/me', { key: null, headers: { authorization } });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('not-signed-in');
  });

  it('answers Free to a token it doesn’t know', async () => {
    const res = await me(newToken('stranger'));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      plan: { tier: 'free', trial: null, trialUsed: false, email: null, interval: null, status: null, cancelAt: null, renewsAt: null, checkedAt: NOW },
      runs: null,
    });
  });

  it('shows a signed-in account’s plan', async () => {
    expect((await me('free')).json.plan).toMatchObject({ tier: 'free', email: 'free@example.com' });
    const ai = await me('proAiMonthly');
    expect(ai.json.plan).toMatchObject({ tier: 'pro-ai', email: 'ai@example.com', interval: 'month', status: 'active', cancelAt: null });
    expect(ai.json.plan.renewsAt).toBeGreaterThan(NOW);
    expect(ai.json.runs).toEqual({ used: 0, limit: 300, resetsAt: Date.UTC(2026, 10, 1) });
    const yearly = await me('proAiYearly');
    expect(yearly.json.plan).toMatchObject({ tier: 'pro-ai', interval: 'year', renewsAt: null });
    expect(yearly.json.plan.cancelAt).toBeGreaterThan(NOW);
  });

  it('gives Pro AI plans their runs', async () => {
    await server.store.setUsage('ai@example.com', { runs: 12, light: 40 });
    expect((await me('proAiMonthly')).json.runs.used).toBe(12);
    expect((await me('proMonthly')).json.runs).toBeNull();
  });

  it('shows a running trial', async () => {
    const res = await me('trialRunning');
    expect(res.json.plan).toMatchObject({ tier: 'pro-ai', trial: { startedAt: NOW - 2 * DAY, endsAt: NOW + 5 * DAY }, trialUsed: true });
    expect(res.json.runs.used).toBe(0);
  });

  it('notes when a computer was last seen', async () => {
    server.clock.now = NOW + HOUR;
    await me('free');
    expect(server.store.devices.get(await sha256Hex(keyOf('free')))!.lastSeenAt).toBe(NOW + HOUR);
  });

  it('refuses Pro routes to a computer that isn’t signed in with 401', async () => {
    for (const [method, path] of [['GET', '/sync'], ['POST', '/sync'], ['GET', '/backups'], ['GET', '/backups/2026-10-10'], ['POST', '/ai']]) {
      const res = await server.request(method!, path!, { key: newToken('stranger'), body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.json.error).toBe('not-signed-in');
    }
  });

  it.each(['free', 'trialEnded', 'cancelled'] as const)('refuses Pro routes to %s with 402 needs-pro', async (user) => {
    for (const path of ['/sync', '/backups', '/backups/2026-10-10']) {
      const res = await server.request('GET', path, { key: user });
      expect(res.status).toBe(402);
      expect(res.json.error).toBe('needs-pro');
    }
  });

  it.each(['free', 'trialEnded', 'cancelled', 'proMonthly', 'proYearly', 'proDuringTrial'] as const)(
    'refuses AI to %s with 402 needs-pro-ai',
    async (user) => {
      const res = await server.request('POST', '/ai', { key: user, body: { task: 'name', tabs: [] } });
      expect(res.status).toBe(402);
      expect(res.json.error).toBe('needs-pro-ai');
      expect(server.callJson).not.toHaveBeenCalled();
    },
  );

  it.each(['proMonthly', 'proYearly', 'proAiMonthly', 'proAiYearly', 'trialRunning', 'proDuringTrial', 'pastDue'] as const)(
    'lets %s sync',
    async (user) => {
      expect((await server.request('GET', '/sync', { key: user })).status).toBe(200);
    },
  );

  it('ends the trial on time', async () => {
    server.clock.now = NOW + 5 * DAY - MINUTE;
    expect((await server.request('POST', '/ai', { key: 'trialRunning', body: { task: 'name', tabs: [] } })).status).toBe(400);
    server.clock.now += 2 * MINUTE;
    expect((await server.request('POST', '/ai', { key: 'trialRunning', body: { task: 'name', tabs: [] } })).status).toBe(402);
  });
});

describe('sign-in codes', () => {
  const token = newToken('laptop');

  it('emails a 6-digit code, the same answer for any email', async () => {
    for (const email of ['  Sam@Example.COM ', 'free@example.com']) {
      const res = await start(token, email, 'trial');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ sent: true });
    }
    expect(server.mailer.sent).toEqual([
      { email: 'sam@example.com', code: expect.stringMatching(/^\d{6}$/), purpose: 'trial' },
      { email: 'free@example.com', code: expect.stringMatching(/^\d{6}$/), purpose: 'trial' },
    ]);
    // No account until the code is used.
    expect([...server.store.accounts.values()].some((a) => a.email === 'sam@example.com')).toBe(false);
  });

  it('keeps only an HMAC of the code', async () => {
    await start(token, 'sam@example.com');
    const code = server.mailer.lastCode('sam@example.com')!;
    const stored = server.store.codes.get('sam@example.com')!;
    expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...server.store.codes])).not.toContain(code);
    expect(stored.expiresAt).toBe(NOW + 10 * MINUTE);
  });

  it.each(['', 'sam', 'sam@', '@example.com', 'sam@example', 'sam@.com', 'sam@example.', 'sa m@example.com', 'a@b@example.com', `${'a'.repeat(250)}@x.co`])(
    'refuses %j with 400 invalid-email',
    async (email) => {
      const res = await start(token, email);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('invalid-email');
      expect(server.mailer.sent).toEqual([]);
    },
  );

  it('refuses a bad purpose or body with 400 server', async () => {
    expect((await start(token, 'sam@example.com', 'other')).json.error).toBe('server');
    expect((await server.request('POST', '/signin/start', { key: token, body: ['x'] })).json.error).toBe('server');
    expect((await server.request('POST', '/signin/start', { key: token, rawBody: '{' })).status).toBe(400);
  });

  it('needs a device token', async () => {
    expect((await start('short', 'sam@example.com')).status).toBe(401);
    expect((await server.request('POST', '/signin/start', { key: null, body: { email: 'sam@example.com', purpose: 'signin' } })).status).toBe(401);
  });

  it('signs in with the right code, creating the account, and the code works once', async () => {
    await start(token, 'Sam@Example.com');
    const code = server.mailer.lastCode('sam@example.com')!;
    const res = await finish(token, ' SAM@example.com', code);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      plan: expect.objectContaining({ tier: 'free', email: 'sam@example.com', trialUsed: false }),
      runs: null,
      trialStarted: false,
      trialUsed: false,
    });
    expect(await linkedEmail(token)).toBe('sam@example.com');
    expect(server.store.account('sam@example.com').emailVerifiedAt).toBe(NOW);
    expect(server.store.codes.has('sam@example.com')).toBe(false);
    expect((await me(token)).json.plan.email).toBe('sam@example.com');
    const again = await finish(newToken('other'), 'sam@example.com', code);
    expect(again.status).toBe(400);
    expect(again.json.error).toBe('code-expired');
  });

  it('accepts a code with spaces or a dash', async () => {
    await start(token, 'sam@example.com');
    const code = server.mailer.lastCode('sam@example.com')!;
    expect((await finish(token, 'sam@example.com', `${code.slice(0, 3)} - ${code.slice(3)}`)).status).toBe(200);
  });

  it('signs an existing account in on another computer, replacing what it was linked to', async () => {
    const res = await server.signIn(keyOf('free'), 'pro@example.com');
    expect(res.json.plan).toMatchObject({ tier: 'pro', email: 'pro@example.com' });
    expect(await linkedEmail(keyOf('free'))).toBe('pro@example.com');
    // The account's own computer stays signed in.
    expect(await linkedEmail(keyOf('proMonthly'))).toBe('pro@example.com');
  });

  it('counts wrong codes: 5 tries, then the code is used up', async () => {
    await start(token, 'sam@example.com');
    const code = server.mailer.lastCode('sam@example.com')!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (const triesLeft of [4, 3, 2, 1]) {
      const res = await finish(token, 'sam@example.com', wrong);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'wrong-code', message: expect.stringContaining(`${triesLeft} tr`), triesLeft });
    }
    const fifth = await finish(token, 'sam@example.com', wrong);
    expect(fifth.json.error).toBe('code-expired');
    expect((await finish(token, 'sam@example.com', code)).json.error).toBe('code-expired');
    expect(await linkedEmail(token)).toBeNull();
  });

  it('lets the fifth try be the right one', async () => {
    await start(token, 'sam@example.com');
    const code = server.mailer.lastCode('sam@example.com')!;
    for (let i = 0; i < 4; i++) await finish(token, 'sam@example.com', 'abc');
    expect((await finish(token, 'sam@example.com', code)).status).toBe(200);
  });

  it('expires codes after 10 minutes', async () => {
    await start(token, 'sam@example.com');
    const code = server.mailer.lastCode('sam@example.com')!;
    server.clock.now = NOW + 10 * MINUTE;
    const res = await finish(token, 'sam@example.com', code);
    expect(res.json.error).toBe('code-expired');
  });

  it('answers code-expired when no code was asked for', async () => {
    expect((await finish(token, 'nobody@example.com', '123456')).json.error).toBe('code-expired');
  });

  it('replaces the old code with a new one, and the tries start again', async () => {
    await start(token, 'sam@example.com');
    const first = server.mailer.lastCode('sam@example.com')!;
    for (let i = 0; i < 3; i++) await finish(token, 'sam@example.com', 'nope');
    await start(token, 'sam@example.com');
    const second = server.mailer.lastCode('sam@example.com')!;
    if (first !== second) expect((await finish(token, 'sam@example.com', first)).json.triesLeft).toBe(4);
    expect((await finish(token, 'sam@example.com', second)).status).toBe(200);
  });

  it('refuses a code that isn’t text', async () => {
    const res = await server.request('POST', '/signin/finish', { key: token, body: { email: 'sam@example.com', code: 123456 } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('server');
  });

  it('allows 5 codes an hour per email, from any computer', async () => {
    for (let i = 0; i < 5; i++) expect((await start(newToken(`c${i}`), 'sam@example.com')).status).toBe(200);
    const res = await start(newToken('c5'), 'Sam@example.com');
    expect(res.status).toBe(429);
    expect(res.json).toEqual({ error: 'rate-limited', message: expect.stringContaining('60 minutes'), retryAfter: 3600 });
    expect(server.mailer.sent).toHaveLength(5);
    // Another email is fine.
    expect((await start(newToken('c5'), 'kim@example.com')).status).toBe(200);
    server.clock.now = NOW + HOUR;
    expect((await start(newToken('c6'), 'sam@example.com')).status).toBe(200);
  });

  it('allows 10 codes an hour per computer', async () => {
    for (let i = 0; i < 10; i++) expect((await start(token, `p${i}@example.com`)).status).toBe(200);
    server.clock.now = NOW + 20 * MINUTE;
    const res = await start(token, 'p10@example.com');
    expect(res.status).toBe(429);
    expect(res.json.retryAfter).toBe(40 * 60);
    expect(res.json.message).toContain('40 minutes');
  });

  it('keeps only hashes in the rate limits', async () => {
    await start(token, 'sam@example.com');
    const keys = [...server.store.rates.keys()];
    expect(keys).toEqual([`token:${await sha256Hex(token)}`, `email:${await sha256Hex('sam@example.com')}`]);
  });

  it('answers 502 send-failed when the email can’t be sent', async () => {
    server.mailer.failing = true;
    const res = await start(token, 'sam@example.com');
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('send-failed');
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('Sending a code failed'));
    expect(JSON.stringify(server.log.mock.calls)).not.toContain('sam@example.com');
  });

  it('answers 500 when the mailer isn’t set up', async () => {
    server.deps.mailer = { sendCode: async () => Promise.reject(new Error('RESEND_API_KEY is not set')) };
    const res = await start(token, 'sam@example.com');
    expect(res.status).toBe(500);
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('RESEND_API_KEY is not set'));
  });

  it('makes uniform 6-digit codes', () => {
    const bytes = (...values: number[]) => {
      const queue = [...values];
      return () => {
        const value = queue.shift()!;
        return new Uint8Array([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
      };
    };
    expect(newCode(bytes(481920))).toBe('481920');
    expect(newCode(bytes(7))).toBe('000007');
    expect(newCode(bytes(1_000_000 + 42))).toBe('000042');
    // Values from the last, partial million are drawn again.
    expect(newCode(bytes(4_294_967_295, 4_294_000_000, 123))).toBe('000123');
    expect(newCode()).toMatch(/^\d{6}$/);
  });

  it('cleans email addresses', () => {
    expect(cleanEmail('  Sam@Example.COM\n')).toBe('sam@example.com');
    expect(cleanEmail('sam+tabs@mail.example.co.uk')).toBe('sam+tabs@mail.example.co.uk');
    for (const bad of [null, 5, '', 'sam@example', 'sam@exa mple.com', 'sam@@example.com', `${'a'.repeat(245)}@example.com`]) {
      expect(cleanEmail(bad)).toBeNull();
    }
  });
});

describe('the server trial', () => {
  const token = newToken('laptop');

  it('starts with the code, once per email', async () => {
    const res = await server.signIn(token, 'sam@example.com', true);
    expect(res.json).toMatchObject({
      plan: { tier: 'pro-ai', trial: { startedAt: NOW, endsAt: NOW + 7 * DAY }, trialUsed: true, email: 'sam@example.com' },
      runs: { used: 0, limit: 300 },
      trialStarted: true,
      trialUsed: false,
    });
    server.clock.now = NOW + 8 * DAY;
    const again = await server.signIn(newToken('desktop'), 'sam@example.com', true);
    expect(again.json).toMatchObject({ plan: { tier: 'free', trial: null, trialUsed: true }, trialStarted: false, trialUsed: true });
    // Still signed in.
    expect(await linkedEmail(newToken('desktop'))).toBe('sam@example.com');
  });

  it('says trialUsed (and keeps the trial running) when asked again during the trial', async () => {
    await server.signIn(token, 'sam@example.com', true);
    server.clock.now = NOW + DAY;
    const again = await server.signIn(newToken('desktop'), 'sam@example.com', true);
    expect(again.json).toMatchObject({ plan: { tier: 'pro-ai', trial: { startedAt: NOW } }, trialStarted: false, trialUsed: true });
  });

  it('doesn’t start a trial for an account with a live subscription', async () => {
    const res = await server.signIn(token, 'pro@example.com', true);
    expect(res.json).toMatchObject({ plan: { tier: 'pro' }, trialStarted: false, trialUsed: false });
    expect([...server.store.accounts.values()].find((a) => a.email === 'pro@example.com')!.trialStartedAt).toBeNull();
  });

  it('starts for a signed-in computer with POST /trial', async () => {
    const res = await server.request('POST', '/trial', { key: 'free' });
    expect(res.json).toMatchObject({ plan: { tier: 'pro-ai', trial: { startedAt: NOW } }, trialStarted: true, trialUsed: false });
    const again = await server.request('POST', '/trial', { key: 'free' });
    expect(again.json).toMatchObject({ trialStarted: false, trialUsed: true });
    expect((await server.request('POST', '/trial', { key: 'trialEnded' })).json).toMatchObject({ plan: { tier: 'free' }, trialUsed: true });
  });

  it('POST /trial needs a signed-in computer', async () => {
    const res = await server.request('POST', '/trial', { key: newToken('stranger') });
    expect(res.status).toBe(401);
  });
});

describe('Chrome profile keys and signing out', () => {
  const profileKey = 'profile-key-0123456789-0123456789-abcdefghij';
  const laptop = newToken('laptop');

  it('signs in another computer on the same Chrome profile', async () => {
    expect((await server.request('POST', '/profile', { key: 'proAiMonthly', body: { profileKey } })).json).toEqual({ ok: true });
    const res = await server.request('POST', '/signin/profile', { key: laptop, body: { profileKey } });
    expect(res.status).toBe(200);
    expect(res.json.plan).toMatchObject({ tier: 'pro-ai', email: 'ai@example.com' });
    expect(res.json.runs).toMatchObject({ used: 0 });
    expect(await linkedEmail(laptop)).toBe('ai@example.com');
    // Only a hash of the key is kept.
    expect(server.store.devices.has(await sha256Hex(profileKey))).toBe(true);
    expect(JSON.stringify([...server.store.devices])).not.toContain(profileKey);
  });

  it('answers 401 for an unknown or malformed profile key', async () => {
    for (const key of [profileKey, 'short']) {
      const res = await server.request('POST', '/signin/profile', { key: laptop, body: { profileKey: key } });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe('not-signed-in');
    }
    expect((await server.request('POST', '/signin/profile', { key: laptop, body: {} })).status).toBe(400);
  });

  it('registers keys only for signed-in computers, and moves a key to the newest account', async () => {
    expect((await server.request('POST', '/profile', { key: laptop, body: { profileKey } })).status).toBe(401);
    expect((await server.request('POST', '/profile', { key: 'free', body: { profileKey: 'bad key' } })).status).toBe(400);
    expect((await server.request('POST', '/profile', { key: 'free', body: { profileKey: keyOf('free') } })).status).toBe(400);
    await server.request('POST', '/profile', { key: 'free', body: { profileKey } });
    await server.request('POST', '/profile', { key: 'proMonthly', body: { profileKey } });
    const res = await server.request('POST', '/signin/profile', { key: laptop, body: { profileKey } });
    expect(res.json.plan.email).toBe('pro@example.com');
  });

  it('never takes a profile key as a device token', async () => {
    await server.request('POST', '/profile', { key: 'proMonthly', body: { profileKey } });
    expect((await me(profileKey)).json.plan.email).toBeNull();
    expect((await server.request('GET', '/sync', { key: profileKey })).status).toBe(401);
  });

  it('signs out only this computer; the profile key and other computers stay', async () => {
    await server.request('POST', '/profile', { key: 'proMonthly', body: { profileKey } });
    await server.request('POST', '/signin/profile', { key: laptop, body: { profileKey } });
    expect((await server.request('POST', '/signout', { key: laptop })).json).toEqual({ ok: true });
    expect((await me(laptop)).json.plan.email).toBeNull();
    expect((await server.request('GET', '/sync', { key: laptop })).status).toBe(401);
    expect((await me('proMonthly')).json.plan.email).toBe('pro@example.com');
    expect((await server.request('POST', '/signin/profile', { key: laptop, body: { profileKey } })).status).toBe(200);
    // Signing out a computer that isn't signed in is fine too.
    expect((await server.request('POST', '/signout', { key: newToken('x') })).status).toBe(200);
  });

  it('shares the account’s synced tabs between its computers', async () => {
    await server.request('POST', '/sync', { key: 'proMonthly', body: { set: { 'tf.m': { v: 1 } }, remove: [], baseVersion: 0 } });
    await server.signIn(laptop, 'PRO@example.com');
    const res = await server.request('GET', '/sync', { key: laptop });
    expect(res.json).toEqual({ items: { 'tf.m': { v: 1 } }, version: 1 });
  });
});

describe('POST /checkout', () => {
  const laptop = newToken('laptop');
  const sessionOf = (res: { json: { sessionId: string } }) => server.stripe.sessions.get(res.json.sessionId)!;

  it('signed out: Stripe asks for the email', async () => {
    const res = await checkout(laptop, 'pro', 'year');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ url: expect.stringMatching(/\/pay\/cs_test_/), sessionId: expect.stringMatching(/^cs_test_/) });
    const session = sessionOf(res);
    expect(session).toMatchObject({
      mode: 'subscription',
      customer: null,
      customer_email: null,
      client_reference_id: null,
      metadata: {},
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
      success_url: `${PUBLIC_URL}/checkout/done?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/checkout/cancel`,
      subscription_data: { trial_end: null },
    });
    expect(session.line_items[0].price).toBe(server.stripe.priceFor('pro-yearly')!.id);
    expect(server.store.pending.get(res.json.sessionId)).toMatchObject({ tokenHash: await sha256Hex(laptop), createdAt: NOW });
  });

  it.each([
    ['pro', 'month', 'pro-monthly'],
    ['pro', 'year', 'pro-yearly'],
    ['pro-ai', 'month', 'pro-ai-monthly'],
    ['pro-ai', 'year', 'pro-ai-yearly'],
  ])('%s, %s uses the %s price', async (tier, interval, lookupKey) => {
    const res = await checkout(laptop, tier, interval);
    expect(sessionOf(res).line_items[0].price).toBe(server.stripe.priceFor(lookupKey)!.id);
  });

  it('signed in: uses the account’s email (Stripe then can’t change it)', async () => {
    const res = await checkout(keyOf('free'), 'pro', 'month');
    const account = server.store.account('free@example.com');
    expect(sessionOf(res)).toMatchObject({ customer: null, customer_email: 'free@example.com', metadata: { account: account.id }, client_reference_id: account.id });
  });

  it('signed in with a Stripe customer: uses the customer', async () => {
    const res = await checkout(keyOf('cancelled'));
    const account = server.store.account('gone@example.com');
    expect(sessionOf(res)).toMatchObject({ customer: account.stripeCustomerId, customer_email: null, customer_update: null });
  });

  it('during the trial, Pro AI starts billing when the trial ends', async () => {
    const res = await checkout(keyOf('trialRunning'), 'pro-ai', 'year');
    expect(sessionOf(res).subscription_data.trial_end).toBe((NOW + 5 * DAY) / 1000);
  });

  it('during the trial, Pro charges at once', async () => {
    const res = await checkout(keyOf('trialRunning'), 'pro', 'month');
    expect(sessionOf(res).subscription_data.trial_end).toBeNull();
  });

  it('charges Pro AI at once when fewer than 48 hours of the trial are left', async () => {
    server.clock.now = NOW + 5 * DAY - 47 * HOUR;
    const res = await checkout(keyOf('trialRunning'));
    expect(res.status).toBe(200);
    expect(sessionOf(res).subscription_data.trial_end).toBeNull();
    server.clock.now = NOW + 5 * DAY - 49 * HOUR;
    expect(sessionOf(await checkout(keyOf('trialRunning'))).subscription_data.trial_end).toBe((NOW + 5 * DAY) / 1000);
  });

  it.each(['proMonthly', 'proAiYearly', 'pastDue', 'proDuringTrial'] as const)('answers 409 already-subscribed to %s', async (user) => {
    const res = await checkout(keyOf(user));
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('already-subscribed');
    expect(server.stripe.sessions.size).toBe(0);
  });

  it('turns on Stripe Tax when set, saving the address on an existing customer', async () => {
    server = createServer({ automaticTax: true });
    const signedOut = sessionOf(await checkout(laptop));
    expect(signedOut).toMatchObject({ automatic_tax: { enabled: true }, customer_update: null });
    const customer = sessionOf(await checkout(keyOf('cancelled')));
    expect(customer).toMatchObject({ automatic_tax: { enabled: true }, customer_update: { address: 'auto' } });
  });

  it.each([
    ['no tier', { interval: 'month' }],
    ['an unknown tier', { tier: 'team', interval: 'month' }],
    ['an unknown interval', { tier: 'pro', interval: 'week' }],
  ])('refuses %s with 400', async (_name, body) => {
    const res = await server.request('POST', '/checkout', { key: laptop, body });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('server');
  });

  it('needs a device token', async () => {
    expect((await checkout(null)).status).toBe(401);
  });

  it('allows 20 checkouts an hour per computer', async () => {
    for (let i = 0; i < 20; i++) expect((await checkout(laptop)).status).toBe(200);
    server.clock.now = NOW + 15 * MINUTE;
    const res = await checkout(laptop);
    expect(res.status).toBe(429);
    expect(res.json).toEqual({ error: 'rate-limited', message: expect.stringContaining('45 minutes'), retryAfter: 45 * 60 });
    expect(server.stripe.sessions.size).toBe(20);
    expect([...server.store.rates.keys()]).toEqual([`checkout:${await sha256Hex(laptop)}`]);
    expect((await checkout(newToken('other'))).status).toBe(200);
    server.clock.now = NOW + HOUR;
    expect((await checkout(laptop)).status).toBe(200);
  });

  it('doesn’t count refused checkouts', async () => {
    for (let i = 0; i < 25; i++) expect((await checkout(keyOf('proMonthly'))).status).toBe(409);
    expect(server.store.rates.size).toBe(0);
  });

  it('answers 502 when Stripe refuses, and logs why', async () => {
    server.stripe.priceFor('pro-ai-monthly')!.active = false;
    const res = await checkout(laptop);
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('server');
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('No active Stripe price has the lookup key pro-ai-monthly'));
    expect(server.store.pending.size).toBe(0);
  });

  it('answers 500 when Stripe isn’t set up, and says so in the log', async () => {
    server.deps.payments = createStripe({ secretKey: '', webhookSecret: '' });
    const res = await checkout(laptop);
    expect(res.status).toBe(500);
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('STRIPE_SECRET_KEY is not set'));
    // Sync doesn't need Stripe.
    expect((await server.request('GET', '/sync', { key: 'proMonthly' })).status).toBe(200);
  });
});

describe('paying', () => {
  const laptop = newToken('laptop');
  const pay = async (sessionId: string, email?: string) => server.stripe.completeSession(sessionId, { email });
  const eventsOf = (type: string) => server.stripe.events.filter((e) => e.type === type);
  const deliverAll = async () => {
    for (const event of server.stripe.events) expect((await server.webhook(event)).status).toBe(200);
  };

  it('signed out, new email: the webhook creates the account and signs this computer in', async () => {
    const { json } = await checkout(laptop, 'pro-ai', 'year');
    await pay(json.sessionId, 'New@Example.com');
    await deliverAll();
    const account = server.store.account('new@example.com');
    expect(account.stripeCustomerId).toMatch(/^cus_/);
    expect(await linkedEmail(laptop)).toBe('new@example.com');
    expect(server.store.pending.size).toBe(0);
    const res = await me(laptop);
    expect(res.json.plan).toMatchObject({ tier: 'pro-ai', email: 'new@example.com', interval: 'year', status: 'active', trialUsed: false });
    expect(res.json.plan.renewsAt).toBeGreaterThan(NOW + 300 * DAY);
  });

  it('GET /me notices the payment before the webhook, and the webhook changes nothing after', async () => {
    const { json } = await checkout(laptop);
    expect((await me(laptop)).json.plan.tier).toBe('free');
    await pay(json.sessionId, 'new@example.com');
    const res = await me(laptop);
    expect(res.json.plan).toMatchObject({ tier: 'pro-ai', email: 'new@example.com' });
    expect(server.store.pending.size).toBe(0);
    await deliverAll();
    expect((await me(laptop)).json.plan).toMatchObject({ tier: 'pro-ai', email: 'new@example.com' });
    expect(await server.store.subscriptionList(server.store.account('new@example.com').id)).toHaveLength(1);
  });

  it('GET /me leaves an open checkout pending and forgets an expired one', async () => {
    const { json } = await checkout(laptop);
    await me(laptop);
    expect(server.store.pending.has(json.sessionId)).toBe(true);
    server.clock.now = NOW + 24 * HOUR - MINUTE;
    await me(laptop);
    expect(server.store.pending.has(json.sessionId)).toBe(true);
    server.clock.now = NOW + 24 * HOUR;
    await me(laptop);
    expect(server.store.pending.has(json.sessionId)).toBe(false);
  });

  it('GET /me asks about at most 3 checkouts from the last 24 hours', async () => {
    for (let i = 0; i < 5; i++) await checkout(laptop);
    const asked = () => server.stripe.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/v1/checkout/sessions/')).length;
    await me(laptop);
    expect(asked()).toBe(3);
    server.clock.now = NOW + 25 * HOUR;
    await me(laptop);
    expect(asked()).toBe(3);
  });

  it('GET /me still answers when Stripe can’t be reached', async () => {
    await checkout(laptop);
    server.deps.payments.getCheckout = vi.fn().mockRejectedValue(new Error('network down'));
    const res = await me(laptop);
    expect(res.status).toBe(200);
    expect(res.json.plan.tier).toBe('free');
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('Checking a checkout failed'));
  });

  it('signed in: the payment lands on the account (even if Stripe’s email differs)', async () => {
    const { json } = await checkout(keyOf('free'), 'pro', 'month');
    server.stripe.sessions.get(json.sessionId)!.customer_email = null;
    await pay(json.sessionId, 'typo@example.com');
    await deliverAll();
    const res = await me('free');
    expect(res.json.plan).toMatchObject({ tier: 'pro', email: 'free@example.com' });
    expect(server.store.account('free@example.com').stripeCustomerId).toMatch(/^cus_/);
  });

  it('during the trial: Pro AI is on, billing from the trial’s end', async () => {
    const { json } = await checkout(keyOf('trialRunning'), 'pro-ai', 'month');
    await pay(json.sessionId);
    await deliverAll();
    const res = await me('trialRunning');
    expect(res.json.plan).toMatchObject({ tier: 'pro-ai', trial: null, trialUsed: true, status: 'active', renewsAt: NOW + 5 * DAY });
    expect((await checkout(keyOf('trialRunning'))).status).toBe(409);
  });

  it('signed out, with the email of an existing account: the computer must sign in with a code', async () => {
    server.clock.now = NOW + MINUTE;
    const { json } = await checkout(laptop, 'pro', 'month');
    await pay(json.sessionId, 'free@example.com');
    await deliverAll();
    expect(await linkedEmail(laptop)).toBeNull();
    const res = await me(laptop);
    expect(res.json.plan.email).toBeNull();
    expect(res.json.needsSignIn).toEqual({ email: 'free@example.com' });
    // The plan is on that account.
    expect((await me('free')).json.plan.tier).toBe('pro');
    const signedIn = await server.signIn(laptop, 'free@example.com');
    expect(signedIn.json.plan).toMatchObject({ tier: 'pro', email: 'free@example.com' });
    expect((await me(laptop)).json.needsSignIn).toBeUndefined();
  });

  it('signs out the computers a signed-out payment linked once the owner proves the email', async () => {
    const profileKey = 'payer-profile-key'.padEnd(43, 'k');
    const desktop = newToken('payer-desktop');
    const { json } = await checkout(laptop, 'pro', 'month');
    await pay(json.sessionId, 'owner@example.com');
    await deliverAll();
    expect(server.store.account('owner@example.com').emailVerifiedAt).toBeNull();
    await server.request('POST', '/profile', { key: laptop, body: { profileKey } });
    await server.request('POST', '/signin/profile', { key: desktop, body: { profileKey } });
    await server.request('POST', '/sync', { key: laptop, body: { set: { 'tf.m': { v: 1 } }, remove: [], baseVersion: 0 } });
    expect(await linkedEmail(desktop)).toBe('owner@example.com');

    server.clock.now = NOW + MINUTE;
    const owner = newToken('owner');
    const res = await server.signIn(owner, 'owner@example.com');
    expect(res.json.plan).toMatchObject({ tier: 'pro', email: 'owner@example.com' });
    expect(await linkedEmail(owner)).toBe('owner@example.com');
    expect(await linkedEmail(laptop)).toBeNull();
    expect(await linkedEmail(desktop)).toBeNull();
    expect((await server.request('POST', '/signin/profile', { key: newToken('again'), body: { profileKey } })).status).toBe(401);
    expect(server.store.account('owner@example.com').emailVerifiedAt).toBe(NOW + MINUTE);
    // The plan, synced tabs and backups stay.
    expect((await server.request('GET', '/sync', { key: owner })).json.items).toEqual({ 'tf.m': { v: 1 } });
    expect((await server.request('GET', '/backups', { key: owner })).json.backups).toHaveLength(1);

    // Only the first proof does this.
    await server.signIn(laptop, 'owner@example.com');
    expect(await linkedEmail(owner)).toBe('owner@example.com');
    expect(await linkedEmail(laptop)).toBe('owner@example.com');
  });

  it('keeps the payer’s computer signed in when the payer proves the email on it', async () => {
    const { json } = await checkout(laptop);
    await pay(json.sessionId, 'new@example.com');
    await deliverAll();
    await server.signIn(laptop, 'new@example.com');
    expect(await linkedEmail(laptop)).toBe('new@example.com');
    expect(server.store.account('new@example.com').emailVerifiedAt).toBe(NOW);
    expect((await me(laptop)).json.plan.tier).toBe('pro-ai');
  });

  it('says needsSignIn from GET /me too, when it gets there before the webhook', async () => {
    const { json } = await checkout(laptop);
    await pay(json.sessionId, 'trial@example.com');
    expect((await me(laptop)).json.needsSignIn).toEqual({ email: 'trial@example.com' });
    await deliverAll();
    expect((await me(laptop)).json.needsSignIn).toEqual({ email: 'trial@example.com' });
  });
});

describe('POST /stripe/webhook', () => {
  const laptop = newToken('laptop');
  let event: Awaited<ReturnType<Server['stripe']['emit']>>;

  beforeEach(async () => {
    const sub = server.stripe.subscriptions.values().next().value!;
    event = await server.stripe.emit('customer.subscription.updated', sub);
  });

  it('answers { received: true } to a signed event', async () => {
    const res = await server.webhook(event);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true });
  });

  it('refuses a bad, missing or old signature with 400', async () => {
    const { body } = await server.stripe.signed(event);
    const t = Math.floor(NOW / 1000);
    const wrongSecret = await signWebhook('whsec_other', body, t);
    for (const signature of [wrongSecret, '', 't=abc', `t=${t}`, `t=${t},v1=${'0'.repeat(64)}`]) {
      const res = await server.request('POST', '/stripe/webhook', { key: null, rawBody: body, headers: { 'stripe-signature': signature } });
      expect(res.status, signature).toBe(400);
      expect(res.json.error).toBe('server');
    }
    const old = await server.stripe.signed(event, t - 301);
    expect((await server.request('POST', '/stripe/webhook', { key: null, rawBody: old.body, headers: { 'stripe-signature': old.signature } })).status).toBe(400);
    const recent = await server.stripe.signed(event, t - 299);
    expect((await server.request('POST', '/stripe/webhook', { key: null, rawBody: recent.body, headers: { 'stripe-signature': recent.signature } })).status).toBe(200);
  });

  it('checks the raw body: a changed body fails', async () => {
    const { body, signature } = await server.stripe.signed(event);
    const res = await server.request('POST', '/stripe/webhook', { key: null, rawBody: body.replace('"active"', '"canceled"'), headers: { 'stripe-signature': signature } });
    expect(res.status).toBe(400);
  });

  it('processes each event once', async () => {
    const reads = () => server.stripe.requests.filter((r) => r.path.startsWith('/v1/subscriptions/')).length;
    await server.webhook(event);
    await server.webhook(event);
    expect(reads()).toBe(1);
  });

  it('forgets an event that failed, so Stripe’s retry works', async () => {
    const getSubscription = server.deps.payments.getSubscription;
    server.deps.payments.getSubscription = vi.fn().mockRejectedValue(new Error('boom'));
    expect((await server.webhook(event)).status).toBe(500);
    server.deps.payments.getSubscription = getSubscription;
    expect((await server.webhook(event)).status).toBe(200);
  });

  it('answers 502 when Stripe can’t be reached while processing', async () => {
    server.stripe.subscriptions.clear();
    expect((await server.webhook(event)).status).toBe(502);
  });

  it('keeps cancellations and renewals up to date, reading Stripe again each time', async () => {
    const account = server.store.account('pro@example.com');
    const subId = [...server.store.subscriptions.values()].find((s) => s.accountId === account.id)!.subscription.id;
    const periodEnd = server.stripe.subscriptions.get(subId)!.current_period_end;
    await server.stripe.setSubscription(subId, { cancel_at_period_end: true });
    await server.webhook(server.stripe.events.at(-1)!);
    expect((await me('proMonthly')).json.plan).toMatchObject({ tier: 'pro', cancelAt: periodEnd * 1000, renewsAt: null });
    await server.stripe.setSubscription(subId, { status: 'canceled' }, { event: 'customer.subscription.deleted' });
    await server.webhook(server.stripe.events.at(-1)!);
    expect((await me('proMonthly')).json.plan).toMatchObject({ tier: 'free', status: null, email: 'pro@example.com' });
  });

  it('copes with events out of order', async () => {
    const { json } = await checkout(laptop, 'pro', 'month');
    await server.stripe.completeSession(json.sessionId, { email: 'new@example.com' });
    const [created, completed] = server.stripe.events.slice(-2);
    const subId = created!.data.object.id;
    await server.stripe.setSubscription(subId, { status: 'past_due' });
    const updated = server.stripe.events.at(-1)!;
    // The update first: no account for that customer yet, so it waits.
    expect((await server.webhook(updated)).status).toBe(200);
    expect(server.store.subscriptions.has(subId)).toBe(false);
    // Then the checkout, which reads the subscription as it is now.
    await server.webhook(completed!);
    expect((await me(laptop)).json.plan).toMatchObject({ tier: 'pro', status: 'past_due' });
    // The stale "created" (active) arrives last: Stripe is read again, so still past due.
    await server.webhook(created!);
    expect((await me(laptop)).json.plan.status).toBe('past_due');
  });

  it('finds the account by the subscription’s customer even if the account has another customer', async () => {
    const { json } = await checkout(laptop, 'pro', 'month');
    await server.stripe.completeSession(json.sessionId, { email: 'gone@example.com' });
    for (const e of server.stripe.events.slice(-2)) await server.webhook(e);
    const account = server.store.account('gone@example.com');
    const newSub = [...server.store.subscriptions.values()].find((s) => s.accountId === account.id && s.subscription.status === 'active')!;
    expect(newSub.subscription.customerId).not.toBe(account.stripeCustomerId);
    await server.stripe.setSubscription(newSub.subscription.id, { cancel_at_period_end: true });
    await server.webhook(server.stripe.events.at(-1)!);
    expect((await me('cancelled')).json.plan.cancelAt).not.toBeNull();
  });

  it('ignores other events', async () => {
    const other = await server.stripe.emit('invoice.paid', { id: 'in_123' });
    expect((await server.webhook(other)).json).toEqual({ received: true });
  });

  it('refuses a body over 1 MB', async () => {
    const res = await server.request('POST', '/stripe/webhook', { key: null, rawBody: 'x'.repeat(LIMITS.maxWebhookBytes + 1), headers: { 'stripe-signature': 't=1,v1=00' } });
    expect(res.status).toBe(413);
  });
});

describe('POST /billing', () => {
  it('opens the billing portal for a paying account', async () => {
    const res = await server.request('POST', '/billing', { key: 'proMonthly' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ url: expect.stringMatching(/\/portal\/bps_/) });
    const portal = [...server.stripe.portalSessions.values()][0]!;
    expect(portal).toMatchObject({
      customer: server.store.account('pro@example.com').stripeCustomerId,
      return_url: `${PUBLIC_URL}/billing/done`,
      configuration: null,
      flow: null,
    });
  });

  it('opens straight on the card form, with the configuration when set', async () => {
    server.stripe.portalConfigurations.set('bpc_123', { id: 'bpc_123', active: true });
    server.deps.config.portalConfiguration = 'bpc_123';
    const res = await server.request('POST', '/billing', { key: 'pastDue', body: { flow: 'payment-method' } });
    expect(res.status).toBe(200);
    const portal = [...server.stripe.portalSessions.values()][0]!;
    expect(portal.configuration).toBe('bpc_123');
    expect(portal.flow).toEqual({
      type: 'payment_method_update',
      after_completion: { type: 'redirect', redirect: { return_url: `${PUBLIC_URL}/billing/done` } },
    });
  });

  it('works for a cancelled plan (to subscribe again or see invoices)', async () => {
    expect((await server.request('POST', '/billing', { key: 'cancelled' })).status).toBe(200);
  });

  it('answers 402 needs-pro when the account never paid', async () => {
    const res = await server.request('POST', '/billing', { key: 'trialRunning' });
    expect(res.status).toBe(402);
    expect(res.json.error).toBe('needs-pro');
  });

  it('answers 401 when not signed in, 400 for an unknown flow', async () => {
    expect((await server.request('POST', '/billing', { key: newToken('x') })).status).toBe(401);
    expect((await server.request('POST', '/billing', { key: 'proMonthly', body: { flow: 'other' } })).status).toBe(400);
  });
});

describe('pages Stripe sends people back to', () => {
  it.each(['/checkout/done?session_id=cs_test_1', '/checkout/cancel', '/billing/done'])('%s is plain text', async (path) => {
    const res = await server.request('GET', path, { key: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.text).toContain('You can close this tab and go back to Tabfold.');
  });
});

describe('CORS', () => {
  it('answers a preflight from an allowed extension', async () => {
    const res = await server.request('OPTIONS', '/sync', { key: null, origin: EXTENSION });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION);
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  });

  it('sets the headers on every response, errors included', async () => {
    const good = await server.request('GET', '/me', { origin: EXTENSION });
    const refused = await server.request('GET', '/me', { key: null, origin: EXTENSION });
    expect(good.headers.get('access-control-allow-origin')).toBe(EXTENSION);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBe(EXTENSION);
    expect(refused.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  });

  it('leaves out other origins', async () => {
    for (const origin of ['chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba', 'https://evil.example.com']) {
      const res = await server.request('OPTIONS', '/me', { key: null, origin });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('allows any extension with *, but never a website', async () => {
    server = createServer({ allowedOrigins: ['*'] });
    const extension = await server.request('GET', '/me', { origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' });
    const site = await server.request('GET', '/me', { origin: 'https://evil.example.com' });
    expect(extension.headers.get('access-control-allow-origin')).toBe('chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba');
    expect(site.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('routes', () => {
  it('works with or without the /functions/v1 prefix and a trailing slash', async () => {
    for (const url of ['https://x.supabase.co/functions/v1/tabfold/me', 'http://localhost:8000/tabfold/me/']) {
      expect((await server.request('GET', url)).status).toBe(200);
    }
  });

  it('answers 404 and 405 as server errors', async () => {
    const missing = await server.request('GET', '/nothing');
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe('server');
    expect((await server.request('POST', '/me')).status).toBe(405);
    expect((await server.request('GET', '/signin/start')).status).toBe(405);
    expect((await server.request('DELETE', '/sync')).status).toBe(405);
  });

  it('answers 500 when something breaks, without leaking the token', async () => {
    server.store.syncRead = vi.fn().mockRejectedValue(new Error('connection lost'));
    const res = await server.request('GET', '/sync');
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'server', message: expect.any(String) });
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
    expect(JSON.stringify(server.log.mock.calls)).not.toContain(keyOf('proAiMonthly'));
  });

  it('never logs codes, tokens or profile keys', async () => {
    const token = newToken('logs');
    server.mailer.failing = true;
    await start(token, 'sam@example.com');
    server.mailer.failing = false;
    await start(token, 'sam@example.com');
    await finish(token, 'sam@example.com', '000000');
    await server.request('POST', '/signin/profile', { key: token, body: { profileKey: 'p'.repeat(40) } });
    const logged = JSON.stringify(server.log.mock.calls);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(server.mailer.lastCode('sam@example.com'));
    expect(logged).not.toContain('p'.repeat(40));
  });
});

describe('sync', () => {
  const write = (body: unknown, key: string = 'proMonthly') => server.request('POST', '/sync', { key, body });
  const accountId = (email: string) => server.store.account(email).id;

  it('starts empty at version 0', async () => {
    const res = await server.request('GET', '/sync', { key: 'proMonthly' });
    expect(res.json).toEqual({ items: {}, version: 0 });
  });

  it('writes, reads back and removes', async () => {
    const first = await write({ set: { 'tf.m': { v: 1, n: 2 }, 'tf.c0': chunk(2), 'tf.c1': chunk(1, 2) }, remove: [], baseVersion: 0 });
    expect(first).toMatchObject({ status: 200, json: { version: 1 } });
    const second = await write({ set: { 'tf.m': { v: 1, n: 1 } }, remove: ['tf.c1', 'tf.never-there'], baseVersion: 1 });
    expect(second.json).toEqual({ version: 2 });
    const read = await server.request('GET', '/sync', { key: 'proMonthly' });
    expect(read.json).toEqual({ items: { 'tf.m': { v: 1, n: 1 }, 'tf.c0': chunk(2) }, version: 2 });
  });

  it('refuses an out-of-date write with 409 and the current version', async () => {
    await write({ set: { 'tf.m': { v: 1 } }, remove: [], baseVersion: 0 });
    const res = await write({ set: { 'tf.m': { v: 2 } }, remove: [], baseVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: 'conflict', message: expect.any(String), version: 1 });
    expect((await server.request('GET', '/sync', { key: 'proMonthly' })).json.items['tf.m']).toEqual({ v: 1 });
  });

  it.each([
    ['a key without tf.', { set: { other: 1 }, remove: [], baseVersion: 0 }],
    ['a removed key without tf.', { set: {}, remove: ['other'], baseVersion: 0 }],
    ['a bare tf.', { set: { 'tf.': 1 }, remove: [], baseVersion: 0 }],
    ['a very long key', { set: { [`tf.${'x'.repeat(200)}`]: 1 }, remove: [], baseVersion: 0 }],
    ['no baseVersion', { set: { 'tf.m': 1 }, remove: [] }],
    ['a negative baseVersion', { set: { 'tf.m': 1 }, remove: [], baseVersion: -1 }],
    ['a fractional baseVersion', { set: { 'tf.m': 1 }, remove: [], baseVersion: 0.5 }],
    ['set as a list', { set: [['tf.m', 1]], remove: [], baseVersion: 0 }],
    ['not an object', [1, 2]],
  ])('refuses %s with 400', async (_name, body) => {
    const res = await write(body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('server');
    expect(server.store.sync.size).toBe(0);
  });

  it('refuses a body that isn’t JSON', async () => {
    const res = await server.request('POST', '/sync', { key: 'proMonthly', rawBody: '{"set":' });
    expect(res.status).toBe(400);
  });

  it('keeps the account under 8 MB (413, nothing changed)', async () => {
    const half = 'x'.repeat(4 * 1024 * 1024);
    expect((await write({ set: { 'tf.c0': [half] }, remove: [], baseVersion: 0 })).status).toBe(200);
    const res = await write({ set: { 'tf.c1': [half] }, remove: [], baseVersion: 1 });
    expect(res.status).toBe(413);
    expect(res.json.error).toBe('server');
    expect(await server.store.syncVersion(accountId('pro@example.com'))).toBe(1);
    // Replacing the big chunk instead fits.
    expect((await write({ set: { 'tf.c0': ['small'], 'tf.c1': [half] }, remove: [], baseVersion: 1 })).status).toBe(200);
  });

  it('refuses a request body over 10 MB with 413', async () => {
    const big = 'x'.repeat(LIMITS.maxBodyBytes + 1);
    const res = await write({ set: { 'tf.c0': [big] }, remove: [], baseVersion: 0 });
    expect(res.status).toBe(413);
    expect(server.store.sync.size).toBe(0);
  });

  it('refuses a declared Content-Length over 10 MB before reading', async () => {
    const res = await server.request('POST', '/sync', {
      key: 'proMonthly',
      rawBody: '{}',
      headers: { 'content-length': String(LIMITS.maxBodyBytes + 1) },
    });
    expect(res.status).toBe(413);
  });
});

describe('backups', () => {
  const write = (set: Record<string, unknown>, baseVersion: number) =>
    server.request('POST', '/sync', { key: 'proMonthly', body: { set, remove: [], baseVersion } });
  const list = () => server.request('GET', '/backups', { key: 'proMonthly' });

  it('counts the records in tf.c chunks', () => {
    expect(countTabs({ 'tf.m': { n: 2 }, 'tf.c0': chunk(3), 'tf.c1': chunk(2), 'tf.t0': chunk(4), 'tf.cx': chunk(1), 'tf.c2': 'odd' })).toBe(5);
  });

  it('keeps one backup a day, made by the first write of the UTC day', async () => {
    await write({ 'tf.m': { v: 1 }, 'tf.c0': chunk(3), 'tf.t0': [['000000000001', 1, 'k']] }, 0);
    await write({ 'tf.c0': chunk(5) }, 1);
    expect((await list()).json).toEqual({ backups: [{ day: '2026-10-10', tabCount: 3, createdAt: NOW }] });
    const day = await server.request('GET', '/backups/2026-10-10', { key: 'proMonthly' });
    expect(day.json).toEqual({ day: '2026-10-10', items: { 'tf.m': { v: 1 }, 'tf.c0': chunk(3), 'tf.t0': [['000000000001', 1, 'k']] } });

    server.clock.now = Date.UTC(2026, 9, 11, 0, 0, 1);
    await write({ 'tf.c1': chunk(2, 10) }, 2);
    expect((await list()).json.backups).toEqual([
      { day: '2026-10-11', tabCount: 7, createdAt: server.clock.now },
      { day: '2026-10-10', tabCount: 3, createdAt: NOW },
    ]);
  });

  it('makes no backup when a write is refused', async () => {
    await write({ 'tf.m': 1 }, 5);
    expect((await list()).json.backups).toEqual([]);
  });

  it('deletes backups older than 30 days', async () => {
    let version = 0;
    for (const offset of [0, 1, 30, 31]) {
      server.clock.now = NOW + offset * DAY;
      await write({ 'tf.c0': chunk(offset + 1) }, version++);
    }
    // On day 31 the first backup (31 days old) is gone; the one from day 1 (30 days old) stays.
    const days = (await list()).json.backups.map((b: { day: string }) => b.day);
    expect(days).toEqual(['2026-11-10', '2026-11-09', '2026-10-11']);
    expect((await server.request('GET', '/backups/2026-10-10', { key: 'proMonthly' })).status).toBe(404);
  });

  it('prunes old backups when listing, even without new writes', async () => {
    await write({ 'tf.c0': chunk(1) }, 0);
    server.clock.now = NOW + 31 * DAY;
    expect((await list()).json.backups).toEqual([]);
  });

  it('answers 404 for a missing or malformed day', async () => {
    for (const day of ['2026-10-09', '2026-02-30', 'yesterday', '2026-10-10x']) {
      const res = await server.request('GET', `/backups/${day}`, { key: 'proMonthly' });
      expect(res.status).toBe(404);
      expect(res.json.error).toBe('server');
    }
  });

  it('keeps each account’s backups to itself', async () => {
    await write({ 'tf.c0': chunk(1) }, 0);
    const other = await server.request('GET', '/backups', { key: 'proYearly' });
    expect(other.json.backups).toEqual([]);
  });

  it('still saves the write when the backup fails', async () => {
    server.store.backupPut = vi.fn().mockRejectedValue(new Error('disk full'));
    const res = await write({ 'tf.c0': chunk(1) }, 0);
    expect(res.status).toBe(200);
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('Backup failed'));
  });
});
