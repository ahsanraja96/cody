import type { BillingInterval, Subscription } from '../_shared/plan.ts';

/**
 * A small Stripe client over fetch (no SDK), with only what Tabfold uses: prices by lookup key,
 * Checkout Sessions (subscriptions, and one-time payments for Pro for life), subscriptions, their
 * seats and cancelling them (1.0: deleting an account), billing portal sessions and webhook
 * signatures. Web-standard APIs only, so it runs
 * in the Edge Function, in tests and in plain Node.
 */

/**
 * The API version every request asks for. 2025-03-31.basil is the oldest Stripe allows on an
 * account with Managed Payments (Stripe as the merchant of record), as the Truewidgets account is.
 * It keeps a subscription's period end on its items, which readSubscription reads.
 */
export const STRIPE_VERSION = '2025-03-31.basil';

const PRICE_CACHE_MS = 10 * 60 * 1000;
/** Webhook signatures older (or newer) than this are refused. */
export const WEBHOOK_TOLERANCE_S = 300;

/** Stripe couldn't be reached or refused. The message is safe to log: no secret, no request body. */
export class PaymentsError extends Error {
  override name = 'PaymentsError';
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** A webhook request whose `Stripe-Signature` doesn't check out. */
export class WebhookSignatureError extends Error {
  override name = 'WebhookSignatureError';
}

export interface CheckoutInput {
  lookupKey: string;
  /** A subscription (default), or one payment (Pro for life). */
  mode?: 'subscription' | 'payment';
  /** How many: a Teams plan's seats. Default 1. */
  quantity?: number;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId?: string;
  /** An existing Stripe customer… */
  customer?: string;
  /** …or the email Stripe should use (it can't be changed on the page). */
  customerEmail?: string;
  /** Billing starts then (seconds); Stripe wants it at least 48 hours away. */
  trialEnd?: number;
  automaticTax: boolean;
  metadata: Record<string, string>;
}

export interface CheckoutInfo {
  id: string;
  status: 'open' | 'complete' | 'expired';
  mode: 'subscription' | 'payment';
  /** Stripe's `payment_status`: `paid`, `unpaid` (a bank debit still on its way) or `no_payment_required`. */
  paymentStatus: string | null;
  customerId: string | null;
  /** What the person typed on Stripe's page, or the email the server gave. */
  email: string | null;
  subscriptionId: string | null;
  /** A one-time payment's PaymentIntent (`pi_…`). */
  paymentIntentId: string | null;
  clientReferenceId: string | null;
  metadata: Record<string, string>;
}

export interface PortalInput {
  customer: string;
  returnUrl: string;
  /** Open straight on the card form. */
  flow?: 'payment-method';
  /** A billing portal configuration id (`bpc_…`). */
  configuration?: string;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/** Payments as the server uses them (Stripe in production, a fake Stripe in tests). */
export interface Payments {
  createCheckout(input: CheckoutInput): Promise<{ id: string; url: string }>;
  getCheckout(id: string): Promise<CheckoutInfo>;
  getSubscription(id: string): Promise<Subscription>;
  /** Sets a subscription item's quantity (a Teams plan's seats), prorated. */
  updateQuantity(itemId: string, quantity: number): Promise<void>;
  /** Cancels a subscription at once (`DELETE /v1/subscriptions/<id>`): no further charges. Its state afterwards. */
  cancelSubscription(id: string): Promise<Subscription>;
  createPortal(input: PortalInput): Promise<{ url: string }>;
  /** The event, if the signature is right and recent; throws WebhookSignatureError otherwise. */
  verifyWebhook(rawBody: string, signatureHeader: string | null): Promise<StripeEvent>;
}

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  apiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

type Params = Record<string, unknown>;

/**
 * Stripe's form encoding: nested objects as `a[b]=…`, lists of objects as `a[0][b]=…`, lists of
 * plain values as `a[]=…`. Null and undefined are left out.
 */
export function formEncode(params: Params): string {
  const pairs: [string, string][] = [];
  const add = (key: string, value: unknown) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const scalar = item === null || typeof item !== 'object';
        add(scalar ? `${key}[]` : `${key}[${index}]`, item);
      });
    } else if (typeof value === 'object') {
      for (const [name, inner] of Object.entries(value as Params)) add(`${key}[${name}]`, inner);
    } else {
      pairs.push([key, String(value)]);
    }
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return new URLSearchParams(pairs).toString();
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** A Stripe id, whether the field holds the id or the expanded object. */
const idOf = (value: unknown): string | null => text(value) ?? (isObject(value) ? text(value.id) : null);

