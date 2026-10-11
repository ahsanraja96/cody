import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, sha256Hex, type Deps } from '../../server/supabase/functions/tabfold/app.ts';
import { createModel } from '../../server/supabase/functions/tabfold/ai.ts';
import {
  createStripe,
  formEncode,
  readSubscription,
  signWebhook,
  STRIPE_VERSION,
  type Payments,
} from '../../server/supabase/functions/tabfold/stripe.ts';
import { createFakeStripe, parseForm, serveWeb, startFakeStripe, type FakeStripe, type RunningFakeStripe, type WebServer } from './fakeStripe.ts';
import { memoryMailer } from './memoryMailer.ts';
import { MemoryStore } from './memoryStore.ts';

const SECRET = 'whsec_stripe_test';
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MINUTE = 60 * 1000;

let clock: { now: number };
let fake: FakeStripe;
let stripe: Payments;

beforeEach(() => {
  clock = { now: NOW };
  fake = createFakeStripe({ prices: true, webhookSecret: SECRET, now: () => clock.now });
  stripe = createStripe({ secretKey: 'sk_test_123', webhookSecret: SECRET, fetch: fake.fetch, now: () => clock.now });
});

const checkoutInput = {
  lookupKey: 'pro-ai-monthly',
  successUrl: 'https://x.test/done?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://x.test/cancel',
  automaticTax: false,
  metadata: {},
};

describe('form encoding', () => {
  it('nests objects and lists the way Stripe reads them', () => {
    const encoded = formEncode({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      subscription_data: { trial_end: 1790000000, metadata: { account: 'a b' } },
      lookup_keys: ['pro-monthly', 'pro-yearly'],
      allow_promotion_codes: true,
      skipped: null,
      also: undefined,
    });
    expect(decodeURIComponent(encoded).replace(/\+/g, ' ')).toBe(
      'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&subscription_data[trial_end]=1790000000' +
        '&subscription_data[metadata][account]=a b&lookup_keys[]=pro-monthly&lookup_keys[]=pro-yearly&allow_promotion_codes=true',
    );
    expect(parseForm(encoded)).toEqual({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: '1' }],
      subscription_data: { trial_end: '1790000000', metadata: { account: 'a b' } },
      lookup_keys: ['pro-monthly', 'pro-yearly'],
      allow_promotion_codes: 'true',
    });
  });

  it('escapes what needs escaping', () => {
    expect(formEncode({ success_url: 'https://x.test/a?b=c&d={E}' })).toBe('success_url=https%3A%2F%2Fx.test%2Fa%3Fb%3Dc%26d%3D%7BE%7D');
  });
});

