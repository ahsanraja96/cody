import { vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { PRO_CONFIG } from '@/lib/pro/config';
import { EXTPAY_KEY } from '@/lib/pro/extpay';
import { resetPlanRuntime } from '@/lib/pro/plan';
import type { ExtPayUser } from '@/lib/pro/tiers';
import type { AiRuns, AiTab } from '@/lib/pro/types';

/**
 * A fake `fetch` for Pro tests: ExtensionPay's web API (new keys, users) and the Tabfold server
 * (server/API.md: /sync with versions, /backups, /ai). Installed with `vi.stubGlobal`.
 */

export const EXTPAY_ID = 'tabfold-test';
export const API_URL = 'https://api.tabfold.test/functions/v1/tabfold';
const EXTPAY = `https://extensionpay.com/extension/${EXTPAY_ID}`;

export interface AiRequest {
  task: 'organise' | 'name' | 'context';
  tabs: AiTab[];
  name?: string;
}

type Answer = { status: number; body: unknown };

export class FakeServer {
  /** ExtensionPay users by key. A key without one is an unpaid user. */
  users = new Map<string, ExtPayUser>();
  keysCreated: Array<{ key: string; development: boolean }> = [];
  /** Every request, for asserting what was (and wasn't) called. */
  requests: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
  offline = false;
  /** ExtensionPay is down (500s). */
  extpayDown = false;

  /** The account's sync items and version. */
  items: Record<string, unknown> = {};
  version = 0;
  /** Runs once before the next POST /sync is applied (another computer writing first). */
  beforeNextPost: (() => Promise<unknown>) | null = null;
  backups = new Map<string, { items: Record<string, unknown>; tabCount: number; createdAt: number }>();

  aiRequests: AiRequest[] = [];
  runs: AiRuns = { used: 4, limit: 300, resetsAt: Date.UTC(2026, 10, 1) };
  /** How the AI answers; by default organise groups nothing, name and context answer politely. */
  ai: (request: AiRequest) => Answer = (request) => {
    if (request.task === 'organise') return { status: 200, body: { groups: [], runs: this.runs } };
    if (request.task === 'name') return { status: 200, body: { name: 'Checkout app' } };
    return { status: 200, body: { summary: 'Tabs about a checkout app.' } };
  };
  /** Keys the server treats as Pro (others get 402). */
  proKeys = new Set<string>();

  extpayCalls(kind: 'user' | 'new-key'): number {
    return this.requests.filter((r) => r.url.startsWith(EXTPAY) && r.url.includes(kind === 'user' ? '/api/v2/user' : '/api/new-key')).length;
  }

  apiCalls(path: string, method = 'GET'): number {
    return this.requests.filter((r) => r.method === method && new URL(r.url).pathname === new URL(API_URL).pathname + path).length;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
    this.requests.push({ method, url, auth: headers.get('Authorization'), body });
    if (this.offline) throw new TypeError('Failed to fetch');
    const answer = url.startsWith(EXTPAY) ? this.extpay(method, new URL(url), body) : await this.api(method, new URL(url), headers, body);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  private extpay(method: string, url: URL, body: { development?: boolean } | null): Answer {
    if (this.extpayDown) return { status: 500, body: { error: 'down' } };
    if (method === 'POST' && url.pathname.endsWith('/api/new-key')) {
      const key = `key-${this.keysCreated.length + 1}`;
      this.keysCreated.push({ key, development: body?.development === true });
      return { status: 200, body: key };
    }
    if (method === 'GET' && url.pathname.endsWith('/api/v2/user')) {
      const key = url.searchParams.get('api_key') ?? '';
      return { status: 200, body: this.users.get(key) ?? { paid: false, email: null, trialStartedAt: null } };
    }
    return { status: 404, body: { error: 'not found' } };
  }

  private async api(method: string, url: URL, headers: Headers, body: Record<string, unknown> | null): Promise<Answer> {
    const path = url.pathname.slice(new URL(API_URL).pathname.length);
    const key = (headers.get('Authorization') ?? '').replace(/^Bearer /, '');
    if (!key) return { status: 401, body: { error: 'not-signed-in', message: 'Sign in first.' } };
    if (!this.proKeys.has(key)) return { status: 402, body: { error: 'needs-pro', message: 'Needs Pro.' } };
    if (path === '/sync' && method === 'GET') return { status: 200, body: { items: this.items, version: this.version } };
    if (path === '/sync' && method === 'POST') {
      const hook = this.beforeNextPost;
      this.beforeNextPost = null;
      if (hook) await hook();
      const { set = {}, remove = [], baseVersion } = body as { set?: Record<string, unknown>; remove?: string[]; baseVersion: number };
      if (baseVersion !== this.version) return { status: 409, body: { error: 'conflict', version: this.version } };
      const next = { ...this.items, ...set };
      for (const k of remove) delete next[k];
      this.items = next;
      this.version += 1;
      return { status: 200, body: { version: this.version } };
    }
    if (path === '/backups' && method === 'GET') {
      const backups = [...this.backups.entries()]
        .map(([day, b]) => ({ day, tabCount: b.tabCount, createdAt: b.createdAt }))
        .sort((a, b) => (a.day < b.day ? 1 : -1));
      return { status: 200, body: { backups } };
    }
    if (path.startsWith('/backups/') && method === 'GET') {
      const day = path.slice('/backups/'.length);
      const backup = this.backups.get(day);
      return backup ? { status: 200, body: { day, items: backup.items } } : { status: 404, body: { error: 'server', message: 'No backup for that day.' } };
    }
    if (path === '/ai' && method === 'POST') {
      const request = body as unknown as AiRequest;
      this.aiRequests.push(request);
      return this.ai(request);
    }
    return { status: 404, body: { error: 'server' } };
  }
}

/** Pro on in this build, with a fake ExtensionPay and server. Call the returned function to undo. */
export function installPro(server = new FakeServer()): { server: FakeServer; restore: () => void } {
  const before = { ...PRO_CONFIG };
  PRO_CONFIG.extpayId = EXTPAY_ID;
  PRO_CONFIG.apiUrl = API_URL;
  vi.stubGlobal('fetch', server.fetch);
  resetPlanRuntime();
  return {
    server,
    restore: () => {
      Object.assign(PRO_CONFIG, before);
      vi.unstubAllGlobals();
      resetPlanRuntime();
    },
  };
}

/** This install already has an ExtensionPay key (as after opening any of its pages). */
export async function giveKey(key = 'key-1'): Promise<string> {
  await fakeBrowser.storage.sync.set({ [EXTPAY_KEY]: key });
  return key;
}

const DAY = 24 * 60 * 60 * 1000;

/** An ExtensionPay user: paid on a plan, or in the trial (started `trialDaysAgo` days ago). */
export function extpayUser(options: {
  nickname?: string;
  interval?: 'month' | 'year';
  status?: 'active' | 'past_due' | 'canceled';
  trialDaysAgo?: number;
  email?: string;
  now?: number;
}): ExtPayUser {
  const now = options.now ?? Date.now();
  const paid = options.nickname !== undefined;
  return {
    paid,
    email: options.email ?? 'ada@example.com',
    trialStartedAt: options.trialDaysAgo !== undefined ? new Date(now - options.trialDaysAgo * DAY).toISOString() : null,
    plan: paid ? { nickname: options.nickname, interval: options.interval ?? 'month', unitAmountCents: 500, currency: 'usd' } : null,
    subscriptionStatus: paid ? (options.status ?? 'active') : null,
  };
}
