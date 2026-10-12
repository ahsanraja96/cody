import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, trialFingerprint } from '../../server/supabase/functions/tabfold/app.ts';
import { PaymentsError } from '../../server/supabase/functions/tabfold/stripe.ts';
import { createServer, keyOf, newToken, NOW, type Server, type UserName } from './fakes';

// Deleting an account (1.0, POST /account/delete): the confirmation, Stripe first, then everything
// kept for the account in one step; a team it owns ends, a team it's in gets a seat fewer.

let server: Server;

beforeEach(async () => {
  server = createServer();
  await server.ready;
});

const EMAIL = 'ai@example.com';
const del = (key: UserName | string | null, body: unknown) => server.request('POST', '/account/delete', { key, body });
const deleteAccount = (key: UserName | string = 'proAiMonthly', confirm = EMAIL) => del(key, { confirm });
const plan = async (key: UserName | string) => (await server.request('GET', '/me', { key })).json.plan;
const accountOf = (email: string) => [...server.store.accounts.values()].find((account) => account.email === email) ?? null;
const devicesOf = (accountId: string) => [...server.store.devices.values()].filter((device) => device.accountId === accountId);
const subscriptionOf = (email: string) =>
  [...server.store.subscriptions.values()].find((row) => row.accountId === accountOf(email)?.id)!.subscription;
const stripeDeletes = () => server.stripe.requests.filter((r) => r.method === 'DELETE');
const FOLDER = { name: 'Client sites', color: 'green', live: false, tabs: [{ title: 'Brief', url: 'https://example.com/brief' }] };
const chunk = (n: number) => Array.from({ length: n }, (_, i) => [`tab${String(i).padStart(9, '0')}`, `https://example.com/${i}`, `Tab ${i}`, 1_700_000_000]);

