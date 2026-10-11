import { AI_RUNS_PER_MONTH, hasPro, hasProAi, LOOKUP_KEYS, planFor, type PlanState, type Subscription } from '../_shared/plan.ts';
import { cleanTabs, type AiTab, type Model } from './ai.ts';
import type { Mailer } from './mail.ts';
import { hmacSha256Hex, safeEqual, type CheckoutInfo, type CheckoutInput, type Payments, type StripeEvent } from './stripe.ts';

/**
 * The Tabfold Pro server (server/API.md): device tokens, sign-in with an emailed code, the server
 * trial, Stripe Checkout and the billing portal, Stripe webhooks, plan checks, sync, daily
 * backups and the AI tasks. Only web-standard APIs, with the database, Stripe, the mailer and the
 * model injected, so the same code runs in the Edge Function (index.ts), in tests and in Node.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const LIMITS = {
  maxBodyBytes: 10 * 1024 * 1024,
  /** The account's synced items in total (keys plus JSON values). */
  maxSyncBytes: 8 * 1024 * 1024,
  maxKeyLength: 128,
  backupDays: 30,
  runsPerMonth: AI_RUNS_PER_MONTH,
  /** Smart names and Copy as context together, a month. */
  lightPerMonth: 1000,
  /** A sign-in code works this long… */
  codeMs: 10 * MINUTE_MS,
  /** …and for this many tries. */
  codeTries: 5,
  codesPerEmailPerHour: 5,
  codesPerTokenPerHour: 10,
  checkoutsPerTokenPerHour: 20,
  /** `GET /me` asks Stripe about checkouts this computer started this recently… */
  pendingCheckoutMs: DAY_MS,
  /** …at most this many. */
  pendingCheckoutsChecked: 3,
  /** Stripe's shortest trial is 48 hours; a few minutes more covers the time until it checks. */
  minStripeTrialMs: 48 * HOUR_MS + 5 * MINUTE_MS,
  maxWebhookBytes: 1024 * 1024,
} as const;

/** What `tabfold_sync_write` returns instead of a version. */
export const SYNC_CONFLICT = -1;
export const SYNC_TOO_LARGE = -2;
/** What `tabfold_take_run` returns when the month's limit is reached. */
export const RUN_LIMIT_REACHED = -1;

/** Device tokens and Chrome profile keys: 32 random bytes or more, base64url. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export interface AiRuns {
  used: number;
  limit: number;
  /** Start of next month (ms, UTC). */
  resetsAt: number;
}

export interface BackupInfo {
  /** YYYY-MM-DD (UTC). */
  day: string;
  tabCount: number;
  createdAt: number;
}

export interface Backup extends BackupInfo {
  items: Record<string, unknown>;
}

export type UsageKind = 'runs' | 'light';

export interface Account {
  id: string;
  /** Lower-cased. */
  email: string;
  stripeCustomerId: string | null;
  trialStartedAt: number | null;
  /** When the email was first proved with a code; null for an account a signed-out checkout made. */
  emailVerifiedAt: number | null;
  createdAt: number;
}

/** A computer's device token, or a Chrome profile key. */
export type DeviceKind = 'device' | 'profile';

export interface SigninCode {
  /** HMAC-SHA256 of `<email>:<code>`, hex. */
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

export interface PendingCheckout {
  sessionId: string;
  /** The device token that started it. */
  tokenHash: string;
  createdAt: number;
  /** Paid with this email, whose account is older than the checkout: that computer must sign in with a code. */
  signInEmail: string | null;
}

/** The database, as the SQL in server/supabase/migrations defines it. Token hashes are hex SHA-256. */
export interface Store {
  /** The account for this (lower-cased) email, created on first use (its email not yet proved). */
  accountByEmail(email: string): Promise<Account>;
  accountById(id: string): Promise<Account | null>;
  /** The account with this Stripe customer, or with a subscription of this customer. */
  accountByCustomer(customerId: string): Promise<Account | null>;
  /** Sets the account's Stripe customer, unless it has one. */
  setCustomer(account: string, customerId: string): Promise<void>;
  /** `tabfold_start_trial`: starts the trial now, only if it never started. True if it did. */
  startTrial(account: string): Promise<boolean>;
  /**
   * `tabfold_verify_email`: the email was just proved with a code. The first time, unlinks every
   * device token and profile key of the account (atomically with marking it). True if it was.
   */
  verifyEmail(account: string): Promise<boolean>;

  /** The account a token (or profile key) of this kind is linked to; notes that it was seen. */
  accountForToken(tokenHash: string, kind: DeviceKind): Promise<Account | null>;
  /** Links a token or profile key to an account, replacing any earlier link. */
  link(tokenHash: string, account: string, kind: DeviceKind): Promise<void>;
  /** Unlinks a device token (never a profile key). */
  unlink(tokenHash: string): Promise<void>;

