import { browser, type Browser } from 'wxt/browser';
import { extUrl } from '../extUrl';
import { api, ProError } from './api';
import { PRO_CONFIG, proConfigured } from './config';
import { refreshPlan } from './plan';
import { checkoutNotice, checkoutState, lastCheckoutAt, needsSignIn } from './state';
import type { BillingInterval, CheckoutPlan, CheckoutState, PlanState, Tier } from './types';

/**
 * Stripe Checkout and Stripe's billing page, each opened in a tab and watched (Stripe-Checkout
 * board). Nothing about payments runs inside the extension: the server makes the Stripe session
 * (`POST /checkout`, `POST /billing`) and Stripe's own page takes the card.
 *
 * While a checkout tab is open the plan is read every 5 seconds (at most 15 minutes). When Stripe
 * sends the tab back to `<API>/checkout/done`, the tab turns into the welcome page; at
 * `<API>/checkout/cancel` it closes and the pages say "Checkout closed. Nothing was charged." (also
 * when the person closes the tab without paying). The billing tab closes itself at
 * `<API>/billing/done` and the Tabfold page it came from comes back to the front.
 */

export const CHECKOUT_POLL_MS = 5_000;
export const CHECKOUT_MAX_MS = 15 * 60_000;
/** The page the checkout tab turns into after paying. */
export const WELCOME_PATH = '/library.html#/pro/welcome';

const BILLING_WATCH = 'billingWatch';
const TAB_FAILED = 'Chrome couldn’t open the page. Try again.';

interface BillingWatch {
  tabId: number;
  openerTabId?: number;
  startedAt: number;
}

/** Where a command came from: the Tabfold tab that sent it. */
export interface Source {
  tabId?: number;
}

// Kept in memory too: tabs.onRemoved asks on every closed tab (hundreds during a fold).
let cachedCheckout: CheckoutState | null | undefined;
let cachedBilling: BillingWatch | null | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

/** For tests: forget the cached watches and stop polling. */
export function resetCheckoutRuntime(): void {
  cachedCheckout = undefined;
  cachedBilling = undefined;
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

export async function getCheckout(): Promise<CheckoutState | null> {
  if (cachedCheckout === undefined) cachedCheckout = (await checkoutState.get()) ?? null;
  return cachedCheckout;
}

async function setCheckout(value: CheckoutState | null): Promise<void> {
  cachedCheckout = value;
  if (!value) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  await checkoutState.set(value);
}

async function getBilling(): Promise<BillingWatch | null> {
  if (cachedBilling === undefined) {
    cachedBilling = ((await browser.storage.session.get(BILLING_WATCH))[BILLING_WATCH] as BillingWatch | undefined) ?? null;
  }
  return cachedBilling;
}

async function setBilling(value: BillingWatch | null): Promise<void> {
  cachedBilling = value;
  if (value) await browser.storage.session.set({ [BILLING_WATCH]: value });
  else await browser.storage.session.remove(BILLING_WATCH);
}

/** Paid for: a live subscription (a trial isn't one), Pro for life, or a team's live plan. */
export function isPaid(plan: PlanState): boolean {
  if (plan.lifetime === true || !!plan.team) return true;
  return plan.tier !== 'free' && (plan.status === 'active' || plan.status === 'past_due');
}

/** Teams: seats 1–100 (default 3), the name at most 60 characters (server/API.md "Teams"). */
export const TEAM_SEATS = { min: 1, max: 100, default: 3 } as const;

/** The `POST /checkout` body: a subscription's period; Pro for life is one payment; Teams adds seats and a name. */
export function checkoutBody(tier: CheckoutPlan, interval: BillingInterval, team: { seats?: number; teamName?: string } = {}): Record<string, unknown> {
  if (tier === 'pro-lifetime') return { tier };
  if (tier !== 'teams') return { tier, interval };
  const asked = typeof team.seats === 'number' && Number.isFinite(team.seats) ? Math.round(team.seats) : TEAM_SEATS.default;
  const seats = Math.min(TEAM_SEATS.max, Math.max(TEAM_SEATS.min, asked));
  const teamName = (team.teamName ?? '').trim().slice(0, 60);
  return { tier, interval, seats, ...(teamName ? { teamName } : {}) };
}

/** An https address from the server (http only for a server on this computer, as in the end-to-end test). */
function pageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return url.href;
  } catch {
    // Not an address.
  }
  return null;
}