/** Stripe's seconds as ms. */
const ms = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null;

function stringMap(value: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (isObject(value)) for (const [key, inner] of Object.entries(value)) if (typeof inner === 'string') map[key] = inner;
  return map;
}

/** A Stripe subscription object as a Subscription (the period end may sit on its first item). */
export function readSubscription(object: unknown): Subscription {
  if (!isObject(object) || !text(object.id)) throw new PaymentsError('Stripe sent a subscription without an id');
  const items = isObject(object.items) && Array.isArray(object.items.data) ? object.items.data : [];
  const item: Record<string, unknown> = isObject(items[0]) ? items[0] : {};
  const price = isObject(item.price) ? item.price : isObject(object.plan) ? object.plan : {};
  const recurring = isObject(price.recurring) ? price.recurring : {};
  const interval = recurring.interval ?? price.interval;
  return {
    id: text(object.id)!,
    customerId: idOf(object.customer) ?? '',
    status: text(object.status) ?? 'incomplete',
    lookupKey: text(price.lookup_key),
    interval: interval === 'month' || interval === 'year' ? (interval as BillingInterval) : null,
    currentPeriodEnd: ms(object.current_period_end) ?? ms(item.current_period_end),
    cancelAt: ms(object.cancel_at),
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
    trialEnd: ms(object.trial_end),
    createdAt: ms(object.created) ?? 0,
    quantity: typeof item.quantity === 'number' && Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1,
    itemId: text(item.id),
    endedAt: ms(object.ended_at),
  };
}

