import { browser } from 'wxt/browser';
import { EXTPAY_HOST, PRO_CONFIG } from './config';
import type { ExtPayUser } from './tiers';
import { PLAN_NICKNAMES, type BillingInterval, type Tier } from './types';

/**
 * ExtensionPay, called over its web API. Its own library is AGPL and needs a content script (an
 * install warning), so Tabfold talks to the same endpoints directly and keeps the key where the
 * library would (`extensionpay_api_key` in chrome.storage.sync), so it follows the person to their
 * other computers when they're signed in to Chrome.
 */

export const EXTPAY_KEY = 'extensionpay_api_key';

export type ExtPayPage = 'payment' | 'trial' | 'login' | 'manage';

/** ExtensionPay was unreachable, or answered with an error. The cached plan stays. */
export class ExtPayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtPayError';
  }
}

export function extpayBase(): string {
  return `${EXTPAY_HOST}/extension/${PRO_CONFIG.extpayId}`;
}

/** The install's key, or null before one was created. */
export async function getApiKey(): Promise<string | null> {
  for (const area of ['sync', 'local'] as const) {
    try {
      const value = (await browser.storage[area].get(EXTPAY_KEY))[EXTPAY_KEY];
      if (typeof value === 'string' && value) return value;
    } catch {
      // chrome.storage.sync can be unavailable (some policies): the local copy is used instead.
    }
  }
  return null;
}

async function storeApiKey(key: string): Promise<void> {
  try {
    await browser.storage.sync.set({ [EXTPAY_KEY]: key });
  } catch {
    await browser.storage.local.set({ [EXTPAY_KEY]: key });
  }
}

async function isDevelopmentInstall(): Promise<boolean> {
  try {
    return (await browser.management.getSelf()).installType === 'development';
  } catch {
    return false;
  }
}

let creating: Promise<string> | null = null;

/** The key, created on ExtensionPay the first time it is needed (opening a page). */
export function ensureApiKey(): Promise<string> {
  creating ??= (async () => {
    const existing = await getApiKey();
    if (existing) return existing;
    const body = (await isDevelopmentInstall()) ? { development: true } : {};
    let response: Response;
    try {
      response = await fetch(`${extpayBase()}/api/new-key`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ExtPayError('ExtensionPay is unreachable');
    }
    if (!response.ok) throw new ExtPayError(`ExtensionPay refused a new key (${response.status})`);
    const key: unknown = await response.json().catch(() => null);
    if (typeof key !== 'string' || !key) throw new ExtPayError('ExtensionPay sent no key');
    await storeApiKey(key);
    return key;
  })().finally(() => {
    creating = null;
  });
  return creating;
}

/** The ExtensionPay user for this install, or null when there is no key yet (a Free user; nothing is called). */
export async function fetchUser(): Promise<ExtPayUser | null> {
  const key = await getApiKey();
  if (!key) return null;
  let response: Response;
  try {
    response = await fetch(`${extpayBase()}/api/v2/user?api_key=${encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ExtPayError('ExtensionPay is unreachable');
  }
  if (!response.ok) throw new ExtPayError(`ExtensionPay answered ${response.status}`);
  const user: unknown = await response.json().catch(() => null);
  if (!user || typeof user !== 'object' || typeof (user as ExtPayUser).paid !== 'boolean') {
    throw new ExtPayError('ExtensionPay sent an unexpected answer');
  }
  return user as ExtPayUser;
}

/**
 * An ExtensionPay page: checkout for a plan (or every plan), the 7-day trial sign-up, sign-in on
 * another computer, or managing a subscription.
 */
export function extpayPageUrl(
  page: ExtPayPage,
  key: string,
  plan: { tier?: Exclude<Tier, 'free'>; interval?: BillingInterval } = {},
): string {
  const base = extpayBase();
  const apiKey = encodeURIComponent(key);
  switch (page) {
    case 'payment':
      if (plan.tier) return `${base}/choose-plan/${PLAN_NICKNAMES[plan.tier][plan.interval ?? 'month']}?api_key=${apiKey}`;
      return `${base}/choose-plan?api_key=${apiKey}`;
    case 'manage':
      return `${base}/choose-plan?api_key=${apiKey}`;
    case 'trial':
      return `${base}/trial?api_key=${apiKey}&period=7%20days`;
    case 'login':
      return `${base}/reactivate?api_key=${apiKey}&back=choose-plan&v2`;
  }
}
