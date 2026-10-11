import { vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEVICE_TOKEN_KEY } from '@/lib/pro/account';
import { resetCheckoutRuntime } from '@/lib/pro/checkout';
import { PRO_CONFIG } from '@/lib/pro/config';
import { resetPlanRuntime } from '@/lib/pro/plan';
import { planState } from '@/lib/pro/state';
import { FREE_PLAN, TRIAL_DAYS, type AiRuns, type AiTab, type BillingInterval, type PlanState, type Tier } from '@/lib/pro/types';

/**
 * A fake `fetch` for Pro tests: the Tabfold server as server/API.md describes it. Accounts are
 * emails; device tokens link to them; sign-in codes, the server trial, the Chrome profile key,
 * Stripe checkout and billing sessions (as URLs only), and /sync with versions, /backups and /ai.
 * Installed with `vi.stubGlobal`.
 */

export const API_URL = 'https://api.tabfold.test/functions/v1/tabfold';
export const EMAIL = 'ada@example.com';
/** A device token in the right format (43 base64url characters). */
export const TOKEN = 'device-token-'.padEnd(43, 'a');
export const CODE = '481920';

const DAY = 24 * 60 * 60 * 1000;

export interface AiRequest {
  task: 'organise' | 'name' | 'context';
  tabs: AiTab[];
  name?: string;
}

/** A live (or past) Stripe subscription, as the server keeps it. */
export interface FakeSubscription {
  tier: Exclude<Tier, 'free'>;
  interval: BillingInterval;
  status: 'active' | 'past_due' | 'canceled';
  cancelAt?: number | null;
  renewsAt?: number | null;
}

export interface FakeAccount {
  email: string;
  subscription: FakeSubscription | null;
  trialStartedAt: number | null;
}

type Answer = { status: number; body: unknown };

export class FakeServer {
  accounts = new Map<string, FakeAccount>();
  /** Device token → account email. */
  tokens = new Map<string, string>();
  /** Chrome profile key → account email. */
  profileKeys = new Map<string, string>();
  /** Sign-in codes by email. */
  codes = new Map<string, { code: string; tries: number }>();
  sentCodes: Array<{ email: string; purpose: string }> = [];
  /** The code the next `signin/start` sends. */
  nextCode = CODE;
  /** Every request, for asserting what was (and wasn't) called. Bodies are as sent. */
  requests: Array<{ method: string; url: string; path: string; auth: string | null; body: unknown }> = [];
  offline = false;
  /** Answers to send instead of the real one, by "METHOD /path" (used once each). */
  overrides = new Map<string, Answer>();
  checkouts: Array<{ token: string; tier: string; interval: string; sessionId: string; url: string }> = [];
  /** Device token → email: a checkout from that token was paid with an email that already had an account (`needsSignIn`). */
  paidElsewhere = new Map<string, string>();
  billingSessions: Array<{ token: string; flow: string | null; url: string }> = [];

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

  /** An account (made if new), optionally paying for a plan. */
  account(email = EMAIL, subscription: FakeSubscription | null = null): FakeAccount {
    const existing = this.accounts.get(email);
    if (existing) {
      if (subscription) existing.subscription = subscription;
      return existing;
    }
    const created: FakeAccount = { email, subscription, trialStartedAt: null };
    this.accounts.set(email, created);
    return created;
  }

  link(token: string, email = EMAIL): void {
    this.account(email);
    this.tokens.set(token, email);
  }

