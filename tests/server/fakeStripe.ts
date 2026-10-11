import { signWebhook, STRIPE_VERSION } from '../../server/supabase/functions/tabfold/stripe.ts';

/**
 * A fake Stripe for the server tests and the end-to-end Pro test (e2e/pro.mjs): the REST subset
 * that server/supabase/functions/tabfold/stripe.ts and server/scripts/stripe-setup.mjs use, and
 * simple pages standing in for Checkout (`/pay/<session id>`) and the billing portal
 * (`/portal/<id>`). Plain Node, no test-runner imports.
 *
 * Checkout does subscriptions (with a quantity: a Teams plan's seats) and one-time payments
 * (`mode=payment`: Pro for life); "Pay" on the page completes either. Changing a subscription
 * item's quantity (`POST /v1/subscription_items/<id>`) sends `customer.subscription.updated`.
 *
 * - `createFakeStripe()` answers web-standard Requests (`fake.fetch`), with no network: pass
 *   `fetch: fake.fetch` to createStripe.
 * - `startFakeStripe({ port })` also serves it over HTTP (for a browser, the setup script, or
 *   `apiBase: fake.url`).
 *
 * Signed webhook events go to `webhookUrl` when it's set; every event is also kept in `events`.
 *
 * In the end-to-end test, roughly:
 *
 *   const api = await serveWeb((req) => handle(req, deps), { port: API_PORT });
 *   const stripe = await startFakeStripe({ port: STRIPE_PORT, webhookSecret: SECRET,
 *     webhookUrl: `${api.url}/tabfold/stripe/webhook` });
 *   deps.payments = createStripe({ secretKey: 'sk_test_e2e', webhookSecret: SECRET, apiBase: stripe.url });
 */

/** Stripe objects are loose JSON here. */
export type StripeObject = Record<string, any>;

export interface FakeStripeOptions {
  /** Where the pages are served (session and portal addresses). startFakeStripe sets it. */
  baseUrl?: string;
  /** Signed events are POSTed here, as Stripe sends them. */
  webhookUrl?: string;
  /** Signs the events, and is the secret of webhook endpoints made through the API. */
  webhookSecret?: string;
  /** Start with Tabfold's products and prices (`pro-monthly`, …, `pro-lifetime`, `teams-*`), as the setup script makes them. Default true. */
  prices?: boolean;
  /** The clock (ms); default Date.now. */
  now?: () => number;
}

export interface FakeRequest {
  method: string;
  path: string;
  /** The form or query string as sent. */
  raw: string;
  /** The same, parsed into nested objects (values are strings). */
  params: StripeObject;
  stripeVersion: string | null;
}

export interface FakeStripe {
  baseUrl: string;
  webhookUrl: string | undefined;
  webhookSecret: string;
  prices: Map<string, StripeObject>;
  products: Map<string, StripeObject>;
  customers: Map<string, StripeObject>;
  sessions: Map<string, StripeObject>;
  subscriptions: Map<string, StripeObject>;
  portalSessions: Map<string, StripeObject>;
  portalConfigurations: Map<string, StripeObject>;
  /** One-time payments' PaymentIntents, by id. */
  paymentIntents: Map<string, StripeObject>;
  webhookEndpoints: Map<string, StripeObject>;
  /** Every event made, oldest first. */
  events: StripeObject[];
  /** Every API request, oldest first (never the secret key). */
  requests: FakeRequest[];
  /** Webhook deliveries to `webhookUrl`: the answer's status, or null if it failed. */
  deliveries: { eventId: string; type: string; status: number | null }[];
  /** Answers a request as Stripe (and its pages) would. */
  handle(request: Request): Promise<Response>;
  /** `fetch` for createStripe({ fetch }): no network. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Adds Tabfold's products and prices (those that aren't there). */
  seedPrices(): void;
  /** The active price with this lookup key. */
  priceFor(lookupKey: string): StripeObject | null;
  addCustomer(email: string | null): StripeObject;
  /** Adds a subscription without events (for setting up tests). Times in seconds. */
  addSubscription(input: {
    customer: string;
    lookupKey: string;
    status?: string;
    trialEnd?: number | null;
    currentPeriodEnd?: number;
    cancelAtPeriodEnd?: boolean;
    created?: number;
    /** Seats (a Teams plan). Default 1. */
    quantity?: number;
  }): StripeObject;
  /** What "Subscribe" or "Pay" on the checkout page does. `subscription` is null for a one-time payment. */
  completeSession(
    id: string,
    input?: { email?: string },
  ): Promise<{ session: StripeObject; subscription: StripeObject | null; redirect: string }>;
  /** Changes a subscription, then sends `customer.subscription.updated` (or `options.event`; false for none). */
  setSubscription(id: string, patch: StripeObject, options?: { event?: string | false }): Promise<StripeObject | null>;
  /** Makes (and records) an event; sends it to `webhookUrl` if set. */
  emit(type: string, object: StripeObject): Promise<StripeObject>;
  /** An event's body and `Stripe-Signature`, signed now (or at `timestampSeconds`). */
  signed(event: StripeObject, timestampSeconds?: number): Promise<{ body: string; signature: string }>;
  /** POSTs an event to `webhookUrl`; the status, or null. */
  deliver(event: StripeObject): Promise<number | null>;
}