  codeGet(email: string): Promise<SigninCode | null>;
  /** Stores a new code for the email, replacing the old one (tries start again). */
  codePut(email: string, codeHash: string, expiresAt: number): Promise<void>;
  /** `tabfold_code_attempt`: counts one try and returns the tries so far; null when there's no code. */
  codeAttempt(email: string): Promise<number | null>;
  codeDelete(email: string): Promise<void>;

  /** `tabfold_rate_take`: takes one from the key's allowance; 0 if allowed, else seconds until it resets. */
  rateTake(key: string, limit: number, windowSeconds: number): Promise<number>;

  /** Stores (or replaces) a subscription for the account. */
  subscriptionPut(account: string, subscription: Subscription): Promise<void>;
  subscriptionList(account: string): Promise<Subscription[]>;

  pendingPut(sessionId: string, tokenHash: string): Promise<void>;
  /** This token's checkouts started since then, newest first. */
  pendingList(tokenHash: string, since: number, limit: number): Promise<PendingCheckout[]>;
  pendingGet(sessionId: string): Promise<PendingCheckout | null>;
  pendingSignIn(sessionId: string, email: string): Promise<void>;
  pendingDelete(sessionId: string): Promise<void>;

  /** Records a webhook event id; false if it was already recorded. */
  stripeEventNew(id: string): Promise<boolean>;
  /** Forgets an event id, so Stripe's retry is processed. */
  stripeEventForget(id: string): Promise<void>;

