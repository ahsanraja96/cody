import { vi } from 'vitest';
import { createModel, type CallJson } from '../../server/supabase/functions/tabfold/ai.ts';
import { handle, sha256Hex, type Deps } from '../../server/supabase/functions/tabfold/app.ts';
import { createStripe, readSubscription } from '../../server/supabase/functions/tabfold/stripe.ts';
import { createFakeStripe, type StripeObject } from './fakeStripe.ts';
import { memoryMailer } from './memoryMailer.ts';
import { MemoryStore } from './memoryStore.ts';

/** Fakes for the server tests: an in-memory Store, a fake Stripe (no network), a mailer that keeps codes and invitations, the model. */

export const DAY = 24 * 60 * 60 * 1000;
export const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
export const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
export const PUBLIC_URL = 'https://example.supabase.co/functions/v1/tabfold';
export const WEBHOOK_SECRET = 'whsec_test_tabfold';

interface TestUser {
  email: string;
  trialStartedAt?: number;
  subscription?: { lookupKey: string; status?: string; cancelAtPeriodEnd?: boolean };
}

/** Accounts every test server starts with, each signed in on its own computer (`keyOf`). */
export const USERS = {
  free: { email: 'free@example.com' },
  proMonthly: { email: 'pro@example.com', subscription: { lookupKey: 'pro-monthly' } },
  proYearly: { email: 'yearly@example.com', subscription: { lookupKey: 'pro-yearly' } },
  proAiMonthly: { email: 'ai@example.com', subscription: { lookupKey: 'pro-ai-monthly' } },
  proAiYearly: { email: 'ai-yearly@example.com', subscription: { lookupKey: 'pro-ai-yearly', cancelAtPeriodEnd: true } },
  trialRunning: { email: 'trial@example.com', trialStartedAt: NOW - 2 * DAY },
  trialEnded: { email: 'ended@example.com', trialStartedAt: NOW - 8 * DAY },
  proDuringTrial: { email: 'both@example.com', trialStartedAt: NOW - 1 * DAY, subscription: { lookupKey: 'pro-monthly' } },
  cancelled: { email: 'gone@example.com', subscription: { lookupKey: 'pro-monthly', status: 'canceled' } },
  pastDue: { email: 'late@example.com', subscription: { lookupKey: 'pro-ai-monthly', status: 'past_due' } },
} satisfies Record<string, TestUser>;

export type UserName = keyof typeof USERS;

/** The device token of each test user's computer (43 characters, like the extension's). */
export const keyOf = (name: UserName) => `device-${name}`.padEnd(43, '0');
/** A fresh device token: a computer the server has never seen. */
export const newToken = (label: string) => `new-${label}`.padEnd(43, 'x');

export { MemoryStore } from './memoryStore.ts';

export interface RequestOptions {
  /** A test user, a raw token, or null for no Authorization header. Default: proAiMonthly. */
  key?: UserName | string | null;
  body?: unknown;
  rawBody?: string;
  origin?: string;
  headers?: Record<string, string>;
}

export function createServer(options: { allowedOrigins?: string[]; automaticTax?: boolean } = {}) {
  const clock = { now: NOW };
  const now = () => clock.now;
  const store = new MemoryStore({ now });
  const stripe = createFakeStripe({ prices: true, webhookSecret: WEBHOOK_SECRET, now });
  const mailer = memoryMailer();
  const callJson = vi.fn<CallJson>();
  const log = vi.fn<(message: string) => void>();
  const payments = createStripe({ secretKey: 'sk_test_tabfold', webhookSecret: WEBHOOK_SECRET, fetch: stripe.fetch, now });
  const deps: Deps = {
    store,
    payments,
    mailer,
    model: createModel(callJson),
    now,
    config: {
      allowedOrigins: options.allowedOrigins ?? [EXTENSION],
      publicUrl: PUBLIC_URL,
      automaticTax: options.automaticTax ?? false,
      codeSecret: 'code-secret-for-tests',
    },
    log,
  };

  // The test users: accounts, Stripe customers and subscriptions (set up at once), and a linked
  // computer each (once `ready`, which `request` waits for).
  const users = Object.entries(USERS) as [UserName, TestUser][];
  for (const [, user] of users) {
    const account = store.account(user.email);
    account.trialStartedAt = user.trialStartedAt ?? null;
    account.createdAt = NOW - 30 * DAY;
    account.emailVerifiedAt = NOW - 30 * DAY;
    if (user.subscription) {
      const customer = stripe.addCustomer(user.email);
      account.stripeCustomerId = customer.id;
      const sub = stripe.addSubscription({
        customer: customer.id,
        lookupKey: user.subscription.lookupKey,
        status: user.subscription.status,
        cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
        created: Math.floor((NOW - 10 * DAY) / 1000),
      });
      store.subscriptions.set(sub.id, { accountId: account.id, subscription: readSubscription(sub) });
    }
  }
  const ready = Promise.all(
    users.map(async ([name, user]) => store.link(await sha256Hex(keyOf(name)), store.account(user.email).id, 'device')),
  );

  async function request(method: string, path: string, opts: RequestOptions = {}) {
    await ready;
    const headers: Record<string, string> = { ...opts.headers };
    const key = opts.key === undefined ? 'proAiMonthly' : opts.key;
    if (key) headers.authorization = `Bearer ${key in USERS ? keyOf(key as UserName) : key}`;
    if (opts.origin) headers.origin = opts.origin;
    let body: string | undefined = opts.rawBody;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const url = path.startsWith('http') ? path : `${PUBLIC_URL}${path}`;
    const response = await handle(new Request(url, { method, headers, body }), deps);
    const text = await response.text();
    const isJson = response.headers.get('content-type')?.includes('json');
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: text && isJson ? (JSON.parse(text) as any) : null,
    };
  }

  /** Sends a fake Stripe event to the webhook, signed (or with the signature given). */
  async function webhook(event: StripeObject, signature?: string) {
    const signed = await stripe.signed(event);
    return request('POST', '/stripe/webhook', {
      key: null,
      rawBody: signed.body,
      headers: { 'stripe-signature': signature ?? signed.signature, 'content-type': 'application/json' },
    });
  }

  /** Signs a computer in with an emailed code. */
  async function signIn(token: string, email: string, startTrial = false) {
    await request('POST', '/signin/start', { key: token, body: { email, purpose: startTrial ? 'trial' : 'signin' } });
    const code = mailer.lastCode(email.trim().toLowerCase());
    return request('POST', '/signin/finish', { key: token, body: { email, code, startTrial } });
  }

  let delivered = 0;
  /** Sends the fake Stripe's events that haven't been sent yet to the webhook, oldest first; their answers' statuses. */
  async function deliverEvents() {
    const statuses: number[] = [];
    while (delivered < stripe.events.length) statuses.push((await webhook(stripe.events[delivered++]!)).status);
    return statuses;
  }

  /** Starts a checkout from a computer, pays it on the fake Stripe's page (with `email` when signed out) and sends the events. */
  async function buy(key: UserName | string, body: Record<string, unknown>, email?: string) {
    const res = await request('POST', '/checkout', { key, body });
    if (res.status !== 200) throw new Error(`Checkout answered ${res.status}: ${res.text}`);
    const paid = await stripe.completeSession(res.json.sessionId, { email });
    await deliverEvents();
    return { sessionId: res.json.sessionId as string, ...paid };
  }

  return { store, stripe, mailer, payments, callJson, log, clock, deps, ready, request, webhook, signIn, deliverEvents, buy };
}

export type Server = ReturnType<typeof createServer>;