export interface RunningFakeStripe extends FakeStripe {
  /** e.g. http://127.0.0.1:47813 (the same as baseUrl). */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Tabfold's prices, as server/scripts/stripe-setup.mjs makes them (`interval` null: one payment). */
export const TABFOLD_PRICES = [
  { lookupKey: 'pro-monthly', product: 'Tabfold Pro', tier: 'pro', amount: 500, interval: 'month' },
  { lookupKey: 'pro-yearly', product: 'Tabfold Pro', tier: 'pro', amount: 4800, interval: 'year' },
  { lookupKey: 'pro-ai-monthly', product: 'Tabfold Pro AI', tier: 'pro-ai', amount: 900, interval: 'month' },
  { lookupKey: 'pro-ai-yearly', product: 'Tabfold Pro AI', tier: 'pro-ai', amount: 8400, interval: 'year' },
  { lookupKey: 'pro-lifetime', product: 'Tabfold Pro for life', tier: 'pro-lifetime', amount: 9900, interval: null },
  { lookupKey: 'teams-monthly', product: 'Tabfold Teams', tier: 'teams', amount: 1000, interval: 'month' },
  { lookupKey: 'teams-yearly', product: 'Tabfold Teams', tier: 'teams', amount: 9600, interval: 'year' },
] as const;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Stripe's form encoding back into nested objects: `a[b][0][c]=x`, `a[]=x`. Values stay strings. */
export function parseForm(text: string): StripeObject {
  const out: StripeObject = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
    if (!match) {
      out[key] = value;
      continue;
    }
    const parts = [match[1]!, ...[...match[2]!.matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1]!)];
    let node: StripeObject = out;
    parts.forEach((part, i) => {
      const next = parts[i + 1];
      const slot = Array.isArray(node) && part === '' ? node.length : part;
      if (next === undefined) node[slot] = value;
      else node = node[slot] ??= next === '' || /^\d+$/.test(next) ? [] : {};
    });
  }
  return out;
}