  /** Every synced item; version 0 before the first write. */
  syncRead(account: string): Promise<{ items: Record<string, unknown>; version: number }>;
  /** `tabfold_sync_write`: the new version, SYNC_CONFLICT or SYNC_TOO_LARGE. Atomic. */
  syncWrite(
    account: string,
    baseVersion: number,
    set: Record<string, unknown>,
    remove: string[],
    maxBytes: number,
  ): Promise<number>;
  syncVersion(account: string): Promise<number>;
  backupExists(account: string, day: string): Promise<boolean>;
  /** Stores the day's backup, keeping one that is already there. */
  backupPut(account: string, backup: Backup): Promise<void>;
  /** Newest first. */
  backupList(account: string): Promise<BackupInfo[]>;
  backupGet(account: string, day: string): Promise<{ day: string; items: Record<string, unknown> } | null>;
  /** Deletes backups from before this day. */
  backupPrune(account: string, beforeDay: string): Promise<void>;
  aiUsage(account: string, month: string): Promise<{ runs: number; light: number }>;
  /** `tabfold_take_run`: adds one if under the limit and returns the new count, or RUN_LIMIT_REACHED. */
  takeRun(account: string, month: string, kind: UsageKind, limit: number): Promise<number>;
}

export interface Deps {
  store: Store;
  payments: Payments;
  mailer: Mailer;
  model: Model;
  now(): number;
  /** Random bytes for sign-in codes (default: crypto.getRandomValues). */
  random?(bytes: number): Uint8Array;
  config: {
    /** `chrome-extension://<id>` origins allowed to call; `*` allows any extension. */
    allowedOrigins: string[];
    /** This function's public address, e.g. `https://<ref>.supabase.co/functions/v1/tabfold`. */
    publicUrl: string;
    /** Stripe Tax at checkout. */
    automaticTax: boolean;
    /** Billing portal configuration id (`bpc_…`); Stripe's default when empty. */
    portalConfiguration?: string;
    /** The key for hashing sign-in codes. */
    codeSecret: string;
  };
  /** Server logs. Never given tokens, keys, codes or tab titles. */
  log?(message: string): void;
}

type ErrorCode =
  | 'not-signed-in'
  | 'needs-pro'
  | 'needs-pro-ai'
  | 'conflict'
  | 'already-subscribed'
  | 'runs-used-up'
  | 'rate-limited'
  | 'invalid-email'
  | 'wrong-code'
  | 'code-expired'
  | 'ai-failed'
  | 'send-failed'
  | 'server';

class HttpError extends Error {
  status: number;
  code: ErrorCode;
  extra: Record<string, unknown>;
  constructor(status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

interface Reply {
  status: number;
  body: unknown;
  /** A plain-text page instead of JSON. */
  text?: string;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const page = (text: string): Reply => ({ status: 200, body: null, text });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.config.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let reply: Reply;
  try {
    reply = await route(req, deps);
  } catch (error) {
    reply = errorReply(error, req, deps);
  }
  if (reply.text !== undefined) {
    return new Response(reply.text, {
      status: reply.status,
      headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

type Handler = (req: Request, deps: Deps) => Promise<Reply>;

const ROUTES: Record<string, { GET?: Handler; POST?: Handler }> = {
  '/me': { GET: me },
  '/signin/start': { POST: signinStart },
  '/signin/finish': { POST: signinFinish },
  '/signin/profile': { POST: signinProfile },
  '/trial': { POST: trial },
  '/profile': { POST: profile },
  '/signout': { POST: signout },
  '/checkout': { POST: checkout },
  '/billing': { POST: billing },
  '/checkout/done': { GET: async () => page('Thank you! You can close this tab and go back to Tabfold.') },
  '/checkout/cancel': {
    GET: async () => page('Checkout cancelled; nothing was charged. You can close this tab and go back to Tabfold.'),
  },
  '/billing/done': { GET: async () => page('You can close this tab and go back to Tabfold.') },
  '/stripe/webhook': { POST: stripeWebhook },
  '/sync': { GET: syncGet, POST: syncPost },
  '/backups': { GET: backupsList },
  '/ai': { POST: ai },
};

async function route(req: Request, deps: Deps): Promise<Reply> {
  const path = routePath(new URL(req.url).pathname);
  const backupDay = /^\/backups\/([^/]+)$/.exec(path)?.[1];
  const handlers = backupDay !== undefined ? { GET: (r: Request, d: Deps) => backupGet(r, d, backupDay) } : ROUTES[path];
  if (!handlers) throw new HttpError(404, 'server', 'There’s nothing here.');
  const run = req.method === 'GET' || req.method === 'POST' ? handlers[req.method] : undefined;
  if (!run) throw new HttpError(405, 'server', `Use ${Object.keys(handlers).join(' or ')} here.`);
  return run(req, deps);
}

/** The path after the function's name: Supabase passes `/tabfold/me` (or `/functions/v1/tabfold/me`). */
function routePath(pathname: string): string {
  const path = pathname.replace(/^.*?\/tabfold(?=\/|$)/, '').replace(/\/+$/, '');
  return path || '/';
}

function errorReply(error: unknown, req: Request, deps: Deps): Reply {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.code, message: error.message, ...error.extra } };
  }
  deps.log?.(`${req.method} ${routePath(new URL(req.url).pathname)} failed: ${describe(error)}`);
  if (isNamed(error, 'PaymentsError')) {
    return {
      status: 502,
      body: { error: 'server', message: 'Stripe couldn’t be reached just now. Try again in a minute.' },
    };
  }
  return {
    status: 500,
    body: { error: 'server', message: 'Something went wrong on the Tabfold server. Try again in a minute.' },
  };
}

const isNamed = (error: unknown, name: string) => error instanceof Error && error.name === name;

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'unknown error';
}

// ---- CORS ----

function corsHeaders(req: Request, allowedOrigins: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const origin = req.headers.get('origin');
  if (origin && originAllowed(origin, allowedOrigins)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function originAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (!origin.startsWith('chrome-extension://')) return false;
  const allowed = allowedOrigins.map((entry) => entry.trim().replace(/\/+$/, ''));
  return allowed.includes('*') || allowed.includes(origin);
}

// ---- Hashes, codes, emails ----

/** Hex SHA-256: tokens, profile keys and rate-limit keys are only ever stored like this. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Trimmed and lower-cased, or null if it isn't an email address. */
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || /\s/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return null;
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1 && !domain.endsWith('.') ? email : null;
}

const defaultRandom = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));

/** Six digits, uniform: 32-bit numbers at or above the last whole million are drawn again. */
export function newCode(random: (bytes: number) => Uint8Array = defaultRandom): string {
  const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
  for (;;) {
    const bytes = random(4);
    const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    if (value < limit) return String(value % 1_000_000).padStart(6, '0');
  }
}

async function codeHash(deps: Deps, email: string, code: string): Promise<string> {
  if (!deps.config.codeSecret) throw new Error('CODE_SECRET is not set');
  return hmacSha256Hex(deps.config.codeSecret, `${email}:${code}`);
}

// ---- Who is asking ----

const notSignedIn = () => new HttpError(401, 'not-signed-in', 'This computer isn’t signed in to Tabfold Pro.');

function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization')?.trim() ?? '');
  const token = match?.[1];
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

/** The hash of this request's device token; 401 when there's none or it's malformed. */
async function tokenHashOf(req: Request): Promise<string> {
  const token = bearerToken(req);
  if (!token) throw notSignedIn();
  return sha256Hex(token);
}

async function whoIs(req: Request, deps: Deps): Promise<{ tokenHash: string; account: Account | null }> {
  const tokenHash = await tokenHashOf(req);
  return { tokenHash, account: await deps.store.accountForToken(tokenHash, 'device') };
}

async function signedIn(req: Request, deps: Deps): Promise<{ tokenHash: string; account: Account }> {
  const { tokenHash, account } = await whoIs(req, deps);
  if (!account) throw notSignedIn();
  return { tokenHash, account };
}

async function planOf(deps: Deps, account: Account | null): Promise<PlanState> {
  const subscriptions = account ? await deps.store.subscriptionList(account.id) : [];
  return planFor({ account: account && { email: account.email, trialStartedAt: account.trialStartedAt }, subscriptions }, deps.now());
}

/** `{ plan, runs }`, as `GET /me` and the sign-in routes answer. */
async function planReply(deps: Deps, account: Account | null): Promise<{ plan: PlanState; runs: AiRuns | null }> {
  const plan = await planOf(deps, account);
  let runs: AiRuns | null = null;
  if (account && hasProAi(plan)) {
    const now = deps.now();
    runs = aiRuns((await deps.store.aiUsage(account.id, monthOf(now))).runs, now);
  }
  return { plan, runs };
}

/** Signs in for a Pro route and returns the account id. */
async function accountFor(req: Request, deps: Deps, need: 'pro' | 'pro-ai'): Promise<string> {
  const { account } = await signedIn(req, deps);
  const plan = await planOf(deps, account);
  if (need === 'pro-ai' && !hasProAi(plan)) throw new HttpError(402, 'needs-pro-ai', 'This needs Tabfold Pro AI.');
  if (need === 'pro' && !hasPro(plan)) throw new HttpError(402, 'needs-pro', 'This needs Tabfold Pro.');
  return account.id;
}

// ---- Request bodies ----

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const tooLarge = () => new HttpError(413, 'server', 'That request is too large.');
const badRequest = (message: string) => new HttpError(400, 'server', message);

async function readJson(req: Request, optional = false): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > LIMITS.maxBodyBytes) throw tooLarge();
  const text = await readText(req, LIMITS.maxBodyBytes);
  if (optional && !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('The request isn’t valid JSON.');
  }
}