describe('createStripe', () => {
  it('creates a checkout session with the price for the lookup key', async () => {
    const session = await stripe.createCheckout({
      ...checkoutInput,
      clientReferenceId: 'acc-1',
      customerEmail: 'sam@example.com',
      trialEnd: NOW / 1000 + 3 * 86400,
      metadata: { account: 'acc-1' },
    });
    expect(session).toEqual({ id: expect.stringMatching(/^cs_test_/), url: `http://fake-stripe.test/pay/${session.id}` });
    const post = fake.requests.find((r) => r.method === 'POST')!;
    expect(post.path).toBe('/v1/checkout/sessions');
    expect(post.stripeVersion).toBe(STRIPE_VERSION);
    expect(post.params).toEqual({
      mode: 'subscription',
      line_items: [{ price: fake.priceFor('pro-ai-monthly')!.id, quantity: '1' }],
      success_url: checkoutInput.successUrl,
      cancel_url: checkoutInput.cancelUrl,
      client_reference_id: 'acc-1',
      allow_promotion_codes: 'true',
      metadata: { account: 'acc-1' },
      customer_email: 'sam@example.com',
      subscription_data: { trial_end: String(NOW / 1000 + 3 * 86400) },
    });
    expect(post.raw).toContain('line_items%5B0%5D%5Bprice%5D=price_');
  });

  it('turns on tax, and saves the address for an existing customer', async () => {
    const customer = fake.addCustomer('sam@example.com');
    await stripe.createCheckout({ ...checkoutInput, customer: customer.id, automaticTax: true });
    const post = fake.requests.find((r) => r.method === 'POST')!;
    expect(post.params).toMatchObject({ customer: customer.id, automatic_tax: { enabled: 'true' }, customer_update: { address: 'auto' } });
    expect(post.params.customer_email).toBeUndefined();
  });

  it('looks prices up by lookup key, and remembers them for 10 minutes', async () => {
    const lookups = () => fake.requests.filter((r) => r.path === '/v1/prices');
    await stripe.createCheckout(checkoutInput);
    await stripe.createCheckout(checkoutInput);
    expect(lookups()).toHaveLength(1);
    expect(lookups()[0]!.params).toEqual({ lookup_keys: ['pro-ai-monthly'], active: 'true', limit: '1' });
    await stripe.createCheckout({ ...checkoutInput, lookupKey: 'pro-yearly' });
    expect(lookups()).toHaveLength(2);
    clock.now = NOW + 10 * MINUTE;
    await stripe.createCheckout(checkoutInput);
    expect(lookups()).toHaveLength(3);
  });

  it('says which lookup key is missing', async () => {
    await expect(stripe.createCheckout({ ...checkoutInput, lookupKey: 'team-monthly' })).rejects.toMatchObject({
      name: 'PaymentsError',
      message: expect.stringContaining('No active Stripe price has the lookup key team-monthly'),
    });
  });

  it('reads a checkout session', async () => {
    const { id } = await stripe.createCheckout({ ...checkoutInput, metadata: { account: 'acc-1' }, clientReferenceId: 'acc-1' });
    expect(await stripe.getCheckout(id)).toEqual({
      id,
      status: 'open',
      customerId: null,
      email: null,
      subscriptionId: null,
      clientReferenceId: 'acc-1',
      metadata: { account: 'acc-1' },
    });
    const { subscription } = await fake.completeSession(id, { email: 'sam@example.com' });
    expect(await stripe.getCheckout(id)).toMatchObject({
      status: 'complete',
      customerId: expect.stringMatching(/^cus_/),
      email: 'sam@example.com',
      subscriptionId: subscription.id,
    });
    clock.now = NOW + 25 * 60 * MINUTE;
    const { id: late } = await stripe.createCheckout(checkoutInput);
    clock.now += 25 * 60 * MINUTE;
    expect((await stripe.getCheckout(late)).status).toBe('expired');
  });

  it('reads the email Stripe was given when the page’s is missing', async () => {
    const { id } = await stripe.createCheckout({ ...checkoutInput, customerEmail: 'kim@example.com' });
    expect((await stripe.getCheckout(id)).email).toBe('kim@example.com');
  });

  it('reads a subscription, times in ms', async () => {
    const customer = fake.addCustomer('sam@example.com');
    const sub = fake.addSubscription({ customer: customer.id, lookupKey: 'pro-ai-yearly', trialEnd: NOW / 1000 + 86400 * 3, cancelAtPeriodEnd: true });
    expect(await stripe.getSubscription(sub.id)).toEqual({
      id: sub.id,
      customerId: customer.id,
      status: 'trialing',
      lookupKey: 'pro-ai-yearly',
      interval: 'year',
      currentPeriodEnd: NOW + 3 * 86400 * 1000,
      cancelAt: NOW + 3 * 86400 * 1000,
      cancelAtPeriodEnd: true,
      trialEnd: NOW + 3 * 86400 * 1000,
      createdAt: NOW,
    });
  });

  it('finds the period end on the first item when the subscription has none (newer API versions)', () => {
    const sub = readSubscription({
      id: 'sub_1',
      customer: { id: 'cus_1', object: 'customer' },
      status: 'active',
      created: 1_790_000_000,
      items: { data: [{ current_period_end: 1_792_000_000, price: { lookup_key: 'pro-monthly', recurring: { interval: 'month' } } }] },
    });
    expect(sub).toMatchObject({ customerId: 'cus_1', currentPeriodEnd: 1_792_000_000_000, lookupKey: 'pro-monthly', interval: 'month' });
    expect(readSubscription({ id: 'sub_2', items: { data: [{ price: { recurring: { interval: 'week' } } }] } })).toMatchObject({
      interval: null,
      status: 'incomplete',
      lookupKey: null,
      currentPeriodEnd: null,
      createdAt: 0,
    });
    expect(() => readSubscription({})).toThrow('without an id');
  });

  it('opens the billing portal, straight on the card form if asked', async () => {
    const customer = fake.addCustomer('sam@example.com');
    const plain = await stripe.createPortal({ customer: customer.id, returnUrl: 'https://x.test/billing/done' });
    expect(plain.url).toMatch(/\/portal\/bps_/);
    await stripe.createPortal({ customer: customer.id, returnUrl: 'https://x.test/billing/done', flow: 'payment-method' });
    const posts = fake.requests.filter((r) => r.path === '/v1/billing_portal/sessions');
    expect(posts[0]!.params).toEqual({ customer: customer.id, return_url: 'https://x.test/billing/done' });
    expect(posts[1]!.params.flow_data).toEqual({
      type: 'payment_method_update',
      after_completion: { type: 'redirect', redirect: { return_url: 'https://x.test/billing/done' } },
    });
  });

  it('turns Stripe’s refusals into PaymentsErrors without the secret', async () => {
    const error = await stripe.getSubscription('sub_missing').catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'PaymentsError', status: 404 });
    expect((error as Error).message).toContain("No such subscription: 'sub_missing'");
    expect((error as Error).message).not.toContain('sk_test_123');
    const refused = createStripe({ secretKey: 'sk_test_bad', webhookSecret: SECRET, fetch: async () => new Response('<html>', { status: 503 }) });
    await expect(refused.getCheckout('cs_1')).rejects.toMatchObject({ name: 'PaymentsError', status: 503 });
  });

  it('turns network failures into PaymentsErrors that don’t quote the request', async () => {
    const offline = createStripe({
      secretKey: 'sk_test_123',
      webhookSecret: SECRET,
      fetch: async () => {
        throw new TypeError('fetch failed: https://api.stripe.com/v1/… Bearer sk_test_123');
      },
    });
    const error = (await offline.getCheckout('cs_1').catch((e: unknown) => e)) as Error;
    expect(error.name).toBe('PaymentsError');
    expect(error.message).toBe('Stripe could not be reached (GET /v1/checkout/sessions/cs_1)');
  });

  it('fails plainly (not as Stripe trouble) when the secret key isn’t set', async () => {
    const unset = createStripe({ secretKey: '', webhookSecret: '', fetch: fake.fetch });
    await expect(unset.getCheckout('cs_1')).rejects.toMatchObject({ name: 'Error', message: 'STRIPE_SECRET_KEY is not set' });
    await expect(unset.verifyWebhook('{}', 't=1,v1=00')).rejects.toMatchObject({ name: 'Error', message: 'STRIPE_WEBHOOK_SECRET is not set' });
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } });
  const t = NOW / 1000;

  it('accepts a good signature', async () => {
    const event = await stripe.verifyWebhook(body, await signWebhook(SECRET, body, t));
    expect(event).toEqual({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } });
  });

  it('accepts any matching v1 among several (secrets being rolled)', async () => {
    const good = (await signWebhook(SECRET, body, t)).split('v1=')[1];
    await expect(stripe.verifyWebhook(body, `t=${t},v1=${'a'.repeat(64)},v0=zzz,v1=${good}`)).resolves.toMatchObject({ id: 'evt_1' });
  });

  it.each([
    ['no header', null],
    ['an empty header', ''],
    ['no timestamp', 'v1=abc'],
    ['no v1', `t=${t}`],
    ['a wrong signature', `t=${t},v1=${'0'.repeat(64)}`],
    ['a short signature', `t=${t},v1=abc`],
  ])('refuses %s', async (_name, header) => {
    await expect(stripe.verifyWebhook(body, header)).rejects.toMatchObject({ name: 'WebhookSignatureError' });
  });

  it('refuses another secret, or a changed body', async () => {
    await expect(stripe.verifyWebhook(body, await signWebhook('whsec_other', body, t))).rejects.toThrow('doesn’t match');
    await expect(stripe.verifyWebhook(`${body} `, await signWebhook(SECRET, body, t))).rejects.toThrow('doesn’t match');
  });

  it('allows 5 minutes either way', async () => {
    for (const offset of [-300, 300]) await expect(stripe.verifyWebhook(body, await signWebhook(SECRET, body, t + offset))).resolves.toBeTruthy();
    for (const offset of [-301, 301]) {
      await expect(stripe.verifyWebhook(body, await signWebhook(SECRET, body, t + offset))).rejects.toThrow('too old');
    }
  });

  it('refuses a signed body that isn’t an event', async () => {
    for (const bad of ['not json', '{"id":"evt_1"}', '{"id":"evt_1","type":"x","data":{}}']) {
      await expect(stripe.verifyWebhook(bad, await signWebhook(SECRET, bad, t))).rejects.toMatchObject({ name: 'WebhookSignatureError' });
    }
  });
});

