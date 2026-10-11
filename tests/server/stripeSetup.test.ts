import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeStripe, type RunningFakeStripe } from './fakeStripe.ts';

// Runs server/scripts/stripe-setup.mjs as people do (plain Node, a secret key in the environment),
// against the fake Stripe.

interface ExecError extends Error {
  code?: number;
}

interface NodeProcess {
  execPath: string;
  env: Record<string, string | undefined>;
  getBuiltinModule(id: 'node:child_process'): {
    execFile(
      file: string,
      args: string[],
      options: { env: Record<string, string | undefined>; timeout: number },
      callback: (error: ExecError | null, stdout: string, stderr: string) => void,
    ): void;
  };
}

const node = (globalThis as unknown as { process: NodeProcess }).process;
const SCRIPT = new URL('../../server/scripts/stripe-setup.mjs', import.meta.url).pathname;
const KEY = 'sk_test_51SetupScriptKey';
const WEBHOOK = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/tabfold/stripe/webhook';

let fake: RunningFakeStripe;

beforeEach(async () => {
  fake = await startFakeStripe({ webhookSecret: 'whsec_from_setup' });
});

afterEach(async () => {
  await fake.close();
});

function run(args: string[], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(node.env).filter(([name]) => !name.startsWith('STRIPE_')));
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    node.getBuiltinModule('node:child_process').execFile(
      node.execPath,
      [SCRIPT, ...args],
      { env: { ...clean, STRIPE_SECRET_KEY: KEY, STRIPE_API_BASE: fake.url, ...env }, timeout: 20_000 },
      (error, out, err) => resolve({ code: error ? (error.code ?? 1) : 0, out, err }),
    );
  });
}

describe('stripe-setup.mjs', () => {
  it('creates the products, prices, portal settings and webhook', async () => {
    const { code, out, err } = await run(['--webhook-url', WEBHOOK]);
    expect(err).toBe('');
    expect(code).toBe(0);

    expect([...fake.products.values()].map((p) => [p.name, p.metadata.tabfold_tier])).toEqual([
      ['Tabfold Pro', 'pro'],
      ['Tabfold Pro AI', 'pro-ai'],
    ]);
    const prices = [...fake.prices.values()].map((p) => [p.lookup_key, p.unit_amount, p.currency, p.recurring.interval, fake.products.get(p.product)!.name]);
    expect(prices).toEqual([
      ['pro-monthly', 500, 'usd', 'month', 'Tabfold Pro'],
      ['pro-yearly', 4800, 'usd', 'year', 'Tabfold Pro'],
      ['pro-ai-monthly', 900, 'usd', 'month', 'Tabfold Pro AI'],
      ['pro-ai-yearly', 8400, 'usd', 'year', 'Tabfold Pro AI'],
    ]);

    const [config] = [...fake.portalConfigurations.values()];
    expect(config!.features).toMatchObject({
      invoice_history: { enabled: 'true' },
      payment_method_update: { enabled: 'true' },
      customer_update: { enabled: 'true', allowed_updates: ['email', 'address'] },
      subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
      subscription_update: { enabled: 'true', default_allowed_updates: ['price'], proration_behavior: 'create_prorations' },
    });
    const pro = fake.priceFor('pro-monthly')!;
    const ai = fake.priceFor('pro-ai-yearly')!;
    expect(config!.features.subscription_update.products).toEqual([
      { product: pro.product, prices: [pro.id, fake.priceFor('pro-yearly')!.id] },
      { product: ai.product, prices: [fake.priceFor('pro-ai-monthly')!.id, ai.id] },
    ]);

    const [endpoint] = [...fake.webhookEndpoints.values()];
    expect(endpoint).toMatchObject({
      url: WEBHOOK,
      api_version: '2024-06-20',
      enabled_events: ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'],
    });

    expect(out).toContain('test mode');
    expect(out).toContain(`supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_from_setup STRIPE_PORTAL_CONFIGURATION=${config!.id}`);
    expect(out).not.toContain(KEY);
    expect(fake.requests.every((r) => r.stripeVersion === '2024-06-20')).toBe(true);
  });

  it('changes nothing it doesn’t need to on a second run', async () => {
    await run(['--webhook-url', WEBHOOK]);
    const counts = () => [fake.products.size, fake.prices.size, fake.portalConfigurations.size, fake.webhookEndpoints.size];
    expect(counts()).toEqual([2, 4, 1, 1]);
    const { code, out } = await run([`--webhook-url=${WEBHOOK}`]);
    expect(code).toBe(0);
    expect(counts()).toEqual([2, 4, 1, 1]);
    expect(out).toContain('already there');
    expect(out).toContain('updated');
    expect(out).toContain(`supabase secrets set STRIPE_PORTAL_CONFIGURATION=${[...fake.portalConfigurations.keys()][0]}`);
    expect(out).not.toContain('STRIPE_WEBHOOK_SECRET=');
    expect(out).toContain('Signing secret');
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/v1/billing_portal/configurations/'))).toHaveLength(1);
  });

  it('adds only the missing prices, to the existing product', async () => {
    await run(['--webhook-url', WEBHOOK]);
    const aiYearly = fake.priceFor('pro-ai-yearly')!;
    aiYearly.active = false;
    await run(['--webhook-url', WEBHOOK]);
    const replacement = fake.priceFor('pro-ai-yearly')!;
    expect(replacement.id).not.toBe(aiYearly.id);
    expect(replacement.product).toBe(aiYearly.product);
    expect(fake.products.size).toBe(2);
  });

  it('adds missing events to an existing webhook', async () => {
    await run(['--webhook-url', WEBHOOK]);
    const [endpoint] = [...fake.webhookEndpoints.values()];
    endpoint!.enabled_events = ['checkout.session.completed'];
    await run(['--webhook-url', WEBHOOK]);
    expect(endpoint!.enabled_events).toHaveLength(4);
  });

  it('explains what it needs', async () => {
    const noUrl = await run([]);
    expect(noUrl.code).toBe(1);
    expect(noUrl.err).toContain('--webhook-url');
    const noKey = await run(['--webhook-url', WEBHOOK], { STRIPE_SECRET_KEY: '' });
    expect(noKey.code).toBe(1);
    expect(noKey.err).toContain('STRIPE_SECRET_KEY');
    const badUrl = await run(['--webhook-url', 'not a url']);
    expect(badUrl.code).toBe(1);
    expect(fake.requests).toHaveLength(0);
  });

  it('says what Stripe refused, without the key', async () => {
    const { code, err } = await run(['--webhook-url', WEBHOOK], { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: `${fake.url}/nowhere` });
    expect(code).toBe(1);
    expect(err).toContain('Stripe refused GET /v1/prices');
    expect(err).not.toContain('sk_test_x');
  });
});
