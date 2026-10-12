import { beforeEach, describe, expect, it } from 'vitest';
import { cleanNote, cutWhole, LIMITS, newShareId, pageAddress, rateKey, readShare, sha256Hex } from '../../server/supabase/functions/tabfold/app.ts';
import { createServer, EXTENSION, newToken, NOW, type Server } from './fakes';

// Shared folders: the owner's routes (Pro), and the public read the `web/` page makes.

let server: Server;

beforeEach(async () => {
  server = createServer();
  await server.ready;
});

const MINUTE = 60 * 1000;
const FOLDER = {
  name: 'Client sites',
  color: 'green',
  live: true,
  tabs: [
    { title: 'Mobile Auto Repair in Rhode Island | Rhode Island Road Rescue', url: 'https://rlroadrescue.com/' },
    { title: 'Aim Travel & Tours | 24/7 Airport Transfers', url: 'https://aimtravel.netlify.app/' },
    { title: 'Project overview | Netlify', url: 'https://app.netlify.com/projects/x' },
  ],
};

const create = (body: unknown = FOLDER, key = 'proMonthly') => server.request('POST', '/shares', { key, body });
const publicRead = (id: string, headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.7' }) =>
  server.request('GET', `/public/shares/${id}`, { key: null, headers, origin: 'https://tabfold.app' });

describe('POST /shares', () => {
  it('shares a folder as a link', async () => {
    const res = await create();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9]{10}$/), url: `https://tabfold.app/s/${res.json.id}` });
    expect(server.store.shares.get(res.json.id)).toMatchObject({
      accountId: server.store.account('pro@example.com').id,
      name: 'Client sites',
      color: 'green',
      live: true,
      views: 0,
      tabs: FOLDER.tabs,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('uses SHARE_BASE_URL for the link', async () => {
    server.deps.config.shareBaseUrl = 'https://share.example.org/';
    const res = await create();
    expect(res.json.url).toBe(`https://share.example.org/s/${res.json.id}`);
  });

  it('works for every paid plan: Pro, Pro AI, the trial, Pro for life', async () => {
    for (const key of ['proYearly', 'proAiMonthly', 'trialRunning', 'pastDue']) expect((await create(FOLDER, key)).status, key).toBe(200);
    await server.buy('free', { tier: 'pro-lifetime' });
    expect((await create(FOLDER, 'free')).status).toBe(200);
  });

  it('answers 402 needs-pro to Free, and 401 to a computer that isn’t signed in', async () => {
    for (const key of ['free', 'trialEnded', 'cancelled']) {
      const res = await create(FOLDER, key);
      expect(res.status, key).toBe(402);
      expect(res.json.error).toBe('needs-pro');
    }
    expect((await create(FOLDER, newToken('stranger'))).status).toBe(401);
    expect(server.store.shares.size).toBe(0);
  });

  it('keeps only what the page may show: http(s) addresses, titles cut to 200, no passwords', async () => {
    const res = await create({
      name: `  ${'Folder '.repeat(20)}`,
      color: 'not-a-colour',
      tabs: [
        { title: `  ${'T'.repeat(250)} `, url: 'https://example.com/a' },
        { title: 'Script', url: 'javascript:alert(1)' },
        { title: 'Data', url: 'data:text/html,<b>x</b>' },
        { title: 'Settings', url: 'chrome://settings' },
        { title: 'File', url: 'file:///etc/passwd' },
        { title: 'Not a URL', url: 'example' },
        { title: 'Long', url: `https://example.com/${'x'.repeat(2000)}` },
        { title: 'Secret', url: 'https://sam:hunter2@example.com/admin' },
        { url: 'http://example.org' },
        { title: 'Line\nbreak', url: ' https://example.net/b ' },
      ],
    });
    expect(res.status).toBe(200);
    const share = server.store.shares.get(res.json.id)!;
    expect(share.name).toHaveLength(LIMITS.shareName);
    expect(share.color).toBe('grey');
    expect(share.live).toBe(false);
    expect(share.tabs).toEqual([
      { title: 'T'.repeat(200), url: 'https://example.com/a' },
      { title: 'Secret', url: 'https://example.com/admin' },
      { title: '', url: 'http://example.org/' },
      { title: 'Line break', url: 'https://example.net/b' },
    ]);
  });

  it('keeps the first 1,000 tabs', async () => {
    const tabs = Array.from({ length: 1200 }, (_, i) => ({ title: `Page ${i}`, url: `https://example.com/${i}` }));
    const res = await create({ ...FOLDER, tabs });
    const kept = server.store.shares.get(res.json.id)!.tabs;
    expect(kept).toHaveLength(1000);
    expect(kept.at(-1)!.title).toBe('Page 999');
  });

  it.each([
    ['no name', { color: 'green', tabs: [] }],
    ['a blank name', { name: '   ', color: 'green', tabs: [] }],
    ['no tabs', { name: 'x', color: 'green' }],
    ['tabs that aren’t a list', { name: 'x', color: 'green', tabs: {} }],
    ['a tab that isn’t an object', { name: 'x', color: 'green', tabs: ['https://example.com'] }],
    ['a list body', []],
  ])('refuses %s with 400', async (_name, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('server');
  });

  it('allows an empty folder', async () => {
    expect((await create({ ...FOLDER, tabs: [] })).status).toBe(200);
  });

  it('keeps an account to 500 shares', async () => {
    const account = server.store.account('pro@example.com').id;
    for (let i = 0; i < LIMITS.sharesPerAccount; i++) await server.store.shareCreate(`share${String(i).padStart(5, '0')}`, account, { ...FOLDER, live: false });
    const res = await create();
    expect(res.status).toBe(400);
    expect(res.json.message).toContain('500');
  });

  it('tries another id when one is taken', async () => {
    const first = 'A'.repeat(10);
    await server.store.shareCreate(first, server.store.account('ai@example.com').id, { ...FOLDER, live: false });
    // The first 16 random bytes make AAAAAAAAAA (taken), the next ones 9999999999.
    const draws = [new Uint8Array(16).fill(0), new Uint8Array(16).fill(61)];
    server.deps.random = (bytes) => draws.shift() ?? new Uint8Array(bytes);
    const res = await create();
    expect(res.json.id).toBe('9'.repeat(10));
  });
});

describe('the owner’s routes', () => {
  let id: string;

  beforeEach(async () => {
    id = (await create()).json.id;
  });

  it('GET /shares/<id> tells its owner the link, views and whether it’s live', async () => {
    await publicRead(id);
    const res = await server.request('GET', `/shares/${id}`, { key: 'proMonthly' });
    expect(res.json).toEqual({ id, url: `https://tabfold.app/s/${id}`, views: 1, live: true, updatedAt: NOW, note: '' });
  });

  it('PUT /shares/<id> replaces the contents', async () => {
    server.clock.now = NOW + MINUTE;
    const res = await server.request('PUT', `/shares/${id}`, {
      key: 'proMonthly',
      body: { name: 'Client sites (new)', color: 'blue', live: false, tabs: [{ title: 'Only one', url: 'https://one.example.com/' }] },
    });
    expect(res.json).toEqual({ id, url: `https://tabfold.app/s/${id}`, views: 0, live: false });
    expect((await publicRead(id)).json).toEqual({
      name: 'Client sites (new)',
      color: 'blue',
      tabs: [{ title: 'Only one', url: 'https://one.example.com/' }],
      updatedAt: NOW + MINUTE,
      note: '',
    });
  });

  it('answers 404 to anyone else, and never shows them the share', async () => {
    for (const [method, body] of [['GET', undefined], ['PUT', FOLDER]] as const) {
      const res = await server.request(method, `/shares/${id}`, { key: 'proAiMonthly', body });
      expect(res.status, method).toBe(404);
    }
    expect((await server.request('DELETE', `/shares/${id}`, { key: 'proAiMonthly' })).status).toBe(200);
    expect((await publicRead(id)).status).toBe(200);
    expect(server.store.shares.get(id)!.name).toBe('Client sites');
  });

  it('answers 404 for an id that can’t be one', async () => {
    for (const bad of ['short', 'has spaces!', 'x'.repeat(11)]) {
      expect((await server.request('GET', `/shares/${encodeURIComponent(bad)}`, { key: 'proMonthly' })).status).toBe(404);
    }
  });

  it('DELETE /shares/<id> stops the link at once, and is fine twice', async () => {
    expect((await server.request('DELETE', `/shares/${id}`, { key: 'proMonthly' })).json).toEqual({ ok: true });
    const res = await publicRead(id);
    expect(res.status).toBe(404);
    expect(res.json.message).toBe('This link doesn’t work any more.');
    expect((await server.request('DELETE', `/shares/${id}`, { key: 'proMonthly' })).json).toEqual({ ok: true });
    expect((await server.request('GET', `/shares/${id}`, { key: 'proMonthly' })).status).toBe(404);
  });

  it('outlives the plan: still readable, can be stopped, but only Pro can change it', async () => {
    const subId = [...server.store.subscriptions.values()].find((s) => s.accountId === server.store.account('pro@example.com').id)!.subscription.id;
    await server.stripe.setSubscription(subId, { status: 'canceled' }, { event: 'customer.subscription.deleted' });
    await server.deliverEvents();
    expect((await server.request('GET', '/me', { key: 'proMonthly' })).json.plan.tier).toBe('free');
    expect((await publicRead(id)).status).toBe(200);
    expect((await server.request('GET', `/shares/${id}`, { key: 'proMonthly' })).status).toBe(200);
    const update = await server.request('PUT', `/shares/${id}`, { key: 'proMonthly', body: FOLDER });
    expect(update.status).toBe(402);
    expect(update.json.error).toBe('needs-pro');
    expect((await create()).status).toBe(402);
    expect((await server.request('DELETE', `/shares/${id}`, { key: 'proMonthly' })).status).toBe(200);
    expect((await publicRead(id)).status).toBe(404);
  });

  it('needs a signed-in computer for each', async () => {
    const stranger = newToken('stranger');
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect((await server.request(method, `/shares/${id}`, { key: stranger, body: method === 'PUT' ? FOLDER : undefined })).status).toBe(401);
    }
  });
});