/** Which of the server's return pages an address is, if any. Cheap for every other address. */
export function returnPage(url: string): 'checkout-done' | 'checkout-cancel' | 'billing-done' | null {
  const base = PRO_CONFIG.apiUrl;
  if (!base || !url.startsWith(base)) return null;
  let path: string;
  try {
    const parsed = new URL(url);
    const root = new URL(base);
    if (parsed.origin !== root.origin) return null;
    path = parsed.pathname.slice(root.pathname.replace(/\/+$/, '').length).replace(/\/+$/, '');
  } catch {
    return null;
  }
  if (path === '/checkout/done') return 'checkout-done';
  if (path === '/checkout/cancel') return 'checkout-cancel';
  if (path === '/billing/done') return 'billing-done';
  return null;
}

/** A new active tab next to the Tabfold page that asked for it. */
async function openTab(url: string, source: Source): Promise<Browser.tabs.Tab | null> {
  const opener = source.tabId !== undefined ? await browser.tabs.get(source.tabId).catch(() => undefined) : undefined;
  try {
    return await browser.tabs.create({
      url,
      active: true,
      ...(opener?.id !== undefined ? { windowId: opener.windowId, index: opener.index + 1, openerTabId: opener.id } : {}),
    });
  } catch {
    return null;
  }
}

async function focusTab(tabId: number): Promise<boolean> {
  try {
    const tab = await browser.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await browser.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function schedulePoll(delayMs = CHECKOUT_POLL_MS): void {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    pollCheckout().catch((error) => console.warn('[tabfold] checkout poll failed', (error as Error)?.name ?? error));
  }, delayMs);
}

// ---------------------------------------------------------------------------------------------
// Checkout

/**
 * Open Stripe Checkout for a plan in a new tab and watch it. With a live subscription already
 * (`already-subscribed`), Stripe's billing page opens instead, where plans change.
 */
export async function openCheckout(
  tier: CheckoutPlan,
  interval: BillingInterval,
  source: Source = {},
  team: { seats?: number; teamName?: string } = {},
): Promise<{ opened: boolean; reason?: string }> {
  if (!proConfigured()) throw new ProError('not-configured');
  let answer: { url?: unknown; sessionId?: unknown };
  try {
    answer = await api('/checkout', { method: 'POST', body: checkoutBody(tier, interval, team) });
  } catch (error) {
    if (error instanceof ProError && error.code === 'already-subscribed') {
      // Pro for life is bought once: there's no plan to change in billing.
      if (tier === 'pro-lifetime') throw new ProError('already-subscribed', 'You already have Tabfold Pro for life.', error.status, error.body);
      return openBilling({}, source);
    }
    throw error;
  }
  const url = pageUrl(answer?.url);
  if (!url) throw new ProError('server', 'Tabfold’s server sent an unexpected answer.');
  // This computer's token is what the payment signs in: kept for a day even while not signed in.
  await lastCheckoutAt.set(Date.now());
  const tab = await openTab(url, source);
  if (tab?.id === undefined) return { opened: false, reason: TAB_FAILED };
  await setCheckout({
    tabId: tab.id,
    sessionId: typeof answer.sessionId === 'string' ? answer.sessionId : '',
    tier,
    interval,
    startedAt: Date.now(),
    ...(source.tabId !== undefined ? { openerTabId: source.tabId } : {}),
  });
  schedulePoll();
  return { opened: true };
}

