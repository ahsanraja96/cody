import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../server/supabase/functions/tabfold/app.ts';
import { PaymentsError } from '../../server/supabase/functions/tabfold/stripe.ts';
import { createServer, DAY, keyOf, newToken, NOW, type Server, type UserName } from './fakes';

// Teams through the fake Stripe: the checkout makes the team, invitations, joining by code sign-in
// (which adds seats), removing and leaving (which take them off), the team's folders, and the
// team's plan ending.

let server: Server;

beforeEach(async () => {
  server = createServer();
  await server.ready;
});

const OWNER = 'free' as const;
const OWNER_EMAIL = 'free@example.com';
const sara = newToken('sara');
const mike = newToken('mike');

const get = (key: string, path: string) => server.request('GET', path, { key });
const post = (key: string, path: string, body: unknown = {}) => server.request('POST', path, { key, body });
const team = (key: string = OWNER) => get(key, '/team');
const invite = (emails: string[], key: string = OWNER) => post(key, '/team/invites', { emails });
const plan = async (key: string) => (await get(key, '/me')).json.plan;
const accountId = (email: string) => server.store.account(email).id;

async function buyTeam(options: { seats?: number; teamName?: string; interval?: string; key?: UserName | string; email?: string } = {}) {
  const body: Record<string, unknown> = { tier: 'teams', interval: options.interval ?? 'year', teamName: options.teamName ?? 'Truewidgets' };
  if (options.seats !== undefined) body.seats = options.seats;
  return server.buy(options.key ?? OWNER, body, options.email);
}

/** The team's subscription in the fake Stripe. */
const teamSubscription = (email = OWNER_EMAIL) => server.stripe.subscriptions.get(server.store.teamOfEmail(email)!.subscriptionId!)!;
const seatUpdates = () => server.stripe.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/v1/subscription_items/'));

/** Invites an email and signs it in on a new computer, which joins the team. */
async function join(token: string, email: string) {
  await invite([email]);
  return server.signIn(token, email);
}

