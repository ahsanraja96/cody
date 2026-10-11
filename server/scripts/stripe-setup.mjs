#!/usr/bin/env node
// Sets up Stripe for Tabfold Pro: the products and prices (Pro, Pro AI, Pro for life, Teams), a
// billing portal configuration and the webhook endpoint. Safe to run again: it only adds what's
// missing and brings the portal settings up to date. Run it once in test mode and once in live mode.
//
//   STRIPE_SECRET_KEY=sk_test_… node server/scripts/stripe-setup.mjs \
//     --webhook-url https://<project id>.supabase.co/functions/v1/tabfold/stripe/webhook
//
// Plain Node 20 or later, no packages. STRIPE_API_BASE points it at another Stripe (tests only).
// It never prints the secret key.

const STRIPE_VERSION = '2024-06-20';

const PRODUCTS = {
  pro: 'Tabfold Pro',
  'pro-ai': 'Tabfold Pro AI',
  'pro-lifetime': 'Tabfold Pro for life',
  teams: 'Tabfold Teams',
};

// interval null: one payment. Teams prices are per person: the subscription's quantity is its seats.
const PRICES = [
  { lookupKey: 'pro-monthly', tier: 'pro', amount: 500, interval: 'month', nickname: 'Pro, monthly' },
  { lookupKey: 'pro-yearly', tier: 'pro', amount: 4800, interval: 'year', nickname: 'Pro, yearly' },
  { lookupKey: 'pro-ai-monthly', tier: 'pro-ai', amount: 900, interval: 'month', nickname: 'Pro AI, monthly' },
  { lookupKey: 'pro-ai-yearly', tier: 'pro-ai', amount: 8400, interval: 'year', nickname: 'Pro AI, yearly' },
  { lookupKey: 'pro-lifetime', tier: 'pro-lifetime', amount: 9900, interval: null, nickname: 'Pro for life' },
  { lookupKey: 'teams-monthly', tier: 'teams', amount: 1000, interval: 'month', nickname: 'Teams, monthly, per person' },
  { lookupKey: 'teams-yearly', tier: 'teams', amount: 9600, interval: 'year', nickname: 'Teams, yearly, per person' },
];

// People switch between these in the billing portal. A Teams plan's seats change through Tabfold,
// and Pro for life is one payment, so the portal only shows their invoices, card and cancelling.
const SWITCHABLE = ['pro', 'pro-ai'];

const EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

const USAGE = `Usage:
  STRIPE_SECRET_KEY=sk_test_… node server/scripts/stripe-setup.mjs --webhook-url <url>

<url> is your server's address followed by /stripe/webhook, for example
  https://<project id>.supabase.co/functions/v1/tabfold/stripe/webhook`;

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function readArgs(argv) {
  let webhookUrl = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--webhook-url') {
      webhookUrl = argv[++i] ?? null;
    } else if (arg.startsWith('--webhook-url=')) {
      webhookUrl = arg.slice('--webhook-url='.length);
    } else {
      fail(`Unknown option: ${arg}`);
    }
  }
  return { webhookUrl };
}

const { webhookUrl } = readArgs(process.argv.slice(2));
const secretKey = (process.env.STRIPE_SECRET_KEY ?? '').trim();
const apiBase = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');

if (!/^(sk|rk)_(test|live)_\S+$/.test(secretKey)) {
  fail('Set STRIPE_SECRET_KEY to your Stripe secret key (it starts with sk_test_ or sk_live_).');
}
if (!webhookUrl) fail('Give the webhook address with --webhook-url.');
try {
  new URL(webhookUrl);
} catch {
  fail(`That webhook address isn't a web address: ${webhookUrl}`);
}

const live = /^(sk|rk)_live_/.test(secretKey);

/** Stripe's form encoding: a[b]=…, a[0][b]=… for lists of objects, a[]=… for lists of values. */
function formEncode(params) {
  const pairs = [];
  const add = (key, value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => add(item !== null && typeof item === 'object' ? `${key}[${i}]` : `${key}[]`, item));
    } else if (typeof value === 'object') {
      for (const [name, inner] of Object.entries(value)) add(`${key}[${name}]`, inner);
    } else {
      pairs.push([key, String(value)]);
    }
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return new URLSearchParams(pairs).toString();
}