export function readCheckout(object: unknown): CheckoutInfo {
  if (!isObject(object) || !text(object.id)) throw new PaymentsError('Stripe sent a checkout session without an id');
  const details = isObject(object.customer_details) ? object.customer_details : {};
  const status = object.status === 'complete' || object.status === 'expired' ? object.status : 'open';
  return {
    id: text(object.id)!,
    status,
    mode: object.mode === 'payment' ? 'payment' : 'subscription',
    paymentStatus: text(object.payment_status),
    customerId: idOf(object.customer),
    email: text(details.email) ?? text(object.customer_email),
    subscriptionId: idOf(object.subscription),
    paymentIntentId: idOf(object.payment_intent),
    clientReferenceId: text(object.client_reference_id),
    metadata: stringMap(object.metadata),
  };
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** Compares two strings in time that depends only on their length. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** The `Stripe-Signature` header for a payload, as Stripe makes it (for tests and the fake Stripe). */
export async function signWebhook(secret: string, rawBody: string, timestampSeconds: number): Promise<string> {
  return `t=${timestampSeconds},v1=${await hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`)}`;
}

export function createStripe(options: StripeOptions): Payments {
  const apiBase = (options.apiBase || 'https://api.stripe.com').replace(/\/+$/, '');
  const fetchFn: typeof fetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const prices = new Map<string, { id: string; at: number }>();

  async function call(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}): Promise<Record<string, unknown>> {
    // A missing secret is a set-up problem, not Stripe's: a plain Error, so the route answers 500.
    if (!options.secretKey) throw new Error('STRIPE_SECRET_KEY is not set');
    const encoded = formEncode(params);
    const url = `${apiBase}${path}${method !== 'POST' && encoded ? `?${encoded}` : ''}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.secretKey}`,
      'Stripe-Version': STRIPE_VERSION,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers,
        body: method === 'POST' ? encoded : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // Never pass on fetch's own error: it can quote the request.
      throw new PaymentsError(`Stripe could not be reached (${method} ${path})`);
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = isObject(json) && isObject(json.error) ? json.error : {};
      const detail = [text(error.type), text(error.code), text(error.message)?.slice(0, 200)].filter(Boolean).join(': ');
      throw new PaymentsError(`Stripe answered ${response.status} to ${method} ${path}${detail ? ` (${detail})` : ''}`, response.status);
    }
    if (!isObject(json)) throw new PaymentsError(`Stripe sent something unexpected for ${method} ${path}`, response.status);
    return json;
  }

  async function priceIdFor(lookupKey: string): Promise<string> {
    const cached = prices.get(lookupKey);
    if (cached && now() - cached.at < PRICE_CACHE_MS) return cached.id;
    const list = await call('GET', '/v1/prices', { lookup_keys: [lookupKey], active: true, limit: 1 });
    const first = Array.isArray(list.data) ? list.data[0] : undefined;
    const id = isObject(first) ? text(first.id) : null;
    if (!id) {
      throw new PaymentsError(`No active Stripe price has the lookup key ${lookupKey}: run server/scripts/stripe-setup.mjs`);
    }
    prices.set(lookupKey, { id, at: now() });
    return id;
  }

  let signingKey: Promise<CryptoKey> | null = null;

  return {
    async createCheckout(input) {
      const price = await priceIdFor(input.lookupKey);
      const mode = input.mode ?? 'subscription';
      const params: Params = {
        mode,
        line_items: [{ price, quantity: Math.max(1, Math.floor(input.quantity ?? 1)) }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.clientReferenceId,
        allow_promotion_codes: true,
        metadata: input.metadata,
      };
      if (input.customer) params.customer = input.customer;
      else if (input.customerEmail) params.customer_email = input.customerEmail;
      // A one-time payment makes a customer only when asked; Tabfold wants one (billing, receipts).
      if (mode === 'payment' && !input.customer) params.customer_creation = 'always';
      if (mode === 'subscription' && input.trialEnd) params.subscription_data = { trial_end: Math.floor(input.trialEnd) };
      if (input.automaticTax) {
        params.automatic_tax = { enabled: true };
        // Stripe Tax needs the address on the customer; let Checkout save it there.
        if (input.customer) params.customer_update = { address: 'auto' };
      }
      const session = await call('POST', '/v1/checkout/sessions', params);
      const id = text(session.id);
      const url = text(session.url);
      if (!id || !url) throw new PaymentsError('Stripe sent a checkout session without an id or address');
      return { id, url };
    },

    async getCheckout(id) {
      return readCheckout(await call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`));
    },

    async getSubscription(id) {
      return readSubscription(await call('GET', `/v1/subscriptions/${encodeURIComponent(id)}`));
    },

    async updateQuantity(itemId, quantity) {
      await call('POST', `/v1/subscription_items/${encodeURIComponent(itemId)}`, {
        quantity: Math.max(1, Math.floor(quantity)),
        proration_behavior: 'create_prorations',
      });
    },

    async cancelSubscription(id) {
      return readSubscription(await call('DELETE', `/v1/subscriptions/${encodeURIComponent(id)}`));
    },

    async createPortal(input) {
      const params: Params = { customer: input.customer, return_url: input.returnUrl, configuration: input.configuration };
      if (input.flow === 'payment-method') {
        params.flow_data = {
          type: 'payment_method_update',
          after_completion: { type: 'redirect', redirect: { return_url: input.returnUrl } },
        };
      }
      const session = await call('POST', '/v1/billing_portal/sessions', params);
      const url = text(session.url);
      if (!url) throw new PaymentsError('Stripe sent a billing portal session without an address');
      return { url };
    },

    async verifyWebhook(rawBody, signatureHeader) {
      if (!options.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
      let timestamp: number | null = null;
      const signatures: string[] = [];
      for (const part of (signatureHeader ?? '').split(',')) {
        const [key, value] = part.trim().split('=', 2);
        if (key === 't' && value && /^\d+$/.test(value)) timestamp = Number(value);
        if (key === 'v1' && value) signatures.push(value.toLowerCase());
      }
      if (timestamp === null || signatures.length === 0) throw new WebhookSignatureError('No Stripe signature');
      signingKey ??= crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(options.webhookSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const expected = hex(await crypto.subtle.sign('HMAC', await signingKey, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
      // Check every v1 signature, matching or not, so the time taken doesn't say which one matched.
      let matched = false;
      for (const signature of signatures) matched = safeEqual(signature, expected) || matched;
      if (!matched) throw new WebhookSignatureError('The Stripe signature doesn’t match');
      if (Math.abs(now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) {
        throw new WebhookSignatureError('The Stripe signature is too old');
      }
      let event: unknown;
      try {
        event = JSON.parse(rawBody);
      } catch {
        throw new WebhookSignatureError('The Stripe event isn’t JSON');
      }
      if (!isObject(event) || !text(event.id) || !text(event.type) || !isObject(event.data) || !isObject(event.data.object)) {
        throw new WebhookSignatureError('The Stripe event isn’t an event');
      }
      return { id: text(event.id)!, type: text(event.type)!, data: { object: event.data.object } };
    },
  };
}