  /** The plan rules (server/API.md, "The plan"). */
  planFor(email: string | undefined, now = Date.now()): PlanState {
    const account = email ? this.accounts.get(email) : undefined;
    if (!account) return { ...FREE_PLAN, checkedAt: now };
    const base = { ...FREE_PLAN, email: account.email, trialUsed: account.trialStartedAt !== null, checkedAt: now };
    const sub = account.subscription;
    if (sub && (sub.status === 'active' || sub.status === 'past_due')) {
      return {
        ...base,
        tier: sub.tier,
        interval: sub.interval,
        status: sub.status,
        cancelAt: sub.cancelAt ?? null,
        renewsAt: sub.cancelAt ? null : (sub.renewsAt ?? now + 30 * DAY),
      };
    }
    if (account.trialStartedAt !== null && account.trialStartedAt + TRIAL_DAYS * DAY > now) {
      return { ...base, tier: 'pro-ai', trial: { startedAt: account.trialStartedAt, endsAt: account.trialStartedAt + TRIAL_DAYS * DAY } };
    }
    return base;
  }

  apiCalls(path: string, method = 'GET'): number {
    return this.requests.filter((r) => r.method === method && r.path === path).length;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
    const path = new URL(url).pathname.slice(new URL(API_URL).pathname.length);
    this.requests.push({ method, url, path, auth: headers.get('Authorization'), body });
    if (this.offline) throw new TypeError('Failed to fetch');
    const override = this.overrides.get(`${method} ${path}`);
    if (override) this.overrides.delete(`${method} ${path}`);
    const answer = override ?? (await this.api(method, path, headers, body));
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  private planAnswer(email: string | undefined) {
    const plan = this.planFor(email);
    return { plan, runs: plan.tier === 'pro-ai' ? this.runs : null };
  }

  /** Starts the trial if this email never had one and doesn't pay (POST /signin/finish, POST /trial). */
  private trial(email: string, start: boolean) {
    const account = this.account(email);
    const live = account.subscription && account.subscription.status !== 'canceled';
    let trialStarted = false;
    const hadOne = account.trialStartedAt !== null;
    if (start && !hadOne && !live) {
      account.trialStartedAt = Date.now();
      trialStarted = true;
    }
    return { ...this.planAnswer(email), trialStarted, trialUsed: start && hadOne };
  }

  private async api(method: string, path: string, headers: Headers, body: Record<string, unknown> | null): Promise<Answer> {
    const token = (headers.get('Authorization') ?? '').replace(/^Bearer /, '');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return { status: 401, body: { error: 'not-signed-in', message: 'Sign in first.' } };
    const email = this.tokens.get(token);
    const route = `${method} ${path}`;

    // Account and payments
    if (route === 'GET /me') {
      const paidAs = email ? undefined : this.paidElsewhere.get(token);
      return { status: 200, body: { ...this.planAnswer(email), ...(paidAs ? { needsSignIn: { email: paidAs } } : {}) } };
    }
    if (route === 'POST /signin/start') {
      const address = String(body?.email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { status: 400, body: { error: 'invalid-email', message: 'That isn’t an email address.' } };
      this.codes.set(address, { code: this.nextCode, tries: 0 });
      this.sentCodes.push({ email: address, purpose: String(body?.purpose) });
      return { status: 200, body: { sent: true } };
    }
    if (route === 'POST /signin/finish') {
      const address = String(body?.email ?? '').trim().toLowerCase();
      const stored = this.codes.get(address);
      if (!stored) return { status: 400, body: { error: 'code-expired', message: 'That code has expired.' } };
      if (stored.code !== body?.code) {
        stored.tries += 1;
        if (stored.tries >= 5) {
          this.codes.delete(address);
          return { status: 400, body: { error: 'code-expired', message: 'That code was tried too many times.' } };
        }
        return { status: 400, body: { error: 'wrong-code', message: 'That code doesn’t match.', triesLeft: 5 - stored.tries } };
      }
      this.codes.delete(address);
      this.link(token, address);
      return { status: 200, body: this.trial(address, body?.startTrial === true) };
    }
    if (route === 'POST /signin/profile') {
      const owner = this.profileKeys.get(String(body?.profileKey));
      if (!owner) return { status: 401, body: { error: 'not-signed-in', message: 'Unknown profile key.' } };
      this.link(token, owner);
      return { status: 200, body: this.planAnswer(owner) };
    }
    if (route === 'POST /signout') {
      this.tokens.delete(token);
      return { status: 200, body: { ok: true } };
    }
    if (route === 'POST /checkout') {
      const live = email && this.accounts.get(email)?.subscription;
      if (live && live.status !== 'canceled') return { status: 409, body: { error: 'already-subscribed', message: 'Already paying.' } };
      const sessionId = `cs_test_${this.checkouts.length + 1}`;
      const url = `https://checkout.stripe.test/c/pay/${sessionId}`;
      this.checkouts.push({ token, tier: String(body?.tier), interval: String(body?.interval), sessionId, url });
      return { status: 200, body: { url, sessionId } };
    }

    // Signed in from here on
    if (!email) return { status: 401, body: { error: 'not-signed-in', message: 'Sign in first.' } };
    if (route === 'POST /trial') return { status: 200, body: this.trial(email, true) };
    if (route === 'POST /profile') {
      this.profileKeys.set(String(body?.profileKey), email);
      return { status: 200, body: { ok: true } };
    }
    if (route === 'POST /billing') {
      if (!this.accounts.get(email)?.subscription) return { status: 402, body: { error: 'needs-pro', message: 'Never paid.' } };
      const url = `https://billing.stripe.test/p/session/${this.billingSessions.length + 1}`;
      this.billingSessions.push({ token, flow: typeof body?.flow === 'string' ? body.flow : null, url });
      return { status: 200, body: { url } };
    }

    // Pro and Pro AI
    const plan = this.planFor(email);
    if (plan.tier === 'free') return { status: 402, body: { error: 'needs-pro', message: 'Needs Pro.' } };
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
      if (plan.tier !== 'pro-ai') return { status: 402, body: { error: 'needs-pro-ai', message: 'Needs Pro AI.' } };
      const request = body as unknown as AiRequest;
      this.aiRequests.push(request);
      return this.ai(request);
    }
    return { status: 404, body: { error: 'server' } };
  }
}

/** Pro on in this build, with a fake server. Call the returned function to undo. */
export function installPro(server = new FakeServer()): { server: FakeServer; restore: () => void } {
  const before = { ...PRO_CONFIG };
  PRO_CONFIG.apiUrl = API_URL;
  vi.stubGlobal('fetch', server.fetch);
  resetPlanRuntime();
  resetCheckoutRuntime();
  return {
    server,
    restore: () => {
      Object.assign(PRO_CONFIG, before);
      vi.unstubAllGlobals();
      resetPlanRuntime();
      resetCheckoutRuntime();
    },
  };
}

/** This computer already has a device token (as after signing in, paying or starting a trial). */
export async function giveToken(token = TOKEN): Promise<string> {
  await fakeBrowser.storage.local.set({ [DEVICE_TOKEN_KEY]: token });
  return token;
}

/** A full plan for tests: Free unless a tier is given (a paid one, active, unless said otherwise). */
export function planOf(patch: Partial<PlanState> = {}): PlanState {
  const paid = patch.tier && patch.tier !== 'free' && !patch.trial;
  return {
    ...FREE_PLAN,
    email: EMAIL,
    ...(paid ? { interval: 'month' as const, status: 'active' as const, renewsAt: Date.now() + 30 * DAY } : {}),
    checkedAt: Date.now(),
    ...patch,
  };
}

/** Signed in on this computer to an account paying for `tier` (or Free with null), the server agreeing; the plan is stored. */
export async function signedIn(
  server: FakeServer,
  tier: Exclude<Tier, 'free'> | null,
  options: { interval?: BillingInterval; email?: string; token?: string } = {},
): Promise<PlanState> {
  const email = options.email ?? EMAIL;
  server.account(email, tier ? { tier, interval: options.interval ?? 'month', status: 'active' } : null);
  server.link(await giveToken(options.token), email);
  const plan = server.planFor(email);
  await planState.set(plan);
  return plan;
}