async function readObject(req: Request, shape: string, optional = false): Promise<Record<string, unknown>> {
  const body = await readJson(req, optional);
  if (!isObject(body)) throw badRequest(`Send ${shape}.`);
  return body;
}

/** The body as text, stopping as soon as it passes `limit` bytes. */
async function readText(req: Request, limit: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// ---- Dates ----

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

function startOfNextMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) && dayOf(ms) === text;
}

// ---- GET /me ----

async function me(req: Request, deps: Deps): Promise<Reply> {
  const tokenHash = await tokenHashOf(req);
  const needsSignIn = await checkPendingCheckouts(deps, tokenHash);
  const account = await deps.store.accountForToken(tokenHash, 'device');
  const reply: Record<string, unknown> = await planReply(deps, account);
  if (!account && needsSignIn) reply.needsSignIn = { email: needsSignIn };
  return ok(reply);
}

/**
 * Asks Stripe about the checkouts this computer started lately, so a payment shows up before
 * Stripe's webhook does. Stripe trouble never fails `GET /me`. Returns the email to sign in with
 * when a checkout was paid with an email whose account this computer can't join without a code.
 */
async function checkPendingCheckouts(deps: Deps, tokenHash: string): Promise<string | null> {
  const since = deps.now() - LIMITS.pendingCheckoutMs;
  const pending = await deps.store.pendingList(tokenHash, since, LIMITS.pendingCheckoutsChecked);
  let signInEmail: string | null = null;
  for (const checkout of pending) {
    if (checkout.signInEmail) {
      signInEmail ??= checkout.signInEmail;
      continue;
    }
    try {
      const session = await deps.payments.getCheckout(checkout.sessionId);
      if (session.status === 'complete') signInEmail ??= await processCheckout(deps, session);
      else if (session.status === 'expired') await deps.store.pendingDelete(checkout.sessionId);
    } catch (error) {
      deps.log?.(`Checking a checkout failed: ${describe(error)}`);
    }
  }
  return signInEmail;
}

/**
 * A completed checkout, from the webhook or `GET /me`: the account (the signed-in one the server
 * named in the metadata, else the email typed on Stripe's page), its Stripe customer, the
 * subscription, and the computer that started it. Safe to run more than once. Returns the email
 * to sign in with when the computer couldn't be signed in.
 */
