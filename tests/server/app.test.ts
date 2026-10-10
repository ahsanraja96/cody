import { beforeEach, describe, expect, it, vi } from 'vitest';
import { countTabs, LIMITS, readExtPayUser, sha256Hex } from '../../server/supabase/functions/tabfold/app.ts';
import { createServer, DAY, EXTENSION, keyOf, NOW, USERS, type Server } from './fakes';

let server: Server;

beforeEach(() => {
  server = createServer();
});

/** A sync chunk of `n` packed records, as the extension writes them. */
const chunk = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => [`${(from + i).toString(16).padStart(12, '0')}`, `https://example.com/${from + i}`, `Page ${from + i}`, 1_790_000_000]);

describe('sign-in', () => {
  it('refuses a request without a key', async () => {
    const res = await server.request('GET', '/me', { key: null });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'not-signed-in', message: expect.any(String) });
    expect(server.extpayUser).not.toHaveBeenCalled();
  });

  it('refuses a malformed header', async () => {
    const res = await server.request('GET', '/me', { key: null, headers: { authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
  });

  it('refuses a key ExtensionPay doesn’t know, and doesn’t cache it', async () => {
    const res = await server.request('GET', '/sync', { key: 'unknown-key-123456' });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('not-signed-in');
    expect(server.store.cache.size).toBe(0);
  });

  it('answers 500 when the server has no ExtensionPay id', async () => {
    server.deps.config.extpayId = '';
    const res = await server.request('GET', '/me');
    expect(res.status).toBe(500);
    expect(res.json.error).toBe('server');
  });

  it('GET /me works for any known key', async () => {
    const res = await server.request('GET', '/me', { key: 'free' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      plan: { tier: 'free', trial: null, trialUsed: false, email: 'free@example.com', interval: null, status: null, cancelAt: null, checkedAt: NOW },
      runs: null,
    });
  });

  it('GET /me gives Pro AI plans their runs', async () => {
    await server.store.setUsage('ai@example.com', { runs: 12, light: 40 });
    const res = await server.request('GET', '/me', { key: 'proAiMonthly' });
    expect(res.json.plan.tier).toBe('pro-ai');
    expect(res.json.plan.interval).toBe('month');
    expect(res.json.runs).toEqual({ used: 12, limit: 300, resetsAt: Date.UTC(2026, 10, 1) });
  });

  it('GET /me shows a running trial', async () => {
    const res = await server.request('GET', '/me', { key: 'trialRunning' });
    expect(res.json.plan.tier).toBe('pro-ai');
    expect(res.json.plan.trial).toEqual({ startedAt: NOW - 2 * DAY, endsAt: NOW + 5 * DAY });
    expect(res.json.runs.used).toBe(0);
  });

  it.each([
    ['free', 'needs-pro'],
    ['trialEnded', 'needs-pro'],
    ['cancelled', 'needs-pro'],
    ['noEmail', 'needs-pro'],
  ] as const)('refuses Pro routes to %s with 402 %s', async (user, code) => {
    for (const path of ['/sync', '/backups', '/backups/2026-10-10']) {
      const res = await server.request('GET', path, { key: user });
      expect(res.status).toBe(402);
      expect(res.json.error).toBe(code);
    }
  });

  it.each(['free', 'trialEnded', 'cancelled', 'noEmail', 'proMonthly', 'proYearly'] as const)(
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
      const res = await server.request('GET', '/sync', { key: user });
      expect(res.status).toBe(200);
    },
  );

  it('keys accounts by the plan’s email, lower-cased', async () => {
    server.users.set('another-computer-key', { ...USERS.proMonthly, email: '  pro@example.COM ' });
    await server.request('POST', '/sync', { key: 'proMonthly', body: { set: { 'tf.m': { v: 1 } }, remove: [], baseVersion: 0 } });
    const res = await server.request('GET', '/sync', { key: 'another-computer-key' });
    expect(res.json).toEqual({ items: { 'tf.m': { v: 1 } }, version: 1 });
    expect([...server.store.accounts.keys()]).toEqual(['pro@example.com']);
  });
});

