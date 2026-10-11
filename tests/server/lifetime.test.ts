import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../server/supabase/functions/tabfold/app.ts';
import { createServer, DAY, keyOf, newToken, NOW, PUBLIC_URL, type Server } from './fakes';

// Pro for life: one payment (Checkout in payment mode) through the fake Stripe, with the same
// protections as subscriptions for a computer that isn't signed in.

let server: Server;

beforeEach(async () => {
  server = createServer();
  await server.ready;
});

const MINUTE = 60 * 1000;
const LIFETIME = { tier: 'pro-lifetime' };
const me = (key: string) => server.request('GET', '/me', { key });
const checkout = (key: string, body: Record<string, unknown> = LIFETIME) => server.request('POST', '/checkout', { key, body });
const linkedEmail = async (token: string) => server.store.linkedAccount(await sha256Hex(token))?.email ?? null;
const purchasesOf = (email: string) => server.store.purchaseList(server.store.account(email).id);

describe('POST /checkout for Pro for life', () => {
  it('opens a one-time payment for a signed-in account, making a Stripe customer', async () => {
    const res = await checkout(keyOf('free'));
    expect(res.status).toBe(200);
    const session = server.stripe.sessions.get(res.json.sessionId)!;
    const account = server.store.account('free@example.com');
    expect(session).toMatchObject({
      mode: 'payment',
      customer: null,
      customer_email: 'free@example.com',
      customer_creation: 'always',
      metadata: { account: account.id, plan: 'pro-lifetime' },
      client_reference_id: account.id,
      subscription_data: { trial_end: null },
      success_url: `${PUBLIC_URL}/checkout/done?session_id={CHECKOUT_SESSION_ID}`,
    });
    expect(session.line_items).toEqual([{ price: server.stripe.priceFor('pro-lifetime')!.id, quantity: 1 }]);
    const post = server.stripe.requests.find((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')!;
    expect(post.params.subscription_data).toBeUndefined();
  });

  it('uses the account’s Stripe customer when it has one (and no customer_creation then)', async () => {
    const res = await checkout(keyOf('cancelled'));
    expect(server.stripe.sessions.get(res.json.sessionId)).toMatchObject({
      customer: server.store.account('gone@example.com').stripeCustomerId,
      customer_creation: null,
      customer_email: null,
    });
  });

  it('needs no interval, and ignores one', async () => {
    expect((await checkout(keyOf('free'), { tier: 'pro-lifetime', interval: 'week' })).status).toBe(200);
  });

  it('lets someone with a subscription or the trial buy it (to keep Pro after cancelling)', async () => {
    expect((await checkout(keyOf('proAiMonthly'))).status).toBe(200);
    expect((await checkout(keyOf('trialRunning'))).status).toBe(200);
  });

  it('answers 409 already-subscribed when the account already has it', async () => {
    await server.buy('free', LIFETIME);
    const res = await checkout(keyOf('free'));
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: 'already-subscribed', message: 'You already have Tabfold Pro for life.' });
  });

  it('answers 502 when the price isn’t set up in Stripe', async () => {
    server.stripe.priceFor('pro-lifetime')!.active = false;
    const res = await checkout(keyOf('free'));
    expect(res.status).toBe(502);
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining('No active Stripe price has the lookup key pro-lifetime'));
  });
});