function deepMerge(target: StripeObject, patch: StripeObject): StripeObject {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

const truthy = (value: unknown) => value === true || value === 'true';

/** Adds one billing period (UTC calendar months or years) to a time in seconds. */
function addInterval(seconds: number, interval: string): number {
  const date = new Date(seconds * 1000);
  if (interval === 'year') date.setUTCFullYear(date.getUTCFullYear() + 1);
  else if (interval === 'week') date.setUTCDate(date.getUTCDate() + 7);
  else if (interval === 'day') date.setUTCDate(date.getUTCDate() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  return Math.floor(date.getTime() / 1000);
}

const money = (price: StripeObject, quantity = 1) =>
  `${price.currency === 'usd' ? '$' : `${String(price.currency).toUpperCase()} `}${((price.unit_amount * quantity) / 100).toFixed(2)}`;
const period = (price: StripeObject) => (price.recurring ? `per ${price.recurring.interval}` : 'once');
const dateOf = (seconds: number) => new Date(seconds * 1000).toUTCString().slice(5, 16);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stripeError(status: number, message: string, extra: StripeObject = {}): Response {
  return json(status, { error: { type: 'invalid_request_error', message, ...extra } });
}

const missing = (kind: string, id: string) => stripeError(404, `No such ${kind}: '${id}'`, { code: 'resource_missing' });

function htmlPage(title: string, body: string, status = 200): Response {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #f6f8fa; color: #1f2328; }
main { max-width: 420px; margin: 48px auto; padding: 24px; background: #fff; border: 1px solid #d0d7de; border-radius: 12px; }
.mode { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #fff8c5; color: #7d4e00; }
h1 { font-size: 20px; margin: 12px 0 4px; } .price { font-size: 28px; font-weight: 700; margin: 0 0 4px; }
label { display: block; margin: 16px 0; } input { display: block; width: 100%; box-sizing: border-box; height: 40px; padding: 0 10px; margin-top: 4px; font: inherit; border: 1px solid #d0d7de; border-radius: 8px; }
input[readonly] { background: #f6f8fa; color: #59636e; }
button { width: 100%; height: 44px; border: 0; border-radius: 8px; background: #635bff; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
a { color: #635bff; } p.note { color: #59636e; font-size: 13px; }
</style></head>
<body><main><span class="mode">Test mode · Fake Stripe</span>${body}</main></body></html>`;
  return new Response(page, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export function createFakeStripe(options: FakeStripeOptions = {}): FakeStripe {
  const now = options.now ?? (() => Date.now());
  const nowS = () => Math.floor(now() / 1000);
  let counter = 0;
  const newId = (prefix: string) => `${prefix}_fake${(++counter).toString().padStart(6, '0')}`;

  const fake: FakeStripe = {
    baseUrl: (options.baseUrl ?? 'http://fake-stripe.test').replace(/\/+$/, ''),
    webhookUrl: options.webhookUrl,
    webhookSecret: options.webhookSecret ?? 'whsec_fake_test_secret',
    prices: new Map(),
    products: new Map(),
    customers: new Map(),
    sessions: new Map(),
    subscriptions: new Map(),
    portalSessions: new Map(),
    portalConfigurations: new Map(),
    paymentIntents: new Map(),
    webhookEndpoints: new Map(),
    events: [],
    requests: [],
    deliveries: [],
    handle,
    fetch: (input, init) => handle(input instanceof Request && !init ? input : new Request(input, init)),
    seedPrices,
    priceFor,
    addCustomer,
    addSubscription,
    completeSession,
    setSubscription,
    emit,
    signed,
    deliver,
  };

  // ---- Objects ----

  function createProduct(params: StripeObject): StripeObject {
    const product = {
      id: newId('prod'),
      object: 'product',
      active: params.active === undefined ? true : truthy(params.active),
      name: params.name,
      metadata: { ...(params.metadata ?? {}) },
      created: nowS(),
    };
    fake.products.set(product.id, product);
    return product;
  }

  function createPrice(params: StripeObject): StripeObject {
    if (params.lookup_key) {
      for (const other of fake.prices.values()) if (other.lookup_key === params.lookup_key) other.lookup_key = null;
    }
    const price = {
      id: newId('price'),
      object: 'price',
      active: true,
      currency: params.currency,
      unit_amount: Number(params.unit_amount),
      lookup_key: params.lookup_key ?? null,
      nickname: params.nickname ?? null,
      product: params.product,
      recurring: params.recurring
        ? { interval: params.recurring.interval, interval_count: Number(params.recurring.interval_count ?? 1) }
        : null,
      type: params.recurring ? 'recurring' : 'one_time',
      tax_behavior: params.tax_behavior ?? 'unspecified',
      metadata: { ...(params.metadata ?? {}) },
      created: nowS(),
    };
    fake.prices.set(price.id, price);
    return price;
  }

  function priceFor(lookupKey: string): StripeObject | null {
    for (const price of fake.prices.values()) if (price.active && price.lookup_key === lookupKey) return price;
    return null;
  }

  function seedPrices(): void {
    const products = new Map<string, StripeObject>();
    for (const spec of TABFOLD_PRICES) {
      if (priceFor(spec.lookupKey)) continue;
      let product = products.get(spec.product);
      if (!product) {
        product = createProduct({ name: spec.product, metadata: { tabfold_tier: spec.tier } });
        products.set(spec.product, product);
      }
      createPrice({
        currency: 'usd',
        unit_amount: spec.amount,
        product: product.id,
        recurring: spec.interval ? { interval: spec.interval } : undefined,
        lookup_key: spec.lookupKey,
      });
    }
  }

  function addCustomer(email: string | null): StripeObject {
    const customer = { id: newId('cus'), object: 'customer', email, created: nowS(), metadata: {} };
    fake.customers.set(customer.id, customer);
    return customer;
  }

  function addSubscription(input: Parameters<FakeStripe['addSubscription']>[0] & { priceId?: string }): StripeObject {
    const price = input.priceId ? fake.prices.get(input.priceId) : priceFor(input.lookupKey);
    if (!price) throw new Error(`The fake Stripe has no price ${input.priceId ?? input.lookupKey}`);
    if (!price.recurring) throw new Error(`The fake Stripe's price ${price.id} is a one-time price`);
    const created = input.created ?? nowS();
    const trialEnd = input.trialEnd ?? null;
    const periodEnd = input.currentPeriodEnd ?? trialEnd ?? addInterval(created, price.recurring?.interval ?? 'month');
    const subscriptionId = newId('sub');
    const subscription = {
      id: subscriptionId,
      object: 'subscription',
      customer: input.customer,
      status: input.status ?? (trialEnd ? 'trialing' : 'active'),
      cancel_at: input.cancelAtPeriodEnd ? periodEnd : null,
      cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
      canceled_at: null,
      ended_at: null,
      created,
      current_period_start: created,
      current_period_end: periodEnd,
      trial_start: trialEnd ? created : null,
      trial_end: trialEnd,
      metadata: {},
      items: {
        object: 'list',
        data: [
          {
            id: newId('si'),
            object: 'subscription_item',
            subscription: subscriptionId,
            price: clone(price),
            quantity: input.quantity ?? 1,
            current_period_start: created,
            current_period_end: periodEnd,
          },
        ],
      },
    };
    fake.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  /** A session past its expiry is expired, as Stripe would have it. */
  function sessionNow(id: string): StripeObject | null {
    const session = fake.sessions.get(id);
    if (session && session.status === 'open' && nowS() >= session.expires_at) session.status = 'expired';
    return session ?? null;
  }

  // ---- Events ----

  async function signed(event: StripeObject, timestampSeconds = nowS()) {
    const body = JSON.stringify(event);
    return { body, signature: await signWebhook(fake.webhookSecret, body, timestampSeconds) };
  }

  async function deliver(event: StripeObject): Promise<number | null> {
    if (!fake.webhookUrl) return null;
    const { body, signature } = await signed(event);
    let status: number | null = null;
    try {
      const response = await fetch(fake.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': signature },
        body,
      });
      await response.text();
      status = response.status;
    } catch {
      status = null;
    }
    fake.deliveries.push({ eventId: event.id, type: event.type, status });
    return status;
  }

  async function emit(type: string, object: StripeObject): Promise<StripeObject> {
    const event = {
      id: newId('evt'),
      object: 'event',
      api_version: STRIPE_VERSION,
      created: nowS(),
      livemode: false,
      type,
      data: { object: clone(object) },
    };
    fake.events.push(event);
    await deliver(event);
    return event;
  }

  async function completeSession(id: string, input: { email?: string } = {}) {
    const session = sessionNow(id);
    if (!session) throw new Error(`No such checkout session: ${id}`);
    if (session.status !== 'open') throw new Error(`This checkout is ${session.status}`);
    const price = fake.prices.get(session.line_items[0].price)!;
    let customerId: string | null = session.customer;
    const email = customerId ? fake.customers.get(customerId)?.email : (session.customer_email ?? input.email?.trim());
    if (!email || !email.includes('@')) throw new Error('Enter an email address');
    if (session.mode === 'payment') {
      // A one-time payment: a customer only when asked for (customer_creation=always), and no subscription.
      if (!customerId && session.customer_creation === 'always') customerId = addCustomer(email).id;
      const intent = {
        id: newId('pi'),
        object: 'payment_intent',
        amount: price.unit_amount * session.line_items[0].quantity,
        currency: price.currency,
        customer: customerId,
        status: 'succeeded',
        created: nowS(),
      };
      fake.paymentIntents.set(intent.id, intent);
      Object.assign(session, {
        status: 'complete',
        customer: customerId,
        customer_details: { email },
        payment_intent: intent.id,
        payment_status: 'paid',
      });
      await emit('checkout.session.completed', session);
      return { session, subscription: null, redirect: String(session.success_url).replace('{CHECKOUT_SESSION_ID}', id) };
    }
    if (!customerId) customerId = addCustomer(email).id;
    const trialEnd = session.subscription_data?.trial_end ? Number(session.subscription_data.trial_end) : null;
    const subscription = addSubscription({
      customer: customerId!,
      lookupKey: '',
      priceId: price.id,
      trialEnd,
      quantity: session.line_items[0].quantity,
    });
    Object.assign(session, {
      status: 'complete',
      customer: customerId,
      customer_details: { email },
      subscription: subscription.id,
      payment_status: trialEnd ? 'no_payment_required' : 'paid',
    });
    // Stripe doesn't promise an order; this is the usual one.
    await emit('customer.subscription.created', subscription);
    await emit('checkout.session.completed', session);
    return { session, subscription, redirect: String(session.success_url).replace('{CHECKOUT_SESSION_ID}', id) };
  }

  async function setSubscription(id: string, patch: StripeObject, opts: { event?: string | false } = {}) {
    const subscription = fake.subscriptions.get(id);
    if (!subscription) return null;
    deepMerge(subscription, clone(patch));
    const event = opts.event === undefined ? 'customer.subscription.updated' : opts.event;
    if (event) await emit(event, subscription);
    return subscription;
  }

  // ---- The REST API ----

  const list = (path: string, data: StripeObject[], params: StripeObject) => {
    const limit = Math.max(1, Math.min(100, Number(params.limit ?? 10)));
    let start = 0;
    if (params.starting_after) start = data.findIndex((item) => item.id === params.starting_after) + 1;
    const page = data.slice(start, start + limit);
    return json(200, { object: 'list', url: path, has_more: start + limit < data.length, data: page });
  };

  async function api(request: Request, url: URL): Promise<Response> {
    const auth = request.headers.get('authorization') ?? '';
    if (!/^Bearer (sk|rk)_(test|live)_\S+$/.test(auth)) {
      return json(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided.' } });
    }
    const method = request.method;
    const path = url.pathname;
    const raw = method === 'GET' ? url.search.replace(/^\?/, '') : await request.text();
    const params = parseForm(raw);
    fake.requests.push({ method, path, raw, params, stripeVersion: request.headers.get('stripe-version') });
    /** Whether this is `verb` on a path matching `pattern`. */
    const is = (verb: string, pattern: RegExp) => method === verb && pattern.test(path);
    /** The id in the path, for `verb` on a path matching `pattern` (with one capture group). */
    const idIn = (verb: string, pattern: RegExp) => (method === verb ? (pattern.exec(path)?.[1] ?? null) : null);
    let id: string | null;

    if (is('GET', /^\/v1\/prices$/)) {
      let prices = [...fake.prices.values()];
      if (params.active !== undefined) prices = prices.filter((p) => p.active === truthy(params.active));
      if (Array.isArray(params.lookup_keys)) prices = prices.filter((p) => params.lookup_keys.includes(p.lookup_key));
      if (params.product) prices = prices.filter((p) => p.product === params.product);
      return list(path, prices, params);
    }
    if (is('POST', /^\/v1\/prices$/)) {
      if (!params.currency || params.unit_amount === undefined) return stripeError(400, 'Missing currency or unit_amount.');
      if (!params.product || !fake.products.has(params.product)) return missing('product', String(params.product));
      if (params.lookup_key && !truthy(params.transfer_lookup_key)) {
        const other = [...fake.prices.values()].find((p) => p.lookup_key === params.lookup_key);
        if (other) return stripeError(400, `A price (\`${other.id}\`) already uses that lookup key.`);
      }
      return json(200, createPrice(params));
    }
    if (is('GET', /^\/v1\/products$/)) {
      let products = [...fake.products.values()];
      if (params.active !== undefined) products = products.filter((p) => p.active === truthy(params.active));
      return list(path, products, params);
    }
    if (is('POST', /^\/v1\/products$/)) {
      if (!params.name) return stripeError(400, 'Missing required param: name.', { param: 'name' });
      return json(200, createProduct(params));
    }
    if ((id = idIn('GET', /^\/v1\/products\/([^/]+)$/))) {
      return fake.products.has(id) ? json(200, fake.products.get(id)) : missing('product', id);
    }
    if ((id = idIn('GET', /^\/v1\/customers\/([^/]+)$/))) {
      return fake.customers.has(id) ? json(200, fake.customers.get(id)) : missing('customer', id);
    }
    if (is('POST', /^\/v1\/checkout\/sessions$/)) return createSession(params);
    if ((id = idIn('GET', /^\/v1\/checkout\/sessions\/([^/]+)$/))) {
      const session = sessionNow(id);
      return session ? json(200, session) : missing('checkout.session', id);
    }
    if ((id = idIn('GET', /^\/v1\/subscriptions\/([^/]+)$/))) {
      return fake.subscriptions.has(id) ? json(200, fake.subscriptions.get(id)) : missing('subscription', id);
    }
    if ((id = idIn('POST', /^\/v1\/subscription_items\/([^/]+)$/))) return updateItem(id, params);
    if (path.startsWith('/v1/billing_portal/')) return portalApi(method, path, params);
    if (is('GET', /^\/v1\/webhook_endpoints$/)) {
      return list(path, [...fake.webhookEndpoints.values()].map(withoutSecret), params);
    }
    if (is('POST', /^\/v1\/webhook_endpoints$/)) {
      if (!params.url || !Array.isArray(params.enabled_events)) return stripeError(400, 'Missing url or enabled_events.');
      const endpoint = {
        id: newId('we'),
        object: 'webhook_endpoint',
        url: params.url,
        enabled_events: params.enabled_events,
        api_version: params.api_version ?? null,
        description: params.description ?? null,
        metadata: { ...(params.metadata ?? {}) },
        status: 'enabled',
        created: nowS(),
        secret: fake.webhookSecret,
      };
      fake.webhookEndpoints.set(endpoint.id, endpoint);
      return json(200, endpoint);
    }
    if ((id = idIn('POST', /^\/v1\/webhook_endpoints\/([^/]+)$/))) {
      const endpoint = fake.webhookEndpoints.get(id);
      if (!endpoint) return missing('webhook_endpoint', id);
      deepMerge(endpoint, params);
      return json(200, withoutSecret(endpoint));
    }
    return stripeError(404, `Unrecognized request URL (${method}: ${path}).`);
  }

  const withoutSecret = (endpoint: StripeObject) => {
    const { secret: _secret, ...rest } = endpoint;
    return rest;
  };

  /** A subscription item's quantity (a Teams plan's seats): Stripe sends `customer.subscription.updated`. */
  async function updateItem(id: string, params: StripeObject): Promise<Response> {
    for (const subscription of fake.subscriptions.values()) {
      const item = subscription.items.data.find((entry: StripeObject) => entry.id === id);
      if (!item) continue;
      if (params.quantity !== undefined) {
        const quantity = Number(params.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) return stripeError(400, 'Invalid quantity.', { param: 'quantity' });
        item.quantity = quantity;
      }
      item.proration_behavior_last = params.proration_behavior ?? null;
      await emit('customer.subscription.updated', subscription);
      return json(200, item);
    }
    return missing('subscription_item', id);
  }

  function createSession(params: StripeObject): Response {
    if (params.mode !== 'subscription' && params.mode !== 'payment') {
      return stripeError(400, 'The fake Stripe does mode=subscription and mode=payment.', { param: 'mode' });
    }
    const item = Array.isArray(params.line_items) ? params.line_items[0] : null;
    const price = item?.price ? fake.prices.get(item.price) : undefined;
    if (!price || !price.active) return missing('price', String(item?.price));
    if (params.mode === 'subscription' && !price.recurring) {
      return stripeError(400, 'You must provide at least one recurring price in `subscription` mode.');
    }
    if (params.mode === 'payment' && price.recurring) {
      return stripeError(400, 'You specified `payment` mode but passed a recurring price.');
    }
    if (params.customer_creation && (params.mode !== 'payment' || params.customer)) {
      return stripeError(400, '`customer_creation` can only be used in `payment` mode without `customer`.', { param: 'customer_creation' });
    }
    if (params.mode === 'payment' && params.subscription_data) {
      return stripeError(400, '`subscription_data` can only be used in `subscription` mode.', { param: 'subscription_data' });
    }
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1) return stripeError(400, 'Invalid quantity.', { param: 'line_items[0][quantity]' });
    if (!params.success_url) return stripeError(400, 'Missing required param: success_url.', { param: 'success_url' });
    if (params.customer && params.customer_email) {
      return stripeError(400, 'You may only specify one of these parameters: customer, customer_email.');
    }
    if (params.customer && !fake.customers.has(params.customer)) return missing('customer', params.customer);
    if (params.customer_update && !params.customer) {
      return stripeError(400, '`customer_update` can only be used with `customer`.', { param: 'customer_update' });
    }
    const trialEnd = params.subscription_data?.trial_end ? Number(params.subscription_data.trial_end) : null;
    if (trialEnd !== null && trialEnd < nowS() + 48 * 3600) {
      return stripeError(400, 'subscription_data.trial_end must be at least 48 hours in the future.', {
        param: 'subscription_data[trial_end]',
      });
    }
    const id = newId('cs_test');
    const session = {
      id,
      object: 'checkout.session',
      mode: params.mode,
      status: 'open',
      payment_status: 'unpaid',
      url: `${fake.baseUrl}/pay/${id}`,
      success_url: params.success_url,
      cancel_url: params.cancel_url ?? null,
      customer: params.customer ?? null,
      customer_email: params.customer_email ?? null,
      customer_details: null,
      customer_creation: params.customer_creation ?? null,
      subscription: null,
      payment_intent: null,
      client_reference_id: params.client_reference_id ?? null,
      metadata: { ...(params.metadata ?? {}) },
      allow_promotion_codes: truthy(params.allow_promotion_codes),
      automatic_tax: { enabled: truthy(params.automatic_tax?.enabled) },
      customer_update: params.customer_update ?? null,
      // Not in Stripe's answer, but handy for tests and the page.
      line_items: [{ price: price.id, quantity }],
      subscription_data: { trial_end: trialEnd },
      created: nowS(),
      expires_at: nowS() + 24 * 3600,
    };
    fake.sessions.set(id, session);
    return json(200, session);
  }

  function portalApi(method: string, path: string, params: StripeObject): Response {
    const [, , , kind, id] = path.split('/');
    if (method === 'POST' && kind === 'sessions' && !id) {
      if (!params.customer || !fake.customers.has(params.customer)) return missing('customer', String(params.customer));
      if (params.configuration && !fake.portalConfigurations.has(params.configuration)) {
        return missing('billing_portal.configuration', params.configuration);
      }
      const flowType = params.flow_data?.type;
      if (flowType && flowType !== 'payment_method_update' && flowType !== 'subscription_cancel' && flowType !== 'subscription_update') {
        return stripeError(400, `Invalid flow_data[type]: ${flowType}`);
      }
      const sessionId = newId('bps');
      const portal = {
        id: sessionId,
        object: 'billing_portal.session',
        customer: params.customer,
        return_url: params.return_url ?? null,
        configuration: params.configuration ?? null,
        flow: params.flow_data ?? null,
        url: `${fake.baseUrl}/portal/${sessionId}`,
        created: nowS(),
      };
      fake.portalSessions.set(sessionId, portal);
      return json(200, portal);
    }
    if (kind === 'configurations') {
      if (method === 'GET' && !id) {
        let configs = [...fake.portalConfigurations.values()];
        if (params.active !== undefined) configs = configs.filter((c) => c.active === truthy(params.active));
        return list(path, configs, params);
      }
      if (method === 'POST' && !id) {
        if (!params.features) return stripeError(400, 'Missing required param: features.', { param: 'features' });
        const config = {
          id: newId('bpc'),
          object: 'billing_portal.configuration',
          active: true,
          is_default: false,
          business_profile: params.business_profile ?? {},
          features: params.features,
          metadata: { ...(params.metadata ?? {}) },
          created: nowS(),
        };
        fake.portalConfigurations.set(config.id, config);
        return json(200, config);
      }
      if (method === 'POST' && id) {
        const config = fake.portalConfigurations.get(id);
        if (!config) return missing('billing_portal.configuration', id);
        // Stripe replaces lists (like the products) rather than merging them.
        deepMerge(config, params);
        return json(200, config);
      }
    }
    return stripeError(404, `Unrecognized request URL (${method}: ${path}).`);
  }

  // ---- Pages ----

  function payPage(session: StripeObject, error = ''): Response {
    const price = fake.prices.get(session.line_items[0].price)!;
    const quantity = Number(session.line_items[0].quantity ?? 1);
    const product = fake.products.get(price.product);
    const known = session.customer ? fake.customers.get(session.customer)?.email : session.customer_email;
    const trialEnd = session.subscription_data?.trial_end;
    const oneTime = session.mode === 'payment';
    if (session.status !== 'open') {
      return htmlPage('Checkout', `<h1>This checkout is ${escapeHtml(session.status)}</h1>`, 400);
    }
    const each = quantity > 1 ? `<p>${quantity} × ${escapeHtml(money(price))} ${escapeHtml(period(price))}</p>` : '';
    const body = `
<h1>${oneTime ? 'Pay for' : 'Subscribe to'} ${escapeHtml(product?.name ?? 'Tabfold')}</h1>
<p class="price">${escapeHtml(money(price, quantity))} <small>${escapeHtml(period(price))}</small></p>
${each}
${trialEnd ? `<p>Free until ${escapeHtml(dateOf(trialEnd))}. Billing starts then.</p>` : ''}
<form method="post" action="/pay/${escapeHtml(session.id)}">
<label>Email<input type="email" name="email" autocomplete="email" required value="${escapeHtml(known ?? '')}"${known ? ' readonly' : ''}></label>
<label>Card<input name="card" value="4242 4242 4242 4242" readonly></label>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
<button type="submit">${oneTime ? 'Pay' : 'Subscribe'}</button>
</form>
${session.cancel_url ? `<p><a href="${escapeHtml(session.cancel_url)}">Cancel and go back</a></p>` : ''}
<p class="note">Promotion codes ${session.allow_promotion_codes ? 'allowed' : 'off'} · Tax ${session.automatic_tax?.enabled ? 'on' : 'off'}</p>`;
    return htmlPage('Checkout · Fake Stripe', body);
  }

  function portalPage(portal: StripeObject): Response {
    const subs = [...fake.subscriptions.values()].filter(
      (s) => s.customer === portal.customer && ['active', 'trialing', 'past_due'].includes(s.status),
    );
    const back = portal.return_url ? `<p><a href="${escapeHtml(portal.return_url)}">Return to Tabfold</a></p>` : '';
    if (portal.flow?.type === 'payment_method_update') {
      return htmlPage(
        'Update card · Fake Stripe',
        `<h1>Update card</h1>
<form method="post" action="/portal/${escapeHtml(portal.id)}/card"><label>Card<input name="card" value="4242 4242 4242 4242"></label><button type="submit">Save card</button></form>${back}`,
      );
    }
    const rows = subs
      .map((s) => {
        const price = s.items.data[0].price;
        const quantity = Number(s.items.data[0].quantity ?? 1);
        const product = fake.products.get(price.product);
        const ends = s.cancel_at_period_end || s.cancel_at;
        const seats = quantity > 1 ? ` · ${quantity} people` : '';
        return `<p><b>${escapeHtml(product?.name ?? price.lookup_key)}</b>${seats} · ${escapeHtml(money(price, quantity))} ${escapeHtml(period(price))}<br>${
          ends ? `Ends on ${escapeHtml(dateOf(s.cancel_at ?? s.current_period_end))}` : `Renews on ${escapeHtml(dateOf(s.trial_end ?? s.current_period_end))}`
        }</p>`;
      })
      .join('');
    const canCancel = subs.some((s) => !s.cancel_at_period_end && !s.cancel_at);
    return htmlPage(
      'Billing · Fake Stripe',
      `<h1>Your plan</h1>${rows || '<p>No plan.</p>'}
${canCancel ? `<form method="post" action="/portal/${escapeHtml(portal.id)}/cancel"><button type="submit">Cancel plan</button></form>` : ''}${back}`,
    );
  }

  async function pages(request: Request, url: URL): Promise<Response> {
    const [, kind, id, action] = url.pathname.split('/');
    if (kind === 'pay' && id) {
      const session = sessionNow(id);
      if (!session) return htmlPage('Checkout', '<h1>No such checkout</h1>', 404);
      if (request.method === 'GET') return payPage(session);
      if (request.method === 'POST') {
        const form = new URLSearchParams(await request.text());
        try {
          const { redirect: to } = await completeSession(id, { email: form.get('email') ?? undefined });
          return redirect(to);
        } catch (error) {
          return payPage(session, error instanceof Error ? error.message : 'That didn’t work');
        }
      }
    }
    if (kind === 'portal' && id) {
      const portal = fake.portalSessions.get(id);
      if (!portal) return htmlPage('Billing', '<h1>No such billing session</h1>', 404);
      if (request.method === 'GET' && !action) return portalPage(portal);
      if (request.method === 'POST' && action === 'cancel') {
        for (const sub of fake.subscriptions.values()) {
          if (sub.customer !== portal.customer || !['active', 'trialing', 'past_due'].includes(sub.status)) continue;
          if (sub.cancel_at_period_end) continue;
          const end = sub.status === 'trialing' && sub.trial_end ? sub.trial_end : sub.current_period_end;
          await setSubscription(sub.id, { cancel_at_period_end: true, cancel_at: end, canceled_at: nowS() });
        }
        return redirect(`/portal/${id}`);
      }
      if (request.method === 'POST' && action === 'card') {
        return redirect(portal.flow?.after_completion?.redirect?.return_url ?? portal.return_url ?? `/portal/${id}`);
      }
    }
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/v1/')) return await api(request, url);
      return await pages(request, url);
    } catch (error) {
      return json(500, { error: { type: 'api_error', message: `The fake Stripe failed: ${String(error)}` } });
    }
  }

  if (options.prices !== false) seedPrices();
  return fake;
}

// ---- Over HTTP ----

interface NodeRequest extends AsyncIterable<Uint8Array> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface NodeResponse {
  writeHead(status: number, headers?: Record<string, string>): NodeResponse;
  end(body?: string | Uint8Array): void;
}

interface NodeServer {
  listen(port: number, host: string, listener: () => void): void;
  address(): { port: number } | string | null;
  close(callback?: (error?: Error) => void): void;
  closeAllConnections?(): void;
  once(event: 'error', listener: (error: Error) => void): void;
}

interface NodeHttp {
  createServer(listener: (req: NodeRequest, res: NodeResponse) => void): NodeServer;
}

/** node:http, without needing Node's type definitions. */
function nodeHttp(): NodeHttp {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const http = proc?.getBuiltinModule?.('node:http');
  if (!http) throw new Error('startFakeStripe needs Node 20.16 or later');
  return http as NodeHttp;
}

export interface WebServer {
  /** e.g. http://127.0.0.1:47812 */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** The fake Stripe on a port (0: any free port) of `host` (default 127.0.0.1). */
export async function startFakeStripe(
  options: FakeStripeOptions & { port?: number; host?: string } = {},
): Promise<RunningFakeStripe> {
  const fake = createFakeStripe(options);
  const web = await serveWeb((request) => fake.handle(request), { port: options.port, host: options.host });
  fake.baseUrl = web.url;
  return Object.assign(fake, web);
}

/**
 * Serves a web-standard handler (Request in, Response out) over HTTP on a port (0: any free port)
 * of `host` (default 127.0.0.1). The fake Stripe uses it; the end-to-end test can serve the
 * Tabfold server's `handle` the same way.
 */
export async function serveWeb(
  handler: (request: Request) => Promise<Response>,
  options: { port?: number; host?: string } = {},
): Promise<WebServer> {
  const host = options.host ?? '127.0.0.1';
  let base = `http://${host}`;
  const server = nodeHttp().createServer(async (req, res) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      }
      const method = req.method ?? 'GET';
      const request = new Request(`${base}${req.url ?? '/'}`, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
      });
      const response = await handler(request);
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        out[name] = value;
      });
      res.writeHead(response.status, out);
      res.end(new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`The server failed: ${String(error)}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  base = `http://${host}:${port}`;
  return {
    url: base,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