describe('the ExtensionPay cache', () => {
  it('asks ExtensionPay once in 5 minutes', async () => {
    await server.request('GET', '/sync', { key: 'proMonthly' });
    server.clock.now += 4 * 60 * 1000;
    await server.request('GET', '/sync', { key: 'proMonthly' });
    await server.request('GET', '/me', { key: 'proMonthly' });
    expect(server.extpayUser).toHaveBeenCalledTimes(1);
    server.clock.now += 61 * 1000;
    await server.request('GET', '/sync', { key: 'proMonthly' });
    expect(server.extpayUser).toHaveBeenCalledTimes(2);
  });

  it('keeps only a SHA-256 of the key', async () => {
    await server.request('GET', '/me', { key: 'proMonthly' });
    const hash = await sha256Hex(keyOf('proMonthly'));
    expect([...server.store.cache.keys()]).toEqual([hash]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...server.store.cache])).not.toContain(keyOf('proMonthly'));
  });

  it('asks again when a cached plan would refuse (the person may have just paid)', async () => {
    const key = 'just-paid-key-0001';
    server.users.set(key, USERS.free);
    expect((await server.request('GET', '/me', { key })).json.plan.tier).toBe('free');
    server.users.set(key, USERS.proMonthly);
    const res = await server.request('GET', '/sync', { key });
    expect(res.status).toBe(200);
    expect(server.extpayUser).toHaveBeenCalledTimes(2);
    // The new answer is cached.
    await server.request('GET', '/sync', { key });
    expect(server.extpayUser).toHaveBeenCalledTimes(2);
  });

  it('works out the plan at the time of the request, so a cached trial still ends on time', async () => {
    server.clock.now = NOW + 5 * DAY - 60 * 1000;
    expect((await server.request('POST', '/ai', { key: 'trialRunning', body: { task: 'name', tabs: [] } })).status).toBe(400);
    server.clock.now += 2 * 60 * 1000;
    const res = await server.request('POST', '/ai', { key: 'trialRunning', body: { task: 'name', tabs: [] } });
    expect(res.status).toBe(402);
  });

  it('reads ExtensionPay’s JSON defensively', () => {
    expect(readExtPayUser(null)).toBeNull();
    expect(readExtPayUser('paid')).toBeNull();
    expect(
      readExtPayUser({ paid: 'yes', email: 5, plan: { nickname: 'pro-ai-monthly', interval: 'weekly' }, subscriptionStatus: 'odd' }),
    ).toEqual({
      paid: false,
      paidAt: null,
      installedAt: null,
      trialStartedAt: null,
      email: null,
      plan: { unitAmountCents: undefined, currency: undefined, nickname: 'pro-ai-monthly', interval: null, intervalCount: null },
      subscriptionStatus: null,
      subscriptionCancelAt: null,
    });
  });
});

describe('CORS', () => {
  it('answers a preflight from an allowed extension', async () => {
    const res = await server.request('OPTIONS', '/sync', { key: null, origin: EXTENSION });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION);
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(server.extpayUser).not.toHaveBeenCalled();
  });

  it('sets the headers on every response, errors included', async () => {
    const ok = await server.request('GET', '/me', { origin: EXTENSION });
    const refused = await server.request('GET', '/me', { key: null, origin: EXTENSION });
    expect(ok.headers.get('access-control-allow-origin')).toBe(EXTENSION);
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
    const wrongMethod = await server.request('POST', '/me');
    expect(wrongMethod.status).toBe(405);
    expect((await server.request('DELETE', '/sync')).status).toBe(405);
  });

  it('answers 500 when something breaks, without leaking the key', async () => {
    server.store.syncRead = vi.fn().mockRejectedValue(new Error('connection lost'));
    const res = await server.request('GET', '/sync');
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'server', message: expect.any(String) });
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
    expect(JSON.stringify(server.log.mock.calls)).not.toContain(keyOf('proAiMonthly'));
  });
});

describe('sync', () => {
  const write = (body: unknown, key: string = 'proMonthly') => server.request('POST', '/sync', { key, body });

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
    expect(await server.store.syncVersion('account-1')).toBe(1);
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