describe('paying for Pro for life', () => {
  it('signed in: Pro for ever, nothing renews', async () => {
    const { sessionId } = await server.buy('free', LIFETIME);
    const res = await me('free');
    expect(res.json.plan).toMatchObject({
      tier: 'pro',
      lifetime: true,
      email: 'free@example.com',
      status: null,
      interval: null,
      renewsAt: null,
      cancelAt: null,
    });
    expect(await purchasesOf('free@example.com')).toEqual([
      {
        id: sessionId,
        lookupKey: 'pro-lifetime',
        customerId: expect.stringMatching(/^cus_/),
        paymentIntentId: expect.stringMatching(/^pi_/),
        createdAt: NOW,
      },
    ]);
    // Its customer opens the billing portal (receipts, card).
    expect(server.store.account('free@example.com').stripeCustomerId).toMatch(/^cus_/);
    expect((await server.request('POST', '/billing', { key: 'free' })).status).toBe(200);
    // Pro routes work; Pro AI ones don't.
    expect((await server.request('GET', '/sync', { key: 'free' })).status).toBe(200);
    expect((await server.request('POST', '/ai', { key: 'free', body: { task: 'name', tabs: [] } })).status).toBe(402);
  });

  it('records the purchase once, whether GET /me or the webhook gets there first', async () => {
    const laptop = newToken('laptop');
    const { json } = await checkout(laptop);
    await server.stripe.completeSession(json.sessionId, { email: 'new@example.com' });
    const first = await me(laptop);
    expect(first.json.plan).toMatchObject({ tier: 'pro', lifetime: true, email: 'new@example.com' });
    expect(server.store.pending.size).toBe(0);
    expect(await server.deliverEvents()).toEqual([200]);
    expect(await purchasesOf('new@example.com')).toHaveLength(1);
    expect((await me(laptop)).json.plan.lifetime).toBe(true);
  });

  it('signed out, new email: makes the account and signs this computer in', async () => {
    const laptop = newToken('laptop');
    await server.buy(laptop, LIFETIME, 'Fresh@Example.com');
    expect(await linkedEmail(laptop)).toBe('fresh@example.com');
    expect((await me(laptop)).json.plan).toMatchObject({ tier: 'pro', lifetime: true, email: 'fresh@example.com' });
    expect(server.store.account('fresh@example.com').emailVerifiedAt).toBeNull();
  });

  it('signed out, with the email of an existing account: the purchase lands there, the computer signs in with a code', async () => {
    server.clock.now = NOW + MINUTE;
    const laptop = newToken('laptop');
    await server.buy(laptop, LIFETIME, 'free@example.com');
    expect(await linkedEmail(laptop)).toBeNull();
    const res = await me(laptop);
    expect(res.json.plan.email).toBeNull();
    expect(res.json.needsSignIn).toEqual({ email: 'free@example.com' });
    expect((await me('free')).json.plan).toMatchObject({ tier: 'pro', lifetime: true });
    const signedIn = await server.signIn(laptop, 'free@example.com');
    expect(signedIn.json.plan).toMatchObject({ tier: 'pro', lifetime: true, email: 'free@example.com' });
  });

  it('lets a Pro for life account add Pro AI, and keeps Pro when that ends', async () => {
    await server.buy('free', LIFETIME);
    expect((await checkout(keyOf('free'), { tier: 'pro-ai', interval: 'month' })).status).toBe(200);
    const { subscription } = await server.buy('free', { tier: 'pro-ai', interval: 'month' });
    expect((await me('free')).json.plan).toMatchObject({ tier: 'pro-ai', lifetime: true, status: 'active', interval: 'month' });
    await server.stripe.setSubscription(subscription!.id, { status: 'canceled' }, { event: 'customer.subscription.deleted' });
    await server.deliverEvents();
    expect((await me('free')).json.plan).toMatchObject({ tier: 'pro', lifetime: true, status: null });
  });

  it('lets a Pro for life account start the Pro AI trial', async () => {
    await server.buy('free', LIFETIME);
    const res = await server.request('POST', '/trial', { key: 'free' });
    expect(res.json).toMatchObject({ trialStarted: true, plan: { tier: 'pro-ai', lifetime: true, trial: { startedAt: NOW } } });
    server.clock.now = NOW + 8 * DAY;
    expect((await me('free')).json.plan).toMatchObject({ tier: 'pro', lifetime: true, trial: null });
  });

  it('waits for a payment still on its way (a bank debit), then records it', async () => {
    const laptop = newToken('laptop');
    const { json } = await checkout(laptop);
    const session = server.stripe.sessions.get(json.sessionId)!;
    Object.assign(session, { status: 'complete', payment_status: 'unpaid', customer_details: { email: 'slow@example.com' } });
    const completed = await server.stripe.emit('checkout.session.completed', session);
    expect((await server.webhook(completed)).status).toBe(200);
    expect((await me(laptop)).json.plan.tier).toBe('free');
    expect(server.store.pending.has(json.sessionId)).toBe(true);
    expect([...server.store.accounts.values()].some((a) => a.email === 'slow@example.com')).toBe(false);

    session.payment_status = 'paid';
    const succeeded = await server.stripe.emit('checkout.session.async_payment_succeeded', session);
    expect((await server.webhook(succeeded)).status).toBe(200);
    expect((await me(laptop)).json.plan).toMatchObject({ tier: 'pro', lifetime: true, email: 'slow@example.com' });
  });

  it('pays through the fake Stripe’s page', async () => {
    const { json } = await checkout(keyOf('free'));
    const page = await server.stripe.handle(new Request(`${server.stripe.baseUrl}/pay/${json.sessionId}`));
    const html = await page.text();
    expect(html).toContain('Pay for Tabfold Pro for life');
    expect(html).toContain('$99.00 <small>once</small>');
    const paid = await server.stripe.handle(
      new Request(`${server.stripe.baseUrl}/pay/${json.sessionId}`, { method: 'POST', body: new URLSearchParams({ email: 'free@example.com' }) }),
    );
    expect(paid.status).toBe(303);
    expect(paid.headers.get('location')).toBe(`${PUBLIC_URL}/checkout/done?session_id=${json.sessionId}`);
    expect(server.stripe.events.map((e) => e.type)).toEqual(['checkout.session.completed']);
    await server.deliverEvents();
    expect((await me('free')).json.plan.lifetime).toBe(true);
  });
});