async function stripe(method, path, params = {}) {
  const encoded = formEncode(params);
  const url = `${apiBase}${path}${method === 'GET' && encoded ? `?${encoded}` : ''}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': STRIPE_VERSION,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: method === 'POST' ? encoded : undefined,
    });
  } catch {
    throw new Error(`Couldn't reach Stripe (${method} ${path}). Check your internet connection.`);
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Stripe refused ${method} ${path}: ${message}`);
  }
  return json;
}

/** Every item of a Stripe list, page by page. */
async function listAll(path, params = {}) {
  const items = [];
  let startingAfter;
  for (;;) {
    const page = await stripe('GET', path, { ...params, limit: 100, starting_after: startingAfter });
    items.push(...page.data);
    if (!page.has_more || page.data.length === 0) return items;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const priceLabel = (spec) =>
  spec.interval === null
    ? `${dollars(spec.amount)} once`
    : `${dollars(spec.amount)} a ${spec.interval}${spec.tier === 'teams' ? ' per person' : ''}`;

async function setUpPrices() {
  const existing = await stripe('GET', '/v1/prices', {
    lookup_keys: PRICES.map((p) => p.lookupKey),
    active: true,
    limit: 10,
  });
  const byKey = new Map(existing.data.map((price) => [price.lookup_key, price]));

  // Each tier's product: from a price that already exists, else one marked as Tabfold's, else new.
  const products = {};
  for (const spec of PRICES) {
    const price = byKey.get(spec.lookupKey);
    if (price) products[spec.tier] ??= typeof price.product === 'string' ? price.product : price.product.id;
  }
  if (PRICES.some((spec) => !products[spec.tier])) {
    const all = await listAll('/v1/products', { active: true });
    for (const tier of Object.keys(PRODUCTS)) {
      products[tier] ??= all.find((product) => product.metadata?.tabfold_tier === tier)?.id;
    }
  }

  const rows = [];
  for (const spec of PRICES) {
    let price = byKey.get(spec.lookupKey);
    let state = 'already there';
    if (!price) {
      if (!products[spec.tier]) {
        const product = await stripe('POST', '/v1/products', {
          name: PRODUCTS[spec.tier],
          metadata: { tabfold_tier: spec.tier },
        });
        products[spec.tier] = product.id;
        rows.push({ what: `Product ${PRODUCTS[spec.tier]}`, id: product.id, state: 'created' });
      }
      price = await stripe('POST', '/v1/prices', {
        product: products[spec.tier],
        currency: 'usd',
        unit_amount: spec.amount,
        recurring: spec.interval ? { interval: spec.interval } : undefined,
        lookup_key: spec.lookupKey,
        transfer_lookup_key: true,
        nickname: spec.nickname,
        metadata: { tabfold_lookup_key: spec.lookupKey },
      });
      state = 'created';
      byKey.set(spec.lookupKey, price);
    }
    rows.push({ what: `Price ${spec.lookupKey} (${priceLabel(spec)})`, id: price.id, state });
  }
  return { products, prices: byKey, rows };
}

async function setUpPortal(products, prices) {
  const params = {
    business_profile: { headline: 'Manage your Tabfold plan' },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
      subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        products: SWITCHABLE.map((tier) => ({
          product: products[tier],
          prices: PRICES.filter((spec) => spec.tier === tier).map((spec) => prices.get(spec.lookupKey).id),
        })),
      },
    },
    metadata: { tabfold: 'portal' },
  };
  const configs = await listAll('/v1/billing_portal/configurations', { active: true });
  const mine = configs.find((config) => config.metadata?.tabfold === 'portal');
  if (mine) {
    await stripe('POST', `/v1/billing_portal/configurations/${mine.id}`, params);
    return { id: mine.id, state: 'updated' };
  }
  const created = await stripe('POST', '/v1/billing_portal/configurations', params);
  return { id: created.id, state: 'created' };
}

async function setUpWebhook() {
  const endpoints = await listAll('/v1/webhook_endpoints');
  const mine = endpoints.find((endpoint) => endpoint.url === webhookUrl);
  if (mine) {
    const missing = EVENTS.filter((event) => !mine.enabled_events.includes(event) && !mine.enabled_events.includes('*'));
    if (missing.length > 0) {
      await stripe('POST', `/v1/webhook_endpoints/${mine.id}`, { enabled_events: [...mine.enabled_events, ...missing] });
      return { id: mine.id, state: 'updated', secret: null };
    }
    return { id: mine.id, state: 'already there', secret: null };
  }
  const created = await stripe('POST', '/v1/webhook_endpoints', {
    url: webhookUrl,
    enabled_events: EVENTS,
    api_version: STRIPE_VERSION,
    description: 'Tabfold Pro server',
    metadata: { tabfold: 'webhook' },
  });
  return { id: created.id, state: 'created', secret: created.secret ?? null };
}

async function main() {
  console.log(`Setting up Stripe in ${live ? 'LIVE' : 'test'} mode…\n`);
  const { products, prices, rows } = await setUpPrices();
  const portal = await setUpPortal(products, prices);
  rows.push({ what: 'Billing portal settings', id: portal.id, state: portal.state });
  const webhook = await setUpWebhook();
  rows.push({ what: `Webhook ${webhookUrl}`, id: webhook.id, state: webhook.state });

  const width = Math.max(...rows.map((row) => row.what.length));
  for (const row of rows) console.log(`  ${row.what.padEnd(width)}  ${row.id}  ${row.state}`);

  const secrets = [`STRIPE_PORTAL_CONFIGURATION=${portal.id}`];
  if (webhook.secret) secrets.unshift(`STRIPE_WEBHOOK_SECRET=${webhook.secret}`);
  console.log('\nNext, from the server folder, store these as server secrets:\n');
  console.log(`  supabase secrets set ${secrets.join(' ')}`);
  console.log(`  supabase secrets set STRIPE_SECRET_KEY=<the same ${live ? 'sk_live_' : 'sk_test_'}… key you used here>`);
  if (!webhook.secret) {
    console.log(
      '\nThe webhook was already there, so Stripe doesn’t show its signing secret again. If STRIPE_WEBHOOK_SECRET\n' +
        'isn’t set yet, copy it from the Stripe dashboard: Developers → Webhooks → this endpoint → Signing secret.',
    );
  }
  console.log('\nThe webhook signing secret is a secret too: don’t share it or commit it.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