describe('buying Teams', () => {
  it('opens a subscription checkout with the seats as quantity and the name in the metadata', async () => {
    const res = await post(keyOf(OWNER), '/checkout', { tier: 'teams', interval: 'month', seats: 5, teamName: '  Truewidgets\n team ' });
    expect(res.status).toBe(200);
    const session = server.stripe.sessions.get(res.json.sessionId)!;
    expect(session).toMatchObject({
      mode: 'subscription',
      customer_email: OWNER_EMAIL,
      metadata: { account: accountId(OWNER_EMAIL), plan: 'teams', teamName: 'Truewidgets team' },
      subscription_data: { trial_end: null },
    });
    expect(session.line_items).toEqual([{ price: server.stripe.priceFor('tabfold-teams-monthly')!.id, quantity: 5 }]);
  });

  it('defaults to 3 seats and “My team”, yearly or monthly', async () => {
    const res = await post(keyOf(OWNER), '/checkout', { tier: 'teams', interval: 'year' });
    const session = server.stripe.sessions.get(res.json.sessionId)!;
    expect(session.line_items).toEqual([{ price: server.stripe.priceFor('tabfold-teams-yearly')!.id, quantity: 3 }]);
    expect(session.metadata.teamName).toBe('My team');
  });

  it.each([
    ['no interval', { tier: 'teams' }],
    ['0 seats', { tier: 'teams', interval: 'year', seats: 0 }],
    ['101 seats', { tier: 'teams', interval: 'year', seats: 101 }],
    ['half a seat', { tier: 'teams', interval: 'year', seats: 2.5 }],
    ['seats as text', { tier: 'teams', interval: 'year', seats: '3' }],
    ['a name that isn’t text', { tier: 'teams', interval: 'year', teamName: 7 }],
  ])('refuses %s with 400', async (_name, body) => {
    const res = await post(keyOf(OWNER), '/checkout', body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('server');
  });

  it('cuts a long name to 60 characters', async () => {
    const res = await post(keyOf(OWNER), '/checkout', { tier: 'teams', interval: 'year', teamName: 'n'.repeat(80) });
    expect(server.stripe.sessions.get(res.json.sessionId)!.metadata.teamName).toBe('n'.repeat(60));
  });

  it('makes the team when paid, with the payer as owner, and gives the owner Pro AI', async () => {
    await buyTeam({ seats: 3 });
    const res = await team();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      team: { id: expect.any(String), name: 'Truewidgets', seats: 3, role: 'owner', status: 'active' },
      members: [{ id: accountId(OWNER_EMAIL), email: OWNER_EMAIL, role: 'owner', joinedAt: NOW }],
      invites: [],
    });
    expect(await plan(keyOf(OWNER))).toMatchObject({
      tier: 'pro-ai',
      interval: 'year',
      status: 'active',
      team: { id: res.json.team.id, name: 'Truewidgets', role: 'owner', seats: 3 },
    });
    expect((await get(keyOf(OWNER), '/me')).json.runs).toMatchObject({ used: 0, limit: 300 });
  });

  it('makes the team once, whether GET /me or the webhook gets there first', async () => {
    const res = await post(keyOf(OWNER), '/checkout', { tier: 'teams', interval: 'year' });
    await server.stripe.completeSession(res.json.sessionId);
    expect((await plan(keyOf(OWNER))).team).toMatchObject({ role: 'owner' });
    await server.deliverEvents();
    expect(server.store.teams.size).toBe(1);
  });

  it('signed out: the new account owns the team and this computer is signed in', async () => {
    const laptop = newToken('laptop');
    await buyTeam({ key: laptop, email: 'boss@example.com' });
    expect(await plan(laptop)).toMatchObject({ email: 'boss@example.com', tier: 'pro-ai', team: { role: 'owner', name: 'Truewidgets' } });
  });

  it('signed out with an existing account’s email: the team is that account’s, the computer signs in with a code', async () => {
    server.clock.now = NOW + 60_000;
    const laptop = newToken('laptop');
    await buyTeam({ key: laptop, email: OWNER_EMAIL });
    const res = await get(laptop, '/me');
    expect(res.json.plan.email).toBeNull();
    expect(res.json.needsSignIn).toEqual({ email: OWNER_EMAIL });
    expect((await plan(keyOf(OWNER))).team).toMatchObject({ role: 'owner' });
  });

  it('answers 409 when the account already owns a team, or is in one', async () => {
    await buyTeam();
    const again = await post(keyOf(OWNER), '/checkout', { tier: 'teams', interval: 'year' });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('already-subscribed');
    // A personal plan too: the owner's plan is the team's.
    expect((await post(keyOf(OWNER), '/checkout', { tier: 'pro', interval: 'month' })).status).toBe(409);
    await join(sara, 'sara@example.com');
    const member = await post(sara, '/checkout', { tier: 'teams', interval: 'year' });
    expect(member.status).toBe(409);
    expect(member.json.message).toContain('Truewidgets');
  });
});