async function processCheckout(deps: Deps, session: CheckoutInfo): Promise<string | null> {
  if (session.status !== 'complete') return null;
  const { store } = deps;
  const pending = await store.pendingGet(session.id);
  let account: Account | null = null;
  let mayLink = false;
  if (session.metadata.account) {
    account = await store.accountById(session.metadata.account);
    mayLink = account !== null;
  }
  if (!account) {
    const email = cleanEmail(session.email);
    if (!email) {
      deps.log?.('A completed checkout has no usable email; skipped');
      return null;
    }
    account = await store.accountByEmail(email);
    // Stripe doesn't check the email typed on its page. So only an account this checkout created
    // signs in the computer that paid; an older account needs its emailed code first.
    mayLink = pending !== null && account.createdAt >= pending.createdAt;
  }
  if (session.customerId && !account.stripeCustomerId) await store.setCustomer(account.id, session.customerId);
  if (session.subscriptionId) await store.subscriptionPut(account.id, await deps.payments.getSubscription(session.subscriptionId));
  if (!pending || pending.signInEmail) return pending?.signInEmail ?? null;
  if (!mayLink) {
    await store.pendingSignIn(session.id, account.email);
    return account.email;
  }
  await store.link(pending.tokenHash, account.id, 'device');
  await store.pendingDelete(session.id);
  return null;
}

// ---- Sign-in ----

