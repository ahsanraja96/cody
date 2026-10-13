import { beforeEach, describe, expect, it } from 'vitest';
import { createServer, PUBLIC_URL, type Server } from './fakes';

// The Stripe account may sell other products too (Tabfold runs in the owner's existing business
// account): Tabfold acts only on checkouts it started and on its own prices.

let server: Server;

beforeEach(async () => {
  server = createServer();
  await server.ready;
});

/** Another product in the same Stripe account, with its own monthly price. */
async function otherProductPrice(): Promise<string> {
  const post = async (path: string, body: Record<string, string>) => {
    const res = await server.stripe.fetch(`${server.stripe.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk_test_other', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return (await res.json()) as { id: string };
  };
  const product = await post('/v1/products', { name: 'CIS Statements' });
  await post('/v1/prices', {
    product: product.id,
    currency: 'usd',
    unit_amount: '1200',
    'recurring[interval]': 'month',
    lookup_key: 'cis-monthly',
  });
  return 'cis-monthly';
}

const hasAccount = (email: string) => [...server.store.accounts.values()].some((a) => a.email === email);

describe('a Stripe account shared with other products', () => {
  it('ignores a completed checkout Tabfold didn’t start: no account, no subscription', async () => {
    const lookupKey = await otherProductPrice();
    const session = await server.payments.createCheckout({
      lookupKey,
      successUrl: 'https://truewidgets.com/thanks',
      cancelUrl: 'https://truewidgets.com/',
      automaticTax: false,
      metadata: {},
      customerEmail: 'cis-buyer@example.com',
    });
    const paid = await server.stripe.completeSession(session.id, { email: 'cis-buyer@example.com' });
    expect(paid.subscription).not.toBeNull();
    const statuses = await server.deliverEvents();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(hasAccount('cis-buyer@example.com')).toBe(false);
    expect([...server.store.subscriptions.keys()]).not.toContain(paid.subscription!.id);
    expect(server.log).not.toHaveBeenCalled();
  });

  it('ignores another product’s subscription events, even for a Tabfold customer', async () => {
    const lookupKey = await otherProductPrice();
    const account = server.store.account('pro@example.com');
    const other = server.stripe.addSubscription({ customer: account.stripeCustomerId!, lookupKey });
    await server.stripe.emit('customer.subscription.updated', other);
    expect(await server.deliverEvents()).toEqual([200]);
    expect([...server.store.subscriptions.keys()]).not.toContain(other.id);
  });

  it('still processes its own checkouts, marked as Tabfold’s', async () => {
    const res = await server.request('POST', '/checkout', { key: 'device-free'.padEnd(43, '0'), body: { tier: 'pro', interval: 'month' } });
    expect(res.status).toBe(200);
    expect(server.stripe.sessions.get(res.json.sessionId)!.metadata).toMatchObject({ app: 'tabfold' });
    expect(PUBLIC_URL).toContain('/tabfold');
  });
});