describe('GET /public/shares/<id>', () => {
  let id: string;

  beforeEach(async () => {
    id = (await create()).json.id;
  });

  it('answers anyone, with no token, and counts each read', async () => {
    const res = await publicRead(id);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ name: 'Client sites', color: 'green', tabs: FOLDER.tabs, updatedAt: NOW, note: '' });
    await publicRead(id);
    expect(server.store.shares.get(id)!.views).toBe(2);
  });

  it('lets any site read it (CORS *), preflight included', async () => {
    const res = await publicRead(id);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    const preflight = await server.request('OPTIONS', `/public/shares/${id}`, { key: null, origin: 'https://tabfold.app' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    const missing = await publicRead('nothing123');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('access-control-allow-origin')).toBe('*');
    // The other routes still only answer the extension.
    const other = await server.request('GET', '/me', { origin: 'https://tabfold.app' });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect((await server.request('GET', '/me', { origin: EXTENSION })).headers.get('access-control-allow-origin')).toBe(EXTENSION);
  });

  it('ignores a token if one is sent', async () => {
    expect((await server.request('GET', `/public/shares/${id}`, { key: 'free' })).status).toBe(200);
  });

  it('answers 404 for an unknown or malformed id, and only GET', async () => {
    for (const bad of ['nothing123', 'bad', '%E0%A4%A']) expect((await publicRead(bad)).status, bad).toBe(404);
    expect((await server.request('POST', `/public/shares/${id}`, { key: null, body: {} })).status).toBe(405);
  });

  it('allows 60 reads a minute per address, counted against an HMAC of it', async () => {
    for (let i = 0; i < 60; i++) expect((await publicRead(id)).status).toBe(200);
    const res = await publicRead(id);
    expect(res.status).toBe(429);
    expect(res.json).toEqual({ error: 'rate-limited', message: expect.any(String), retryAfter: 60 });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // Another address is fine; so is the same one a minute later.
    expect((await publicRead(id, { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' })).status).toBe(200);
    server.clock.now = NOW + MINUTE;
    expect((await publicRead(id)).status).toBe(200);
    const keys = [...server.store.rates.keys()];
    const ipKey = (ip: string) => rateKey(server.deps.config.codeSecret, 'share-read', ip);
    expect(keys).toContain(await ipKey('203.0.113.7'));
    expect(keys).toContain(await ipKey('198.51.100.1'));
    // A keyed HMAC, not a plain SHA-256 that anyone could match by hashing every IPv4 address.
    expect(keys).not.toContain(`share-read:${await sha256Hex('203.0.113.7')}`);
    expect(JSON.stringify(keys)).not.toContain('203.0.113.7');
  });

  it('prefers Cloudflare’s address over X-Forwarded-For', async () => {
    await publicRead(id, { 'cf-connecting-ip': '192.0.2.5', 'x-forwarded-for': '203.0.113.7' });
    expect([...server.store.rates.keys()]).toContain(await rateKey(server.deps.config.codeSecret, 'share-read', '192.0.2.5'));
  });
});

describe('a folder’s note (1.0)', () => {
  const NOTE = 'Waiting on the client’s feedback';

  it('is kept with the share, and shown to its owner and on the public page', async () => {
    const res = await create({ ...FOLDER, note: NOTE });
    expect(res.status).toBe(200);
    const { id } = res.json;
    expect(server.store.shares.get(id)!.note).toBe(NOTE);
    expect((await publicRead(id)).json).toEqual({ name: 'Client sites', color: 'green', tabs: FOLDER.tabs, updatedAt: NOW, note: NOTE });
    expect((await server.request('GET', `/shares/${id}`, { key: 'proMonthly' })).json.note).toBe(NOTE);
  });

  it('is replaced by PUT, and goes when a PUT has none', async () => {
    const { id } = (await create({ ...FOLDER, note: NOTE })).json;
    await server.request('PUT', `/shares/${id}`, { key: 'proMonthly', body: { ...FOLDER, note: 'Sent the invoice' } });
    expect((await publicRead(id)).json.note).toBe('Sent the invoice');
    await server.request('PUT', `/shares/${id}`, { key: 'proMonthly', body: FOLDER });
    expect((await publicRead(id)).json.note).toBe('');
  });

  it('is one line, whitespace squeezed, without control characters', async () => {
    const { id } = (await create({ ...FOLDER, note: '  Call   Sam\n\nthen\tsend\u2028the\u0007brief  ' })).json;
    expect((await publicRead(id)).json.note).toBe('Call Sam then send the brief');
  });

  it('keeps 140 characters and cuts longer ones, never partway through a character', async () => {
    expect(cleanNote('n'.repeat(140))).toBe('n'.repeat(140));
    expect(cleanNote('n'.repeat(150))).toBe('n'.repeat(140));
    // An emoji outside the Basic Multilingual Plane is one character (two UTF-16 units): never half of one.
    expect(cleanNote(`${'n'.repeat(139)}😀😀`)).toBe(`${'n'.repeat(139)}😀`);
    // A flag is two characters that only make sense together, and an accent belongs to its letter.
    expect(cleanNote(`${'n'.repeat(139)}🇵🇹 Lisbon`)).toBe('n'.repeat(139));
    expect(cleanNote(`${'n'.repeat(139)}e\u0301`)).toBe('n'.repeat(139));
    expect(cleanNote(`${'n'.repeat(138)}e\u0301`)).toBe(`${'n'.repeat(138)}e\u0301`);
    const { id } = (await create({ ...FOLDER, note: `${'é'.repeat(139)}😀😀` })).json;
    const note: string = (await publicRead(id)).json.note;
    expect(Array.from(note)).toHaveLength(140);
    expect(note).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('is empty when it isn’t text', async () => {
    for (const note of [42, null, { text: 'x' }, ['x'], '   ']) {
      const { id } = (await create({ ...FOLDER, note })).json;
      expect((await publicRead(id)).json.note).toBe('');
    }
  });

  it('cuts by whole characters', () => {
    expect(cutWhole('abc', 3)).toBe('abc');
    expect(cutWhole('abcd', 3)).toBe('abc');
    expect(cutWhole('ab👍🏽', 3)).toBe('ab');
    expect(cutWhole('ab👍🏽', 4)).toBe('ab👍🏽');
  });
});

describe('share helpers', () => {
  it('makes uniform 10-character ids from letters and digits', () => {
    expect(newShareId()).toMatch(/^[A-Za-z0-9]{10}$/);
    // Bytes from 248 up are drawn again (248 = 4 × 62); the rest pick A–Z, a–z, 0–9 by their remainder.
    const draws = [Uint8Array.from([248, 255, 0, 1, 61, 62, 123, 124, 247, 10, 11, 12, 13, 14, 15, 16])];
    expect(newShareId(() => draws.shift()!)).toBe('AB9A9A9KLM');
  });

  it('cleans addresses', () => {
    expect(pageAddress('https://example.com')).toBe('https://example.com/');
    expect(pageAddress('http://user@example.com/x?y=1#z')).toBe('http://example.com/x?y=1#z');
    for (const bad of [null, 5, '', 'ftp://example.com', 'javascript:void(0)', 'about:blank', '//example.com']) expect(pageAddress(bad)).toBeNull();
  });

  it('reads a share body', () => {
    expect(readShare({ name: 'x', color: 'purple', tabs: [], live: 'yes' })).toEqual({ name: 'x', color: 'purple', tabs: [], live: false, note: '' });
  });
});