describe('invitations and joining', () => {
  beforeEach(async () => {
    await buyTeam({ seats: 3 });
  });

  it('emails each new address once, from the owner', async () => {
    const res = await invite(['Sara@Example.com', 'mike@example.com', 'sara@example.com']);
    expect(res.json).toEqual({ invited: 2 });
    expect(server.mailer.invites).toEqual([
      { email: 'sara@example.com', team: 'Truewidgets', inviter: OWNER_EMAIL },
      { email: 'mike@example.com', team: 'Truewidgets', inviter: OWNER_EMAIL },
    ]);
    expect((await team()).json.invites).toEqual([
      { email: 'sara@example.com', invitedAt: NOW },
      { email: 'mike@example.com', invitedAt: NOW },
    ]);
    // Already invited, or already in the team: nothing happens.
    expect((await invite(['sara@example.com', OWNER_EMAIL])).json).toEqual({ invited: 0 });
    expect(server.mailer.invites).toHaveLength(2);
  });

  it('joins the team when the invited email signs in with a code', async () => {
    await invite(['sara@example.com']);
    const res = await server.signIn(sara, 'sara@example.com');
    expect(res.status).toBe(200);
    expect(res.json.plan).toMatchObject({ tier: 'pro-ai', email: 'sara@example.com', team: { name: 'Truewidgets', role: 'member', seats: 3 } });
    expect(res.json.runs).toMatchObject({ used: 0 });
    const info = await team(sara);
    expect(info.json.team).toMatchObject({ role: 'member', status: 'active' });
    expect(info.json.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      [OWNER_EMAIL, 'owner'],
      ['sara@example.com', 'member'],
    ]);
    expect(info.json.invites).toEqual([]);
    // Within the seats: Stripe isn't asked.
    expect(seatUpdates()).toHaveLength(0);
  });

  it('doesn’t start a trial for someone who joins a team (it keeps for later)', async () => {
    await invite(['sara@example.com']);
    const res = await server.signIn(sara, 'sara@example.com', true);
    expect(res.json).toMatchObject({ trialStarted: false, trialUsed: false, plan: { tier: 'pro-ai', trial: null } });
    expect(server.store.account('sara@example.com').trialStartedAt).toBeNull();
  });

  it('adds seats (prorated) when the team has more people than seats', async () => {
    await join(sara, 'sara@example.com');
    await join(mike, 'mike@example.com');
    expect(seatUpdates()).toHaveLength(0);
    const kim = newToken('kim');
    const res = await join(kim, 'kim@example.com');
    expect(res.json.plan.team).toMatchObject({ seats: 4 });
    const updates = seatUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.path).toBe(`/v1/subscription_items/${teamSubscription().items.data[0].id}`);
    expect(updates[0]!.params).toEqual({ quantity: '4', proration_behavior: 'create_prorations' });
    expect(teamSubscription().items.data[0].quantity).toBe(4);
    expect(server.stripe.events.at(-1)!.type).toBe('customer.subscription.updated');
    expect((await team()).json.team.seats).toBe(4);
    // Stripe's event about it changes nothing more.
    expect(await server.deliverEvents()).toEqual([200]);
    expect((await plan(keyOf(OWNER))).team.seats).toBe(4);
  });

  it('joins only with a code: a profile key or another computer of the account doesn’t', async () => {
    await invite(['pro@example.com']);
    expect((await get(keyOf('proMonthly'), '/me')).json.plan.team).toBeUndefined();
    const res = await server.signIn(newToken('pro-laptop'), 'pro@example.com');
    expect(res.json.plan).toMatchObject({ tier: 'pro-ai', team: { role: 'member' }, status: 'active', interval: 'month' });
  });

  it('keeps an invitation waiting for someone already in another team', async () => {
    await join(sara, 'sara@example.com');
    // Another team invites Sara.
    await buyTeam({ key: 'proYearly', teamName: 'Other team' });
    await invite(['sara@example.com'], keyOf('proYearly'));
    const res = await server.signIn(newToken('sara-2'), 'sara@example.com');
    expect(res.json.plan.team).toMatchObject({ name: 'Truewidgets' });
    expect((await team(keyOf('proYearly'))).json.invites).toEqual([{ email: 'sara@example.com', invitedAt: NOW }]);
  });

  it('cancels an invitation', async () => {
    await invite(['sara@example.com', 'mike@example.com']);
    expect((await server.request('DELETE', `/team/invites/${encodeURIComponent('Sara@example.com')}`, { key: OWNER })).json).toEqual({ ok: true });
    expect((await team()).json.invites.map((i: { email: string }) => i.email)).toEqual(['mike@example.com']);
    expect((await server.signIn(sara, 'sara@example.com')).json.plan.team).toBeUndefined();
    // Again, or an address that was never invited: fine.
    expect((await server.request('DELETE', '/team/invites/sara%40example.com', { key: OWNER })).status).toBe(200);
    expect((await server.request('DELETE', '/team/invites/not-an-email', { key: OWNER })).status).toBe(200);
  });

  it.each([
    ['no list', {}],
    ['an empty list', { emails: [] }],
    ['more than 20', { emails: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) }],
  ])('refuses %s with 400', async (_name, body) => {
    const res = await post(OWNER, '/team/invites', body);
    expect(res.status).toBe(400);
    expect(server.mailer.invites).toEqual([]);
  });

  it('refuses something that isn’t an email with 400 invalid-email, inviting nobody', async () => {
    const res = await invite(['sara@example.com', 'not an email']);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid-email');
    expect(server.mailer.invites).toEqual([]);
  });

  it('keeps a team to 100 people, invitations included', async () => {
    for (let batch = 0; batch < 4; batch++) {
      expect((await invite(Array.from({ length: 20 }, (_, i) => `p${batch * 20 + i}@example.com`))).json.invited).toBe(20);
    }
    expect((await invite(Array.from({ length: 19 }, (_, i) => `q${i}@example.com`))).json.invited).toBe(19);
    const res = await invite(['last@example.com']);
    expect(res.status).toBe(400);
    expect(res.json.message).toContain('100 people');
  });

  it('sends at most 100 invitations a day per team', async () => {
    for (let batch = 0; batch < 5; batch++) {
      const emails = Array.from({ length: 20 }, (_, i) => `p${batch * 20 + i}@example.com`);
      expect((await invite(emails)).json.invited).toBe(20);
      for (const email of emails) await server.request('DELETE', `/team/invites/${email}`, { key: OWNER });
    }
    const res = await invite(['one-more@example.com']);
    expect(res.status).toBe(429);
    expect(res.json).toMatchObject({ error: 'rate-limited', retryAfter: 24 * 3600, invited: 0 });
    server.clock.now = NOW + DAY;
    expect((await invite(['one-more@example.com'])).json.invited).toBe(1);
  });

  it('answers 502 send-failed when the email can’t be sent, and keeps no invitation', async () => {
    server.mailer.failing = true;
    const res = await invite(['sara@example.com']);
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ error: 'send-failed', invited: 0 });
    expect((await team()).json.invites).toEqual([]);
    expect(JSON.stringify(server.log.mock.calls)).not.toContain('sara@example.com');
    server.mailer.failing = false;
    expect((await invite(['sara@example.com'])).json.invited).toBe(1);
  });

  it('answers 500 when the mailer isn’t set up', async () => {
    server.deps.mailer = { ...server.mailer, sendInvite: async () => Promise.reject(new Error('RESEND_API_KEY is not set')) };
    expect((await invite(['sara@example.com'])).status).toBe(500);
    expect((await team()).json.invites).toEqual([]);
  });

  it('still signs in when Stripe can’t add the seat', async () => {
    await join(sara, 'sara@example.com');
    await join(mike, 'mike@example.com');
    server.deps.payments.updateQuantity = vi.fn().mockRejectedValue(new PaymentsError('Stripe could not be reached'));
    const res = await join(newToken('kim'), 'kim@example.com');
    expect(res.status).toBe(200);
    expect(res.json.plan.team).toMatchObject({ role: 'member', seats: 3 });
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('Changing a team’s seats failed'));
  });
});