async function rateLimit(deps: Deps, key: string, limit: number, what: string): Promise<void> {
  const wait = await deps.store.rateTake(key, limit, HOUR_MS / 1000);
  if (wait <= 0) return;
  const minutes = Math.max(1, Math.ceil(wait / 60));
  throw new HttpError(
    429,
    'rate-limited',
    `That’s a lot of ${what}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { retryAfter: Math.ceil(wait) },
  );
}

async function signinStart(req: Request, deps: Deps): Promise<Reply> {
  const tokenHash = await tokenHashOf(req);
  const body = await readObject(req, '{ email, purpose }');
  const email = cleanEmail(body.email);
  if (!email) throw new HttpError(400, 'invalid-email', 'That doesn’t look like an email address.');
  const purpose = body.purpose;
  if (purpose !== 'signin' && purpose !== 'trial') throw badRequest('“purpose” must be signin or trial.');
  await rateLimit(deps, `token:${tokenHash}`, LIMITS.codesPerTokenPerHour, 'codes');
  await rateLimit(deps, `email:${await sha256Hex(email)}`, LIMITS.codesPerEmailPerHour, 'codes');
  const code = newCode(deps.random ? (bytes) => deps.random!(bytes) : undefined);
  await deps.store.codePut(email, await codeHash(deps, email, code), deps.now() + LIMITS.codeMs);
  try {
    await deps.mailer.sendCode(email, code, purpose);
  } catch (error) {
    if (!isNamed(error, 'MailError')) throw error;
    deps.log?.(`Sending a code failed: ${describe(error)}`);
    throw new HttpError(502, 'send-failed', 'Couldn’t send the code. Check your connection and try again.');
  }
  return ok({ sent: true });
}

const codeExpired = () =>
  new HttpError(400, 'code-expired', 'That code has expired or was tried too many times. Ask for a new one.');

/** Checks a code: each try counts first (atomically), so five tries are five, however they arrive. */
async function checkCode(deps: Deps, email: string, code: string): Promise<void> {
  const attempts = await deps.store.codeAttempt(email);
  if (attempts === null) throw codeExpired();
  const stored = await deps.store.codeGet(email);
  if (!stored || stored.expiresAt <= deps.now() || attempts > LIMITS.codeTries) throw codeExpired();
  if (/^\d{6}$/.test(code) && safeEqual(await codeHash(deps, email, code), stored.codeHash)) {
    await deps.store.codeDelete(email);
    return;
  }
  const triesLeft = LIMITS.codeTries - attempts;
  if (triesLeft <= 0) {
    await deps.store.codeDelete(email);
    throw codeExpired();
  }
  throw new HttpError(400, 'wrong-code', `That code doesn’t match. ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left.`, {
    triesLeft,
  });
}

interface TrialResult {
  account: Account;
  trialStarted: boolean;
  trialUsed: boolean;
}

/** Starts the 7-day Pro AI trial if this email never had one and has no live subscription. */
async function startTrial(deps: Deps, account: Account): Promise<TrialResult> {
  const plan = await planOf(deps, account);
  const hadTrial = account.trialStartedAt !== null;
  if (plan.status !== null || hadTrial) return { account, trialStarted: false, trialUsed: hadTrial };
  const started = await deps.store.startTrial(account.id);
  const fresh = (await deps.store.accountById(account.id)) ?? account;
  return { account: fresh, trialStarted: started, trialUsed: !started };
}

async function signinFinish(req: Request, deps: Deps): Promise<Reply> {
  const tokenHash = await tokenHashOf(req);
  const body = await readObject(req, '{ email, code, startTrial }');
  const email = cleanEmail(body.email);
  if (!email) throw new HttpError(400, 'invalid-email', 'That doesn’t look like an email address.');
  if (typeof body.code !== 'string') throw badRequest('“code” must be the 6-digit code.');
  await checkCode(deps, email, body.code.replace(/[\s-]/g, ''));
  let account = await deps.store.accountByEmail(email);
  // A signed-out checkout made this account with an email nobody had proved: now that it is,
  // the computers that payment linked go (the plan, synced tabs and backups stay).
  if (account.emailVerifiedAt === null) await deps.store.verifyEmail(account.id);
  await deps.store.link(tokenHash, account.id, 'device');
  let trialStarted = false;
  let trialUsed = account.trialStartedAt !== null;
  if (body.startTrial === true) ({ account, trialStarted, trialUsed } = await startTrial(deps, account));
  return ok({ ...(await planReply(deps, account)), trialStarted, trialUsed });
}

async function trial(req: Request, deps: Deps): Promise<Reply> {
  const { account } = await signedIn(req, deps);
  const result = await startTrial(deps, account);
  return ok({ ...(await planReply(deps, result.account)), trialStarted: result.trialStarted, trialUsed: result.trialUsed });
}

function readProfileKey(body: Record<string, unknown>): string {
  if (typeof body.profileKey !== 'string') throw badRequest('Send { profileKey }.');
  return body.profileKey;
}

async function signinProfile(req: Request, deps: Deps): Promise<Reply> {
  const tokenHash = await tokenHashOf(req);
  const key = readProfileKey(await readObject(req, '{ profileKey }'));
  if (!TOKEN_PATTERN.test(key)) throw notSignedIn();
  const account = await deps.store.accountForToken(await sha256Hex(key), 'profile');
  if (!account) throw notSignedIn();
  await deps.store.link(tokenHash, account.id, 'device');
  return ok(await planReply(deps, account));
}

async function profile(req: Request, deps: Deps): Promise<Reply> {
  const { tokenHash, account } = await signedIn(req, deps);
  const key = readProfileKey(await readObject(req, '{ profileKey }'));
  if (!TOKEN_PATTERN.test(key)) throw badRequest('“profileKey” must be 32 or more letters, digits, - or _.');
  const keyHash = await sha256Hex(key);
  if (keyHash === tokenHash) throw badRequest('The profile key must differ from the device token.');
  await deps.store.link(keyHash, account.id, 'profile');
  return ok({ ok: true });
}

async function signout(req: Request, deps: Deps): Promise<Reply> {
  await deps.store.unlink(await tokenHashOf(req));
  return ok({ ok: true });
}

// ---- Payments ----

function publicUrl(deps: Deps): string {
  if (!deps.config.publicUrl) throw new Error('PUBLIC_URL is not set');
  return deps.config.publicUrl.replace(/\/+$/, '');
}

async function checkout(req: Request, deps: Deps): Promise<Reply> {
  const { tokenHash, account } = await whoIs(req, deps);
  const body = await readObject(req, '{ tier, interval }');
  const { tier, interval } = body;
  if (tier !== 'pro' && tier !== 'pro-ai') throw badRequest('“tier” must be pro or pro-ai.');
  if (interval !== 'month' && interval !== 'year') throw badRequest('“interval” must be month or year.');
  const base = publicUrl(deps);
  const input: CheckoutInput = {
    lookupKey: LOOKUP_KEYS[tier][interval],
    successUrl: `${base}/checkout/done?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/checkout/cancel`,
    automaticTax: deps.config.automaticTax,
    metadata: {},
  };
  if (account) {
    const plan = await planOf(deps, account);
    if (plan.status !== null) {
      throw new HttpError(409, 'already-subscribed', 'You already have a plan. Change it in billing.');
    }
    input.metadata.account = account.id;
    input.clientReferenceId = account.id;
    if (account.stripeCustomerId) input.customer = account.stripeCustomerId;
    else input.customerEmail = account.email;
    // During the server trial, Pro AI bills from the day the trial ends (if Stripe allows a trial that short).
    if (tier === 'pro-ai' && plan.trial && plan.trial.endsAt - deps.now() >= LIMITS.minStripeTrialMs) {
      input.trialEnd = Math.floor(plan.trial.endsAt / 1000);
    }
  }
  await rateLimit(deps, `checkout:${tokenHash}`, LIMITS.checkoutsPerTokenPerHour, 'checkouts');
  const session = await deps.payments.createCheckout(input);
  await deps.store.pendingPut(session.id, tokenHash);
  return ok({ url: session.url, sessionId: session.id });
}

async function billing(req: Request, deps: Deps): Promise<Reply> {
  const { account } = await signedIn(req, deps);
  const body = await readObject(req, '{ flow }', true);
  const flow = body.flow ?? undefined;
  if (flow !== undefined && flow !== 'payment-method') throw badRequest('“flow” must be payment-method or left out.');
  if (!account.stripeCustomerId) throw new HttpError(402, 'needs-pro', 'There’s no Tabfold Pro plan on this account yet.');
  const { url } = await deps.payments.createPortal({
    customer: account.stripeCustomerId,
    returnUrl: `${publicUrl(deps)}/billing/done`,
    flow,
    configuration: deps.config.portalConfiguration || undefined,
  });
  return ok({ url });
}

async function stripeWebhook(req: Request, deps: Deps): Promise<Reply> {
  const raw = await readText(req, LIMITS.maxWebhookBytes);
  let event: StripeEvent;
  try {
    event = await deps.payments.verifyWebhook(raw, req.headers.get('stripe-signature'));
  } catch (error) {
    if (!isNamed(error, 'WebhookSignatureError')) throw error;
    throw badRequest('The Stripe signature doesn’t check out.');
  }
  if (!(await deps.store.stripeEventNew(event.id))) return ok({ received: true });
  try {
    await stripeEvent(deps, event.type, event.data.object);
  } catch (error) {
    // Forget it, so Stripe's retry is processed.
    await deps.store.stripeEventForget(event.id).catch(() => undefined);
    throw error;
  }
  return ok({ received: true });
}

async function stripeEvent(deps: Deps, type: string, object: Record<string, unknown>): Promise<void> {
  const id = typeof object.id === 'string' ? object.id : null;
  if (!id) return;
  if (type === 'checkout.session.completed') {
    await processCheckout(deps, await deps.payments.getCheckout(id));
  } else if (type.startsWith('customer.subscription.')) {
    // Read it again: events can arrive out of order, Stripe's answer now is the truth.
    const subscription = await deps.payments.getSubscription(id);
    const account = await deps.store.accountByCustomer(subscription.customerId);
    // No account yet: checkout.session.completed will store it.
    if (account) await deps.store.subscriptionPut(account.id, subscription);
  }
}

// ---- Sync ----

async function syncGet(req: Request, deps: Deps): Promise<Reply> {
  const account = await accountFor(req, deps, 'pro');
  const { items, version } = await deps.store.syncRead(account);
  return ok({ items, version });
}

interface SyncWrite {
  set: Record<string, unknown>;
  remove: string[];
  baseVersion: number;
}

const isSyncKey = (key: unknown): key is string =>
  typeof key === 'string' && key.startsWith('tf.') && key.length > 3 && key.length <= LIMITS.maxKeyLength;

function readSyncWrite(body: unknown): SyncWrite {
  if (!isObject(body)) throw badRequest('Send { set, remove, baseVersion }.');
  const set = body.set ?? {};
  const remove = body.remove ?? [];
  const { baseVersion } = body;
  if (!isObject(set) || !Object.keys(set).every(isSyncKey)) throw badRequest('Every key in “set” must start with “tf.”.');
  if (!Array.isArray(remove) || !remove.every(isSyncKey)) throw badRequest('Every key in “remove” must start with “tf.”.');
  if (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw badRequest('“baseVersion” must be the version last read.');
  }
  return { set, remove, baseVersion };
}

async function syncPost(req: Request, deps: Deps): Promise<Reply> {
  const account = await accountFor(req, deps, 'pro');
  const input = readSyncWrite(await readJson(req));
  const result = await deps.store.syncWrite(account, input.baseVersion, input.set, input.remove, LIMITS.maxSyncBytes);
  if (result === SYNC_CONFLICT) {
    const version = await deps.store.syncVersion(account);
    throw new HttpError(409, 'conflict', 'Your folded tabs changed on another computer. Read them again first.', { version });
  }
  if (result === SYNC_TOO_LARGE) {
    throw new HttpError(413, 'server', 'That’s more than your Tabfold account can keep (8 MB of folded tabs).');
  }
  if (result < 0) throw new Error(`Unexpected sync write result ${result}`);
  await backUpToday(deps, account);
  return ok({ version: result });
}

/** Folded tabs in a sync items map: the records in its `tf.c<n>` chunks. */
export function countTabs(items: Record<string, unknown>): number {
  let count = 0;
  for (const [key, value] of Object.entries(items)) {
    if (/^tf\.c\d+$/.test(key) && Array.isArray(value)) count += value.length;
  }
  return count;
}

/** The first successful write of the UTC day keeps a copy of everything; copies last 30 days. */
async function backUpToday(deps: Deps, account: string): Promise<void> {
  const now = deps.now();
  const day = dayOf(now);
  try {
    if (await deps.store.backupExists(account, day)) return;
    const { items } = await deps.store.syncRead(account);
    await deps.store.backupPut(account, { day, items, tabCount: countTabs(items), createdAt: now });
    await deps.store.backupPrune(account, oldestKeptDay(now));
  } catch (error) {
    // The write itself succeeded; the next write today tries the backup again.
    deps.log?.(`Backup failed: ${describe(error)}`);
  }
}

const oldestKeptDay = (now: number) => dayOf(now - LIMITS.backupDays * DAY_MS);

// ---- Backups ----

async function backupsList(req: Request, deps: Deps): Promise<Reply> {
  const account = await accountFor(req, deps, 'pro');
  await deps.store.backupPrune(account, oldestKeptDay(deps.now()));
  return ok({ backups: await deps.store.backupList(account) });
}

async function backupGet(req: Request, deps: Deps, day: string): Promise<Reply> {
  const account = await accountFor(req, deps, 'pro');
  const backup = isDay(day) ? await deps.store.backupGet(account, day) : null;
  if (!backup) throw new HttpError(404, 'server', 'There’s no backup for that day.');
  return ok({ day: backup.day, items: backup.items });
}

// ---- AI ----

function aiRuns(used: number, now: number): AiRuns {
  return { used, limit: LIMITS.runsPerMonth, resetsAt: startOfNextMonth(now) };
}

function usedUp(message: string, runsUsed: number, now: number): HttpError {
  const resets = new Date(startOfNextMonth(now));
  const when = `${resets.getUTCDate()} ${MONTHS[resets.getUTCMonth()]}`;
  return new HttpError(429, 'runs-used-up', `${message} They come back on ${when}.`, { runs: aiRuns(runsUsed, now) });
}

async function runModel<T>(deps: Deps, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    deps.log?.(`AI failed: ${describe(error)}`);
    throw new HttpError(502, 'ai-failed', 'The AI couldn’t do this just now. Try again in a minute; this run wasn’t counted.');
  }
}

async function ai(req: Request, deps: Deps): Promise<Reply> {
  const account = await accountFor(req, deps, 'pro-ai');
  const body = await readJson(req);
  if (!isObject(body)) throw badRequest('Send { task, tabs }.');
  const tabs = cleanTabs(body.tabs);
  if (!tabs) throw badRequest('“tabs” must be a list of { id, title, host }.');
  if (tabs.length === 0) throw badRequest('Send at least one tab.');
  switch (body.task) {
    case 'organise':
      return organise(deps, account, tabs);
    case 'name':
      return lightTask(deps, account, () => deps.model.name(tabs).then((name) => ({ name })));
    case 'context': {
      const { name } = body;
      if (typeof name !== 'string') throw badRequest('“name” must be the group’s name.');
      return lightTask(deps, account, () => deps.model.context(name, tabs).then((summary) => ({ summary })));
    }
    default:
      throw badRequest('“task” must be organise, name or context.');
  }
}

/** Organise counts one run, and only once the model has answered well. */
async function organise(deps: Deps, account: string, tabs: AiTab[]): Promise<Reply> {
  if (tabs.length < 2) throw badRequest('Organise needs at least two tabs.');
  const now = deps.now();
  const month = monthOf(now);
  const message = `You’ve used this month’s ${LIMITS.runsPerMonth} AI runs.`;
  const { runs } = await deps.store.aiUsage(account, month);
  if (runs >= LIMITS.runsPerMonth) throw usedUp(message, runs, now);
  const groups = await runModel(deps, () => deps.model.organise(tabs));
  const used = await deps.store.takeRun(account, month, 'runs', LIMITS.runsPerMonth);
  // Another computer took the last run while this one was thinking.
  if (used === RUN_LIMIT_REACHED) throw usedUp(message, LIMITS.runsPerMonth, now);
  return ok({ groups, runs: aiRuns(used, now) });
}

/** Smart names and Copy as context aren't runs, but share a monthly cap. */
async function lightTask(deps: Deps, account: string, run: () => Promise<object>): Promise<Reply> {
  const now = deps.now();
  const month = monthOf(now);
  const message = 'Smart names and Copy as context are paused for the rest of the month.';
  const usage = await deps.store.aiUsage(account, month);
  if (usage.light >= LIMITS.lightPerMonth) throw usedUp(message, usage.runs, now);
  const result = await runModel(deps, run);
  if ((await deps.store.takeRun(account, month, 'light', LIMITS.lightPerMonth)) === RUN_LIMIT_REACHED) {
    throw usedUp(message, usage.runs, now);
  }
  return ok(result);
}