describe('over HTTP, as in the end-to-end test', () => {
  let running: RunningFakeStripe;
  let api: WebServer;
  let store: MemoryStore;
  let mailer: ReturnType<typeof memoryMailer>;
  const token = 'e2e-computer-token'.padEnd(43, '0');

  beforeEach(async () => {
    store = new MemoryStore();
    mailer = memoryMailer();
    const deps: Deps = {
      store,
      payments: createStripe({ secretKey: 'sk_test_e2e', webhookSecret: SECRET, apiBase: 'http://placeholder' }),
      mailer,
      model: createModel(vi.fn()),
      now: () => Date.now(),
      config: { allowedOrigins: ['*'], publicUrl: '', automaticTax: false, codeSecret: 'secret' },
    };
    api = await serveWeb((request) => handle(request, deps));
    deps.config.publicUrl = `${api.url}/tabfold`;
    running = await startFakeStripe({ prices: true, webhookSecret: SECRET, webhookUrl: `${api.url}/tabfold/stripe/webhook` });
    deps.payments = createStripe({ secretKey: 'sk_test_e2e', webhookSecret: SECRET, apiBase: running.url });
  });

  afterEach(async () => {
    await running.close();
    await api.close();
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${api.url}/tabfold${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as any };
  };

  it('pays on the checkout page, signs the computer in through the webhook, and cancels in the portal', async () => {
    const { json } = await call('POST', '/checkout', { tier: 'pro-ai', interval: 'year' });
    expect(json.url).toBe(`${running.url}/pay/${json.sessionId}`);

    const page = await (await fetch(json.url)).text();
    expect(page).toContain('Subscribe to Tabfold Pro AI');
    expect(page).toContain('$84.00');
    const emailField = /<input type="email"[^>]*>/.exec(page)?.[0];
    expect(emailField).toContain('value=""');
    expect(emailField).not.toContain('readonly');

    const paid = await fetch(json.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=sam%40example.com',
      redirect: 'manual',
    });
    expect(paid.status).toBe(303);
    expect(paid.headers.get('location')).toBe(`${api.url}/tabfold/checkout/done?session_id=${json.sessionId}`);
    expect(running.deliveries.map((d) => [d.type, d.status])).toEqual([
      ['customer.subscription.created', 200],
      ['checkout.session.completed', 200],
    ]);
    expect(store.linkedAccount(await sha256Hex(token))?.email).toBe('sam@example.com');
    expect(await (await fetch(paid.headers.get('location')!)).text()).toContain('You can close this tab');

    const me = await call('GET', '/me');
    expect(me.json.plan).toMatchObject({ tier: 'pro-ai', interval: 'year', status: 'active', email: 'sam@example.com', cancelAt: null });

    const billing = await call('POST', '/billing');
    const portal = await (await fetch(billing.json.url)).text();
    expect(portal).toContain('Tabfold Pro AI');
    expect(portal).toContain('Cancel plan');
    expect(portal).toContain(`${api.url}/tabfold/billing/done`);
    const cancelled = await fetch(`${billing.json.url}/cancel`, { method: 'POST', redirect: 'manual' });
    expect(cancelled.status).toBe(303);
    expect(running.deliveries.at(-1)).toMatchObject({ type: 'customer.subscription.updated', status: 200 });
    const after = await call('GET', '/me');
    expect(after.json.plan).toMatchObject({ tier: 'pro-ai', renewsAt: null });
    expect(after.json.plan.cancelAt).toBeGreaterThan(Date.now());
    expect(await (await fetch(billing.json.url)).text()).toContain('Ends on');
  });

  it('shows the signed-in email read-only, and the trial on the page', async () => {
    await call('POST', '/signin/start', { email: 'kim@example.com', purpose: 'trial' });
    await call('POST', '/signin/finish', { email: 'kim@example.com', code: mailer.lastCode('kim@example.com'), startTrial: true });
    const { json } = await call('POST', '/checkout', { tier: 'pro-ai', interval: 'month' });
    const page = await (await fetch(json.url)).text();
    expect(page).toContain('value="kim@example.com" readonly');
    expect(page).toContain('Free until');
    expect(page).toContain('Cancel and go back');
    const paid = await fetch(json.url, { method: 'POST', body: new URLSearchParams(), redirect: 'manual' });
    expect(paid.status).toBe(303);
    expect((await call('GET', '/me')).json.plan).toMatchObject({ tier: 'pro-ai', trial: null, status: 'active', email: 'kim@example.com' });
  });

  it('opens the card form when asked, and goes back to Tabfold after', async () => {
    await call('POST', '/checkout', { tier: 'pro', interval: 'month' }).then(({ json }) =>
      fetch(json.url, { method: 'POST', body: 'email=sam%40example.com', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' }),
    );
    const { json } = await call('POST', '/billing', { flow: 'payment-method' });
    expect(await (await fetch(json.url)).text()).toContain('Update card');
    const saved = await fetch(`${json.url}/card`, { method: 'POST', redirect: 'manual' });
    expect(saved.headers.get('location')).toBe(`${api.url}/tabfold/billing/done`);
  });
});