describe('removing people and leaving', () => {
  beforeEach(async () => {
    await buyTeam({ seats: 1 });
    await join(sara, 'sara@example.com');
    await join(mike, 'mike@example.com');
  });

  it('raised the seats to the people in the team', () => {
    expect(teamSubscription().items.data[0].quantity).toBe(3);
  });

  it('lets the owner remove someone: they fall back to their own plan, and a seat comes off', async () => {
    const res = await server.request('DELETE', `/team/members/${accountId('sara@example.com')}`, { key: OWNER });
    expect(res.json).toEqual({ ok: true });
    expect(await plan(sara)).toMatchObject({ tier: 'free', email: 'sara@example.com' });
    expect((await plan(sara)).team).toBeUndefined();
    expect((await team(sara)).status).toBe(404);
    expect(teamSubscription().items.data[0].quantity).toBe(2);
    expect(seatUpdates().at(-1)!.params).toEqual({ quantity: '2', proration_behavior: 'create_prorations' });
    expect((await team()).json.members).toHaveLength(2);
  });

  it('lets a member leave, taking a seat off', async () => {
    expect((await post(mike, '/team/leave')).json).toEqual({ ok: true });
    expect((await plan(mike)).team).toBeUndefined();
    expect(teamSubscription().items.data[0].quantity).toBe(2);
  });

  it('never goes below the people left, or 1', async () => {
    await post(mike, '/team/leave');
    await post(sara, '/team/leave');
    expect(teamSubscription().items.data[0].quantity).toBe(1);
  });

  it('keeps unused seats one at a time: 5 seats and 3 people, one leaves, 4 seats', async () => {
    await server.request('POST', '/team/invites', { key: OWNER, body: { emails: ['x@example.com'] } });
    await server.deps.payments.updateQuantity(teamSubscription().items.data[0].id, 5);
    await server.deliverEvents();
    expect((await team()).json.team.seats).toBe(5);
    await post(mike, '/team/leave');
    expect(teamSubscription().items.data[0].quantity).toBe(4);
  });

  it('doesn’t let the owner leave or remove themself', async () => {
    const leave = await post(OWNER, '/team/leave');
    expect(leave.status).toBe(400);
    expect(leave.json.message).toContain('cancel the plan in billing');
    const remove = await server.request('DELETE', `/team/members/${accountId(OWNER_EMAIL)}`, { key: OWNER });
    expect(remove.status).toBe(400);
    expect((await team()).json.members).toHaveLength(3);
  });

  it('answers 404 for someone who isn’t in the team', async () => {
    for (const id of [accountId('pro@example.com'), 'nobody', '00000000-0000-0000-0000-000000000000']) {
      expect((await server.request('DELETE', `/team/members/${id}`, { key: OWNER })).status).toBe(404);
    }
    expect(seatUpdates()).toHaveLength(2);
  });
});