/** One poll while the checkout tab is open: read the plan. Stops when the tab is gone or after 15 minutes. */
export async function pollCheckout(now = Date.now()): Promise<'watching' | 'done' | 'idle'> {
  const watch = await getCheckout();
  if (!watch) return 'idle';
  if (!(await tabExists(watch.tabId))) {
    await checkoutTabClosed(watch);
    return 'done';
  }
  if (now - watch.startedAt >= CHECKOUT_MAX_MS) {
    await setCheckout(null);
    await refreshPlan({ force: true });
    return 'done';
  }
  await refreshPlan({ force: true });
  schedulePoll();
  return 'watching';
}

/**
 * The checkout tab closed before Stripe sent it back: say so, unless the payment went through
 * anyway (the plan is paid, or it is on an account this computer has to sign in to).
 */
async function checkoutTabClosed(watch: CheckoutState): Promise<void> {
  await setCheckout(null);
  const plan = await refreshPlan({ force: true });
  if (isPaid(plan) || (await needsSignIn.get())) {
    if (watch.openerTabId !== undefined) await focusTab(watch.openerTabId);
  } else {
    await checkoutNotice.set({ kind: 'closed', at: Date.now() });
  }
}

/** "Go to the Stripe tab". */
export async function focusCheckout(): Promise<{ focused: boolean }> {
  const watch = await getCheckout();
  if (!watch) return { focused: false };
  const focused = await focusTab(watch.tabId);
  if (!focused) await checkoutTabClosed(watch);
  return { focused };
}

// ---------------------------------------------------------------------------------------------
// Billing

/** Open Stripe's billing page in a new tab; `payment-method` goes straight to the card form. */
export async function openBilling(options: { flow?: 'payment-method' } = {}, source: Source = {}): Promise<{ opened: boolean; reason?: string }> {
  if (!proConfigured()) throw new ProError('not-configured');
  const answer = await api<{ url?: unknown }>('/billing', { method: 'POST', body: options.flow ? { flow: options.flow } : {} });
  const url = pageUrl(answer?.url);
  if (!url) throw new ProError('server', 'Tabfold’s server sent an unexpected answer.');
  const tab = await openTab(url, source);
  if (tab?.id === undefined) return { opened: false, reason: TAB_FAILED };
  await setBilling({ tabId: tab.id, startedAt: Date.now(), ...(source.tabId !== undefined ? { openerTabId: source.tabId } : {}) });
  return { opened: true };
}

// ---------------------------------------------------------------------------------------------
// In the worker

/** tabs.onUpdated with a new address: the server's return pages become Tabfold's own. */
export async function onTabUrl(tabId: number, url: string): Promise<void> {
  const page = returnPage(url);
  if (!page) return;
  if (page === 'billing-done') {
    const watch = await getBilling();
    if (watch?.tabId === tabId) await setBilling(null);
    await browser.tabs.remove(tabId).catch(() => undefined);
    if (watch?.openerTabId !== undefined) await focusTab(watch.openerTabId);
    await refreshPlan({ force: true });
    return;
  }
  const watch = await getCheckout();
  const watched = watch?.tabId === tabId ? watch : null;
  if (watched) await setCheckout(null);
  if (page === 'checkout-done') {
    await browser.tabs.update(tabId, { url: extUrl(WELCOME_PATH) }).catch(() => undefined);
    await refreshPlan({ force: true });
    return;
  }
  await browser.tabs.remove(tabId).catch(() => undefined);
  await checkoutNotice.set({ kind: 'closed', at: Date.now() });
  if (watched?.openerTabId !== undefined) await focusTab(watched.openerTabId);
}

/** tabs.onRemoved: a watched checkout or billing tab closed. Cheap for every other tab. */
export async function onTabClosed(tabId: number): Promise<void> {
  const checkout = await getCheckout();
  if (checkout?.tabId === tabId) await checkoutTabClosed(checkout);
  const billing = await getBilling();
  if (billing?.tabId === tabId) {
    await setBilling(null);
    await refreshPlan({ force: true });
  }
}

/** At worker start: a checkout being watched picks up again. */
export function setupCheckout(): void {
  getCheckout()
    .then((watch) => {
      if (watch) schedulePoll(0);
    })
    .catch(() => undefined);
}