describe('POST /account/delete', () => {
  it('needs the account’s email, typed: anything else is 400 invalid and changes nothing', async () => {
    for (const body of [{ confirm: '' }, { confirm: 'pro@example.com' }, { confirm: 'ai@example' }, { confirm: 42 }, {}]) {
      const res = await del('proAiMonthly', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toEqual({ error: 'invalid', message: 'Type your account’s email to confirm.' });
    }
    expect(accountOf(EMAIL)).not.toBeNull();
    expect(stripeDeletes()).toEqual([]);
    expect((await plan('proAiMonthly')).tier).toBe('pro-ai');
  });

  it('takes the email with other capitals and spaces at the ends', async () => {
    const res = await deleteAccount('proAiMonthly', '  AI@Example.com ');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(accountOf(EMAIL)).toBeNull();
  });

  it('needs a signed-in computer (401), and only POST', async () => {
    expect((await deleteAccount(newToken('stranger'), EMAIL)).status).toBe(401);
    expect((await del(null, { confirm: EMAIL })).json.error).toBe('not-signed-in');
    expect((await server.request('GET', '/account/delete')).status).toBe(405);
    expect(accountOf(EMAIL)).not.toBeNull();
  });

  it('works for a signed-in account on Free too', async () => {
    expect((await deleteAccount('free', 'free@example.com')).status).toBe(200);
    expect(accountOf('free@example.com')).toBeNull();
    expect(stripeDeletes()).toEqual([]);
  });

  it('deletes everything kept for the account, and signs out every computer', async () => {
    const laptop = newToken('laptop');
    await server.signIn(laptop, EMAIL);
    const profileKey = newToken('profile-key');
    await server.request('POST', '/profile', { key: laptop, body: { profileKey } });
    // Synced tabs and today's backup, an older backup, a shared folder, AI runs, Pro for life,
    // a checkout started but not paid, and a code asked for on a third computer.
    await server.request('POST', '/sync', { body: { set: { 'tf.c0': chunk(3) }, remove: [], baseVersion: 0 } });
    const id = accountOf(EMAIL)!.id;
    await server.store.backupPut(id, { day: '2026-10-01', items: {}, tabCount: 0, createdAt: NOW });
    const share = (await server.request('POST', '/shares', { body: FOLDER })).json.id as string;
    await server.store.setUsage(EMAIL, { runs: 12, light: 40 });
    await server.buy('proAiMonthly', { tier: 'pro-lifetime' });
    expect((await server.request('POST', '/checkout', { key: laptop, body: { tier: 'pro-lifetime' } })).status).toBe(409);
    await server.request('POST', '/signin/start', { key: newToken('desktop'), body: { email: EMAIL, purpose: 'signin' } });
    const unpaid = (await server.request('POST', '/checkout', { key: newToken('desktop'), body: { tier: 'pro', interval: 'month' } })).json.sessionId;
    expect(server.store.purchases.size).toBe(1);
    expect(server.store.codes.has(EMAIL)).toBe(true);
    expect(devicesOf(id)).toHaveLength(3);

    expect((await deleteAccount()).status).toBe(200);

    expect(accountOf(EMAIL)).toBeNull();
    expect(devicesOf(id)).toEqual([]);
    expect(server.store.linkedAccount(await sha256Hex(profileKey))).toBeNull();
    expect(server.store.sync.has(id)).toBe(false);
    expect(server.store.backups.has(id)).toBe(false);
    expect(server.store.shares.has(share)).toBe(false);
    expect((await server.request('GET', `/public/shares/${share}`, { key: null })).status).toBe(404);
    expect(server.store.codes.has(EMAIL)).toBe(false);
    expect([...server.store.usage.keys()].filter((key) => key.startsWith(`${id}|`))).toEqual([]);
    expect(server.store.purchases.size).toBe(0);
    expect([...server.store.subscriptions.values()].filter((row) => row.accountId === id)).toEqual([]);
    // A checkout another computer started, not paid: not the account's, so it stays.
    expect(server.store.pending.has(unpaid)).toBe(true);
    for (const key of ['proAiMonthly', laptop] as const) {
      expect(await plan(key), key).toMatchObject({ tier: 'free', email: null });
      expect((await server.request('GET', '/sync', { key })).status, key).toBe(401);
    }
    expect((await server.request('POST', '/signin/profile', { key: newToken('another'), body: { profileKey } })).status).toBe(401);
  });

  it('cancels the subscription at Stripe at once; Stripe’s own events change nothing afterwards', async () => {
    const subscription = subscriptionOf(EMAIL);
    expect((await deleteAccount()).status).toBe(200);
    expect(stripeDeletes().map((r) => r.path)).toEqual([`/v1/subscriptions/${subscription.id}`]);
    expect(server.stripe.subscriptions.get(subscription.id)).toMatchObject({ status: 'canceled', ended_at: NOW / 1000 });
    expect(server.stripe.events.at(-1)!.type).toBe('customer.subscription.deleted');
    expect(await server.deliverEvents()).toEqual(expect.arrayContaining([200]));
    expect(accountOf(EMAIL)).toBeNull();
    expect(server.store.subscriptions.has(subscription.id)).toBe(false);
  });

  it('cancels at once a plan that was already set to end, and a late one; never one that has ended', async () => {
    for (const [key, email] of [['proAiYearly', 'ai-yearly@example.com'], ['pastDue', 'late@example.com']] as const) {
      const subscription = subscriptionOf(email);
      expect((await deleteAccount(key, email)).status).toBe(200);
      expect(server.stripe.subscriptions.get(subscription.id)!.status).toBe('canceled');
    }
    const before = stripeDeletes().length;
    expect((await deleteAccount('cancelled', 'gone@example.com')).status).toBe(200);
    expect(stripeDeletes()).toHaveLength(before);
  });

  it('skips a subscription Stripe has already ended even when the stored state is behind', async () => {
    const subscription = subscriptionOf(EMAIL);
    await server.stripe.setSubscription(subscription.id, { status: 'canceled' }, { event: false });
    expect((await deleteAccount()).status).toBe(200);
    expect(stripeDeletes()).toEqual([]);
    expect(accountOf(EMAIL)).toBeNull();
  });

  it('takes a subscription Stripe doesn’t know (a test-mode id after switching to live keys) as ended', async () => {
    const subscription = subscriptionOf(EMAIL);
    server.stripe.subscriptions.delete(subscription.id);
    const res = await deleteAccount();
    expect(res.status).toBe(200);
    expect(accountOf(EMAIL)).toBeNull();
    expect(server.stripe.requests.filter((r) => r.path === `/v1/subscriptions/${subscription.id}`).map((r) => r.method)).toEqual(['GET']);
  });

  it('still stops on any other Stripe error, deleting nothing', async () => {
    const get = server.deps.payments.getSubscription;
    server.deps.payments.getSubscription = vi.fn().mockRejectedValue(new PaymentsError('Stripe answered 500', 500));
    expect((await deleteAccount()).status).toBe(502);
    expect(accountOf(EMAIL)).not.toBeNull();
    server.deps.payments.getSubscription = get;
  });

  it('deletes nothing when Stripe can’t be reached, so the person can try again', async () => {
    const cancel = server.deps.payments.cancelSubscription;
    server.deps.payments.cancelSubscription = vi.fn().mockRejectedValue(new PaymentsError('Stripe could not be reached'));
    const res = await deleteAccount();
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('server');
    expect(accountOf(EMAIL)).not.toBeNull();
    expect((await plan('proAiMonthly')).tier).toBe('pro-ai');
    server.deps.payments.cancelSubscription = cancel;
    expect((await deleteAccount()).status).toBe(200);
    expect(accountOf(EMAIL)).toBeNull();
  });

  it('leaves other accounts as they were', async () => {
    const other = 'pro@example.com';
    await server.request('POST', '/sync', { key: 'proMonthly', body: { set: { 'tf.c0': chunk(2) }, remove: [], baseVersion: 0 } });
    const share = (await server.request('POST', '/shares', { key: 'proMonthly', body: FOLDER })).json.id as string;
    const before = JSON.stringify({
      account: accountOf(other),
      devices: devicesOf(accountOf(other)!.id),
      sync: server.store.sync.get(accountOf(other)!.id),
      backups: [...server.store.backups.get(accountOf(other)!.id)!.values()],
      subscription: subscriptionOf(other),
    });
    expect((await deleteAccount()).status).toBe(200);
    expect(
      JSON.stringify({
        account: accountOf(other),
        devices: devicesOf(accountOf(other)!.id),
        sync: server.store.sync.get(accountOf(other)!.id),
        backups: [...server.store.backups.get(accountOf(other)!.id)!.values()],
        subscription: subscriptionOf(other),
      }),
    ).toBe(before);
    expect(server.stripe.subscriptions.get(subscriptionOf(other).id)!.status).toBe('active');
    expect((await server.request('GET', `/public/shares/${share}`, { key: null })).status).toBe(200);
    expect((await plan('proMonthly')).tier).toBe('pro');
  });

  it('starts a new, empty account if the same email signs in again', async () => {
    const old = accountOf(EMAIL)!.id;
    await deleteAccount();
    const res = await server.signIn(newToken('later'), EMAIL);
    expect(res.status).toBe(200);
    expect(res.json.plan).toMatchObject({ tier: 'free', email: EMAIL });
    expect(accountOf(EMAIL)!.id).not.toBe(old);
    expect(server.store.sync.has(accountOf(EMAIL)!.id)).toBe(false);
  });
});

describe('one trial per email, even after deleting the account', () => {
  const SAM = 'sam@example.com';
  const fingerprint = (email: string) => trialFingerprint(server.deps.config.codeSecret, email);

  it('keeps a one-way fingerprint of the email when the trial starts, never the address', async () => {
    const res = await server.signIn(newToken('sam'), SAM, true);
    expect(res.json).toMatchObject({ trialStarted: true, trialUsed: false });
    expect([...server.store.trialHashes]).toEqual([await fingerprint(SAM)]);
    expect(await fingerprint(SAM)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...server.store.trialHashes])).not.toMatch(/sam|example|@/);
  });

  it('after deleting the account, the same email gets no new trial; another email still does', async () => {
    const laptop = newToken('sam');
    await server.signIn(laptop, SAM, true);
    expect((await deleteAccount(laptop, SAM)).status).toBe(200);
    expect(accountOf(SAM)).toBeNull();
    expect(server.store.trialHashes.has(await fingerprint(SAM))).toBe(true);

    // Signing up again with the same email (any capitals): signed in, but no trial.
    const again = newToken('sam-again');
    const res = await server.signIn(again, '  Sam@Example.com ', true);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ plan: { tier: 'free', trial: null, trialUsed: true, email: SAM }, trialStarted: false, trialUsed: true });
    expect((await server.request('POST', '/trial', { key: again })).json).toMatchObject({ trialStarted: false, trialUsed: true });
    expect(await plan(again)).toMatchObject({ tier: 'free', trialUsed: true });
    expect(accountOf(SAM)!.trialStartedAt).toBeNull();

    // Someone else is unaffected.
    const other = await server.signIn(newToken('kim'), 'kim@example.com', true);
    expect(other.json).toMatchObject({ plan: { tier: 'pro-ai' }, trialStarted: true, trialUsed: false });
  });

  it('covers a trial from before 1.0 (no fingerprint yet): deleting the account keeps one', async () => {
    const email = 'trial@example.com';
    expect(server.store.trialHashes.size).toBe(0);
    expect((await deleteAccount('trialRunning', email)).status).toBe(200);
    expect([...server.store.trialHashes]).toEqual([await fingerprint(email)]);
    const res = await server.signIn(newToken('back'), email, true);
    expect(res.json).toMatchObject({ trialStarted: false, trialUsed: true });
  });

  it('keeps nothing for an account that never had a trial: signing up again can start one', async () => {
    expect((await deleteAccount('free', 'free@example.com')).status).toBe(200);
    expect(server.store.trialHashes.size).toBe(0);
    const res = await server.signIn(newToken('free-again'), 'free@example.com', true);
    expect(res.json).toMatchObject({ trialStarted: true });
  });
});