describe('who can do what', () => {
  beforeEach(async () => {
    await buyTeam();
    await join(sara, 'sara@example.com');
  });

  it('answers 401 to a computer that isn’t signed in, 404 to someone in no team', async () => {
    const stranger = newToken('stranger');
    for (const [method, path] of [
      ['GET', '/team'],
      ['PATCH', '/team'],
      ['POST', '/team/invites'],
      ['DELETE', '/team/invites/a%40b.co'],
      ['DELETE', '/team/members/x'],
      ['POST', '/team/leave'],
      ['GET', '/team/sync'],
      ['POST', '/team/sync'],
    ] as const) {
      const body = method === 'POST' || method === 'PATCH' ? {} : undefined;
      expect((await server.request(method, path, { key: stranger, body })).status, `${method} ${path}`).toBe(401);
      const outsider = await server.request(method, path, { key: 'proMonthly', body });
      expect(outsider.status, `${method} ${path}`).toBe(404);
      expect(outsider.json.message).toBe('You’re not in a team.');
    }
  });

  it('keeps renaming, inviting and removing to the owner (403 for members)', async () => {
    for (const [method, path, body] of [
      ['PATCH', '/team', { name: 'Mine now' }],
      ['POST', '/team/invites', { emails: ['x@example.com'] }],
      ['DELETE', '/team/invites/x%40example.com', undefined],
      ['DELETE', `/team/members/${accountId(OWNER_EMAIL)}`, undefined],
    ] as const) {
      const res = await server.request(method, path, { key: sara, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json.message).toBe('Only the team’s owner can do this.');
    }
    expect((await team()).json.team.name).toBe('Truewidgets');
  });

  it('lets the owner rename the team', async () => {
    const res = await server.request('PATCH', '/team', { key: OWNER, body: { name: '  Truewidgets Ltd ' } });
    expect(res.json).toEqual({ team: expect.objectContaining({ name: 'Truewidgets Ltd', role: 'owner', status: 'active' }) });
    expect((await plan(sara)).team.name).toBe('Truewidgets Ltd');
    expect((await server.request('PATCH', '/team', { key: OWNER, body: { name: '   ' } })).status).toBe(400);
    expect((await server.request('PATCH', '/team', { key: OWNER, body: {} })).status).toBe(400);
  });
});

describe('the team’s folders', () => {
  const write = (key: string, body: unknown) => post(key, '/team/sync', body);

  beforeEach(async () => {
    await buyTeam();
    await join(sara, 'sara@example.com');
  });

  it('are shared by everyone in the team, with versions like sync', async () => {
    expect((await get(sara, '/team/sync')).json).toEqual({ items: {}, version: 0 });
    expect((await write(keyOf(OWNER), { set: { 'tf.f': [['abc', 'Client sites']] }, remove: [], baseVersion: 0 })).json).toEqual({ version: 1 });
    expect((await get(sara, '/team/sync')).json).toEqual({ items: { 'tf.f': [['abc', 'Client sites']] }, version: 1 });
    expect((await write(sara, { set: { 'tf.c0': [['x']] }, remove: ['tf.f'], baseVersion: 1 })).json).toEqual({ version: 2 });
    expect((await get(keyOf(OWNER), '/team/sync')).json).toEqual({ items: { 'tf.c0': [['x']] }, version: 2 });
  });

  it('refuses an out-of-date write with 409 and the current version', async () => {
    await write(sara, { set: { 'tf.m': 1 }, remove: [], baseVersion: 0 });
    const res = await write(keyOf(OWNER), { set: { 'tf.m': 2 }, remove: [], baseVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: 'conflict', message: expect.any(String), version: 1 });
  });

  it('checks writes like sync: tf. keys, a version, 8 MB', async () => {
    expect((await write(sara, { set: { other: 1 }, remove: [], baseVersion: 0 })).status).toBe(400);
    expect((await write(sara, { set: {}, remove: [] })).status).toBe(400);
    const half = 'x'.repeat(4 * 1024 * 1024);
    expect((await write(sara, { set: { 'tf.c0': [half] }, remove: [], baseVersion: 0 })).status).toBe(200);
    expect((await write(sara, { set: { 'tf.c1': [half] }, remove: [], baseVersion: 1 })).status).toBe(413);
  });

  it('are kept apart from each person’s own sync and from other teams', async () => {
    await write(sara, { set: { 'tf.m': 'team' }, remove: [], baseVersion: 0 });
    expect((await get(keyOf(OWNER), '/sync')).json).toEqual({ items: {}, version: 0 });
    await buyTeam({ key: 'proYearly', teamName: 'Other team' });
    expect((await get(keyOf('proYearly'), '/team/sync')).json).toEqual({ items: {}, version: 0 });
    await write(keyOf('proYearly'), { set: { 'tf.m': 'other' }, remove: [], baseVersion: 0 });
    expect((await get(sara, '/team/sync')).json.items).toEqual({ 'tf.m': 'team' });
    expect((await get(keyOf('proMonthly'), '/team/sync')).status).toBe(404);
  });

  it('can’t be read by someone who left', async () => {
    await post(sara, '/team/leave');
    expect((await get(sara, '/team/sync')).status).toBe(404);
  });
});

describe('when the team’s plan ends', () => {
  const end = async () => {
    const sub = teamSubscription();
    await server.stripe.setSubscription(sub.id, { status: 'canceled', ended_at: Math.floor(NOW / 1000) }, { event: 'customer.subscription.deleted' });
    await server.deliverEvents();
  };

  beforeEach(async () => {
    await buyTeam();
    await join(sara, 'sara@example.com');
    await post(sara, '/team/sync', { set: { 'tf.m': 1 }, remove: [], baseVersion: 0 });
  });

  it('keeps a past-due team on, and tells the owner', async () => {
    await server.stripe.setSubscription(teamSubscription().id, { status: 'past_due' });
    await server.deliverEvents();
    expect(await plan(keyOf(OWNER))).toMatchObject({ tier: 'pro-ai', status: 'past_due' });
    expect(await plan(sara)).toMatchObject({ tier: 'pro-ai', status: null, team: { role: 'member' } });
    expect((await team()).json.team.status).toBe('past_due');
  });

  it('puts everyone back on their own plan', async () => {
    await end();
    expect(await plan(sara)).toMatchObject({ tier: 'free' });
    expect(await plan(keyOf(OWNER))).toMatchObject({ tier: 'free', status: null });
    expect((await plan(sara)).team).toBeUndefined();
    expect((await team(sara)).json.team.status).toBe('ended');
  });

  it('keeps the folders readable for 30 days, but not writable', async () => {
    await end();
    expect((await get(sara, '/team/sync')).json.items).toEqual({ 'tf.m': 1 });
    const write = await post(sara, '/team/sync', { set: { 'tf.m': 2 }, remove: [], baseVersion: 1 });
    expect(write.status).toBe(402);
    expect(write.json.error).toBe('needs-pro-ai');
    expect((await invite(['x@example.com'])).status).toBe(402);
    server.clock.now = NOW + 30 * DAY - 1;
    expect((await get(sara, '/team/sync')).status).toBe(200);
    server.clock.now = NOW + 30 * DAY;
    expect((await get(sara, '/team/sync')).status).toBe(402);
  });

  it('lets the owner start it again: the same team, people and folders', async () => {
    await end();
    expect((await post(keyOf(OWNER), '/checkout', { tier: 'teams', interval: 'month' })).status).toBe(200);
    const before = server.store.teamOfEmail(OWNER_EMAIL)!.id;
    await buyTeam({ teamName: 'Truewidgets again', interval: 'month' });
    expect(server.store.teamOfEmail(OWNER_EMAIL)!.id).toBe(before);
    expect(await plan(sara)).toMatchObject({ tier: 'pro-ai', team: { name: 'Truewidgets again', role: 'member' } });
    expect((await get(sara, '/team/sync')).json.items).toEqual({ 'tf.m': 1 });
  });

  it('lets a member of an ended team start their own', async () => {
    await end();
    await buyTeam({ key: sara, teamName: 'Sara’s team' });
    expect(await plan(sara)).toMatchObject({ team: { name: 'Sara’s team', role: 'owner' } });
    expect((await team()).json.members).toHaveLength(1);
  });

  it('skips an ended team’s invitation when signing in', async () => {
    await invite(['mike@example.com']);
    await end();
    expect((await server.signIn(mike, 'mike@example.com')).json.plan.team).toBeUndefined();
    expect(server.store.teamOfEmail('mike@example.com')).toBeNull();
  });

  /** Any account's sync write: the first one each day runs the daily prune. */
  const someoneSyncs = async () => {
    const version = (await get('proMonthly', '/sync')).json.version;
    expect((await post('proMonthly', '/sync', { set: { 'tf.m': version }, remove: [], baseVersion: version })).status).toBe(200);
  };
  const teamId = () => server.store.teamOfEmail(OWNER_EMAIL)!.id;

  it('deletes the folders 30 days after the plan ended (the first sync of a day), keeping the team', async () => {
    await end();
    server.clock.now = NOW + 29 * DAY;
    await someoneSyncs();
    expect(server.store.teamSync.get(teamId())?.items).toEqual({ 'tf.m': 1 });
    server.clock.now = NOW + 31 * DAY;
    await someoneSyncs();
    expect(server.store.teamSync.has(teamId())).toBe(false);
    // The server's log is for failures only.
    expect(server.log).not.toHaveBeenCalled();
    // The team and its people stay; starting the plan again starts with no folders.
    expect((await team()).json.members).toHaveLength(2);
    await buyTeam({ interval: 'month' });
    expect((await get(sara, '/team/sync')).json).toEqual({ items: {}, version: 0 });
  });

  it('deletes the folders of a team that ended 31 days ago at the next day’s first sync', async () => {
    const sub = teamSubscription();
    await server.stripe.setSubscription(sub.id, { status: 'canceled', ended_at: Math.floor((NOW - 31 * DAY) / 1000) }, { event: 'customer.subscription.deleted' });
    await server.deliverEvents();
    await someoneSyncs();
    expect(server.store.teamSync.has(teamId())).toBe(false);
  });

  it('never touches a live team’s folders, nor a team that ended 29 days ago', async () => {
    // Another team that ended 29 days ago, with its own folders.
    await server.buy('trialEnded', { tier: 'teams', interval: 'year', teamName: 'Other' });
    const other = server.store.teamOfEmail('ended@example.com')!;
    await post(keyOf('trialEnded'), '/team/sync', { set: { 'tf.m': 'other' }, remove: [], baseVersion: 0 });
    await server.stripe.setSubscription(other.subscriptionId!, { status: 'canceled', ended_at: Math.floor((NOW - 29 * DAY) / 1000) }, { event: 'customer.subscription.deleted' });
    await server.deliverEvents();
    server.clock.now = NOW + 12 * 60 * 60 * 1000;
    await someoneSyncs();
    expect(server.store.teamSync.get(teamId())?.items).toEqual({ 'tf.m': 1 });
    expect(server.store.teamSync.get(other.id)?.items).toEqual({ 'tf.m': 'other' });
    // Two months on, the live team still has its folders (its subscription is still on).
    server.clock.now = NOW + 60 * DAY;
    await someoneSyncs();
    expect(server.store.teamSync.get(teamId())?.items).toEqual({ 'tf.m': 1 });
    expect(server.store.teamSync.has(other.id)).toBe(false);
  });

  it('still saves the sync write when pruning teams fails', async () => {
    server.store.teamSyncPruneEnded = vi.fn().mockRejectedValue(new Error('timeout'));
    await someoneSyncs();
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('Pruning ended teams’ folders failed'));
  });
});

describe('logs', () => {
  it('never contain an invited email, even when something breaks', async () => {
    await buyTeam();
    server.store.teamInviteDelete = vi.fn().mockRejectedValue(new Error('connection lost'));
    const res = await server.request('DELETE', '/team/invites/sara%40example.com', { key: OWNER });
    expect(res.status).toBe(500);
    const logged = JSON.stringify(server.log.mock.calls);
    expect(logged).toContain('DELETE /team/invites/…');
    expect(logged).not.toContain('sara');
  });

  it('keep only hashes and team ids in the rate limits', async () => {
    await buyTeam();
    await invite(['sara@example.com']);
    expect([...server.store.rates.keys()].filter((k) => k.startsWith('invite:'))).toEqual([`invite:${server.store.teamOfEmail(OWNER_EMAIL)!.id}`]);
    expect(LIMITS.invitesPerTeamPerDay).toBe(100);
  });
});
