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
  fake = await startFakeStripe({ webhookSecret: 'whsec_from_setup', prices: false });
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
      ['Tabfold Pro for life', 'pro-lifetime'],
      ['Tabfold Teams', 'teams'],
    ]);
    const prices = [...fake.prices.values()].map((p) => [
      p.lookup_key,
      p.unit_amount,
      p.currency,
      p.recurring?.interval ?? 'once',
      fake.products.get(p.product)!.name,
    ]);
    expect(prices).toEqual([
      ['tabfold-pro-monthly', 500, 'usd', 'month', 'Tabfold Pro'],
      ['tabfold-pro-yearly', 4800, 'usd', 'year', 'Tabfold Pro'],
      ['tabfold-pro-ai-monthly', 900, 'usd', 'month', 'Tabfold Pro AI'],
      ['tabfold-pro-ai-yearly', 8400, 'usd', 'year', 'Tabfold Pro AI'],
      ['tabfold-pro-lifetime', 9900, 'usd', 'once', 'Tabfold Pro for life'],
      ['tabfold-teams-monthly', 1000, 'usd', 'month', 'Tabfold Teams'],
      ['tabfold-teams-yearly', 9600, 'usd', 'year', 'Tabfold Teams'],
    ]);
    expect(fake.priceFor('tabfold-pro-lifetime')!.type).toBe('one_time');
    expect(out).toContain('Price tabfold-pro-lifetime ($99.00 once)');
    expect(out).toContain('Price tabfold-teams-yearly ($96.00 a year per person)');

    const [config] = [...fake.portalConfigurations.values()];
    expect(config!.features).toMatchObject({
      invoice_history: { enabled: 'true' },
      payment_method_update: { enabled: 'true' },
      customer_update: { enabled: 'true', allowed_updates: ['email', 'address'] },
      subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
      subscription_update: { enabled: 'true', default_allowed_updates: ['price'], proration_behavior: 'create_prorations' },
    });
    // Switching plans covers Pro and Pro AI only: a Teams plan's seats change through Tabfold.
    const pro = fake.priceFor('tabfold-pro-monthly')!;
    const ai = fake.priceFor('tabfold-pro-ai-yearly')!;
    expect(config!.features.subscription_update.products).toEqual([
      { product: pro.product, prices: [pro.id, fake.priceFor('tabfold-pro-yearly')!.id] },
      { product: ai.product, prices: [fake.priceFor('tabfold-pro-ai-monthly')!.id, ai.id] },
    ]);

    const [endpoint] = [...fake.webhookEndpoints.values()];
    expect(endpoint).toMatchObject({
      url: WEBHOOK,
      api_version: '2024-06-20',
      enabled_events: [
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
      ],
    });

    expect(out).toContain('test mode');
    expect(out).toContain(`supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_from_setup STRIPE_PORTAL_CONFIGURATION=${config!.id}`);
    expect(out).not.toContain(KEY);
    expect(fake.requests.every((r) => r.stripeVersion === '2024-06-20')).toBe(true);
  });

  it('changes nothing it doesn’t need to on a second run', async () => {
    await run(['--webhook-url', WEBHOOK]);
    const counts = () => [fake.products.size, fake.prices.size, fake.portalConfigurations.size, fake.webhookEndpoints.size];
    expect(counts()).toEqual([4, 7, 1, 1]);
    const { code, out } = await run([`--webhook-url=${WEBHOOK}`]);
    expect(code).toBe(0);
    expect(counts()).toEqual([4, 7, 1, 1]);
    expect(out).toContain('already there');
    expect(out).toContain('updated');
    expect(out).toContain(`supabase secrets set STRIPE_PORTAL_CONFIGURATION=${[...fake.portalConfigurations.keys()][0]}`);
    expect(out).not.toContain('STRIPE_WEBHOOK_SECRET=');
    expect(out).toContain('Signing secret');
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/v1/billing_portal/configurations/'))).toHaveLength(1);
  });

  it('adds only the missing prices, to the existing product', async () => {
    await run(['--webhook-url', WEBHOOK]);
    const aiYearly = fake.priceFor('tabfold-pro-ai-yearly')!;
    aiYearly.active = false;
    await run(['--webhook-url', WEBHOOK]);
    const replacement = fake.priceFor('tabfold-pro-ai-yearly')!;
    expect(replacement.id).not.toBe(aiYearly.id);
    expect(replacement.product).toBe(aiYearly.product);
    expect(fake.products.size).toBe(4);
  });

  it('adds the new plans’ prices to a Stripe set up before them', async () => {
    // As an earlier version of the script left it: Pro and Pro AI only.
    fake.seedPrices();
    for (const key of ['tabfold-pro-lifetime', 'tabfold-teams-monthly', 'tabfold-teams-yearly']) {
      const price = fake.priceFor(key)!;
      fake.prices.delete(price.id);
      if (![...fake.prices.values()].some((p) => p.product === price.product)) fake.products.delete(price.product);
    }
    expect([fake.products.size, fake.prices.size]).toEqual([2, 4]);
    const { code } = await run(['--webhook-url', WEBHOOK]);
    expect(code).toBe(0);
    expect([fake.products.size, fake.prices.size]).toEqual([4, 7]);
    expect(fake.priceFor('tabfold-teams-monthly')!.recurring).toEqual({ interval: 'month', interval_count: 1 });
  });

  it('adds missing events to an existing webhook', async () => {
    await run(['--webhook-url', WEBHOOK]);
    const [endpoint] = [...fake.webhookEndpoints.values()];
    endpoint!.enabled_events = ['checkout.session.completed'];
    await run(['--webhook-url', WEBHOOK]);
    expect(endpoint!.enabled_events).toHaveLength(5);
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