describe('deleting an account and teams', () => {
  const OWNER_EMAIL = 'free@example.com';
  const sara = newToken('sara');

  async function makeTeam(seats = 3) {
    await server.buy('free', { tier: 'teams', interval: 'year', seats, teamName: 'Truewidgets' });
    await server.request('POST', '/team/invites', { key: 'free', body: { emails: ['sara@example.com'] } });
    await server.signIn(sara, 'sara@example.com');
    await server.request('POST', '/team/sync', { key: sara, body: { set: { 'tf.c0': chunk(2) }, remove: [], baseVersion: 0 } });
    await server.request('POST', '/team/invites', { key: 'free', body: { emails: ['mike@example.com'] } });
    return server.store.teamOfEmail(OWNER_EMAIL)!;
  }

  it('the owner: the team ends for everyone at once, and its subscription is cancelled', async () => {
    const team = await makeTeam();
    expect((await plan(sara)).team).toMatchObject({ name: 'Truewidgets', role: 'member' });
    expect((await deleteAccount('free', OWNER_EMAIL)).status).toBe(200);
    expect(server.stripe.subscriptions.get(team.subscriptionId!)!.status).toBe('canceled');
    expect(server.store.teams.size).toBe(0);
    expect(server.store.teamSync.has(team.id)).toBe(false);
    expect(server.store.teamInviteRows.size).toBe(0);
    expect(server.store.teamMembersByAccount.size).toBe(0);
    // Sara keeps her own account, without the team.
    expect(accountOf('sara@example.com')).not.toBeNull();
    const saraPlan = await plan(sara);
    expect(saraPlan).toMatchObject({ tier: 'free', email: 'sara@example.com' });
    expect(saraPlan.team ?? null).toBeNull();
    expect((await server.request('GET', '/team', { key: sara })).status).toBe(404);
    expect((await server.request('GET', '/team/sync', { key: sara })).status).toBe(404);
  });

  it('a member: leaves the team, which gets one seat fewer and carries on', async () => {
    const team = await makeTeam(3);
    expect((await deleteAccount(sara, 'sara@example.com')).status).toBe(200);
    expect(accountOf('sara@example.com')).toBeNull();
    const subscription = server.stripe.subscriptions.get(team.subscriptionId!)!;
    expect(subscription.status).toBe('active');
    expect(subscription.items.data[0].quantity).toBe(2);
    const res = await server.request('GET', '/team', { key: 'free' });
    expect(res.json.members.map((m: { email: string }) => m.email)).toEqual([OWNER_EMAIL]);
    expect(res.json.invites.map((i: { email: string }) => i.email)).toEqual(['mike@example.com']);
    expect(Object.keys((await server.request('GET', '/team/sync', { key: 'free' })).json.items)).toEqual(['tf.c0']);
    expect((await plan('free')).team).toMatchObject({ role: 'owner', seats: 2 });
  });

  it('an invitation someone else sent to the email is theirs: it stays on their team’s list', async () => {
    await makeTeam();
    await server.request('POST', '/team/invites', { key: 'free', body: { emails: [EMAIL] } });
    expect((await deleteAccount()).status).toBe(200);
    const invites = (await server.request('GET', '/team', { key: 'free' })).json.invites.map((i: { email: string }) => i.email);
    expect(invites).toContain(EMAIL);
  });

  it('keeps the device token of a team owner’s other computers out, too', async () => {
    await makeTeam();
    const laptop = newToken('owner-laptop');
    await server.signIn(laptop, OWNER_EMAIL);
    await deleteAccount('free', OWNER_EMAIL);
    expect((await plan(laptop)).email).toBeNull();
    expect((await plan(keyOf('free'))).email).toBeNull();
  });
});
