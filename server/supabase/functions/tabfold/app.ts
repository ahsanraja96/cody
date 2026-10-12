import {
  AI_RUNS_PER_MONTH,
  hasPro,
  hasProAi,
  isLive,
  LIFETIME_LOOKUP_KEY,
  LOOKUP_KEYS,
  planFor,
  TEAMS_LOOKUP_KEYS,
  type PlanState,
  type Purchase,
  type Subscription,
  type TeamInput,
  type TeamRole,
} from '../_shared/plan.ts';
import { cleanFolders, cleanTabs, type AiTab, type Model } from './ai.ts';
import { DEFAULT_SITE_URL, type Mailer } from './mail.ts';
import { hmacSha256Hex, safeEqual, type CheckoutInfo, type CheckoutInput, type Payments, type StripeEvent } from './stripe.ts';

/**
 * The Tabfold Pro server (server/API.md): device tokens, sign-in with an emailed code, the server
 * trial, Stripe Checkout (subscriptions, Pro for life, Teams) and the billing portal, Stripe
 * webhooks, plan checks, sync, daily backups, teams and their shared folders, shared folder links
 * (1.0: with a folder's note), the AI tasks, and deleting an account (1.0). Only web-standard APIs,
 * with the database, Stripe, the mailer and the model injected, so the same code runs in the Edge
 * Function (index.ts), in tests and in Node.
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
  /** Teams: seats bought at checkout (default, most)… */
  teamSeatsDefault: 3,
  teamSeatsMax: 100,
  /** …people in a team, members and invitations together… */
  teamMaxPeople: 100,
  teamName: 60,
  /** …invitations: per request, and emailed per team a day. */
  invitesPerRequest: 20,
  invitesPerTeamPerDay: 100,
  /** A team's shared folders stay readable this long after its plan ends. */
  teamReadableMs: 30 * DAY_MS,
  /** Shared folders: tabs, title and address lengths, folder name… */
  shareMaxTabs: 1000,
  shareTitle: 200,
  shareUrl: 2000,
  shareName: 60,
  /** A folder's note (1.0): one line, at most this many characters. */
  shareNote: 140,
  /** …shares an account can have, and public reads a minute per address. */
  sharesPerAccount: 500,
  shareReadsPerMinute: 60,
} as const;

/** What `tabfold_sync_write` returns instead of a version. */
export const SYNC_CONFLICT = -1;
export const SYNC_TOO_LARGE = -2;
/** What `tabfold_take_run` returns when the month's limit is reached. */
export const RUN_LIMIT_REACHED = -1;

/** Device tokens and Chrome profile keys: 32 random bytes or more, base64url. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** A shared folder's id: 10 letters and digits. */
export const SHARE_ID_PATTERN = /^[A-Za-z0-9]{10}$/;

/** Chrome's tab group colours: a shared folder's colour is one of these. */
export const SHARE_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;

/** A Teams plan's name when none is given. */
export const DEFAULT_TEAM_NAME = 'My team';

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

/** A Teams plan's team. */
export interface TeamRecord {
  id: string;
  name: string;
  /** The account that pays for it. */
  ownerId: string;
  /** The team's Stripe subscription (kept on the owner's account, like their own). */
  subscriptionId: string | null;
  createdAt: number;
}

/** The team an account is in, and as what. */
export interface TeamMembership {
  team: TeamRecord;
  role: TeamRole;
  joinedAt: number;
}

export interface TeamMember {
  /** The member's account id. */
  id: string;
  email: string;
  role: TeamRole;
  joinedAt: number;
}

export interface TeamInvite {
  email: string;
  invitedAt: number;
}

/** A shared folder's contents, as its owner sends them. */
export interface ShareContent {
  name: string;
  /** One of SHARE_COLORS. */
  color: string;
  tabs: { title: string; url: string }[];
  /** "Keep it up to date": the extension sends changes. */
  live: boolean;
  /** The folder's note (1.0): one line, at most 140 characters; '' or left out when none. */
  note?: string;
}

export interface ShareRecord extends ShareContent {
  id: string;
  accountId: string;
  views: number;
  createdAt: number;
  updatedAt: number;
}

/** What anyone with the link sees. */
export interface PublicShare {
  name: string;
  color: string;
  tabs: { title: string; url: string }[];
  updatedAt: number;
  /** The folder's note; '' or left out when none (the route always answers with one). */
  note?: string;
}

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
  /**
   * `tabfold_start_trial`, atomically: starts the trial now, only if it never started for this
   * account and no account with this email had one (`trialHash`, the email's trial fingerprint, is
   * not in `trial_used`); then records the fingerprint. True if it started.
   */
  startTrial(account: string, trialHash: string): Promise<boolean>;
  /** Whether an account with this email (by its trial fingerprint) ever had a trial, deleted accounts included. */
  trialUsed(trialHash: string): Promise<boolean>;
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
  /** One subscription, whichever account it's on. */
  subscriptionGet(id: string): Promise<Subscription | null>;
  /** Records a one-time purchase (Pro for life), keeping one already recorded with its id. */
  purchasePut(account: string, purchase: Purchase): Promise<void>;
  purchaseList(account: string): Promise<Purchase[]>;

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
  /** Deletes every account's backups from before this day (1.0: also those of accounts that stopped syncing). */
  backupPruneAll(beforeDay: string): Promise<void>;
  aiUsage(account: string, month: string): Promise<{ runs: number; light: number }>;
  /** `tabfold_take_run`: adds one if under the limit and returns the new count, or RUN_LIMIT_REACHED. */
  takeRun(account: string, month: string, kind: UsageKind, limit: number): Promise<number>;

  /**
   * `tabfold_team_create`, atomically: the team this subscription pays for; else the account's own
   * team, which takes the subscription and the name (its plan had ended); else a new team owned
   * by the account (which leaves a team it was a member of). Returns the team's id.
   */
  teamCreate(owner: string, name: string, subscriptionId: string): Promise<string>;
  /** The team an account is in (an account is in one team at most). */
  teamOf(account: string): Promise<TeamMembership | null>;
  teamGet(team: string): Promise<TeamRecord | null>;
  teamRename(team: string, name: string): Promise<void>;
  /** The owner first, then the others in the order they joined. */
  teamMembers(team: string): Promise<TeamMember[]>;
  /** Oldest first. */
  teamInvites(team: string): Promise<TeamInvite[]>;
  /** Invites an email; false if it was already invited. */
  teamInvitePut(team: string, email: string): Promise<boolean>;
  /** Cancels an invitation; false if there was none. */
  teamInviteDelete(team: string, email: string): Promise<boolean>;
  /** The teams that invited this email, oldest invitation first. */
  teamInvitesFor(email: string): Promise<string[]>;
  /**
   * `tabfold_team_join`, atomically: if the email is invited to the team and the account isn't in a
   * team, the account joins as a member and the invitation goes. True if it joined.
   */
  teamJoin(team: string, account: string, email: string): Promise<boolean>;
  /** Removes a member (never the owner); false if the account wasn't one. */
  teamLeave(team: string, account: string): Promise<boolean>;
  /** The team's shared folders, like syncRead. */
  teamSyncRead(team: string): Promise<{ items: Record<string, unknown>; version: number }>;
  /** `tabfold_team_sync_write`: like syncWrite, for the team. */
  teamSyncWrite(team: string, baseVersion: number, set: Record<string, unknown>, remove: string[], maxBytes: number): Promise<number>;
  teamSyncVersion(team: string): Promise<number>;

  /** Adds a shared folder for the account; false if the id is taken. */
  shareCreate(id: string, account: string, content: ShareContent): Promise<boolean>;
  shareGet(id: string): Promise<ShareRecord | null>;
  /** Replaces the contents of the account's shared folder; the share as it is now, or null if it has none with this id. */
  shareUpdate(id: string, account: string, content: ShareContent): Promise<ShareRecord | null>;
  /** Deletes the account's shared folder; false if it had none with this id. */
  shareDelete(id: string, account: string): Promise<boolean>;
  shareCount(account: string): Promise<number>;
  /** `tabfold_share_view`: counts a view and returns what the page shows, or null if there's no such share. */
  shareView(id: string): Promise<PublicShare | null>;

  /**
   * `tabfold_account_delete` (1.0), atomically: the account and everything kept for it (devices and
   * profile keys, synced copy, backups, AI usage, subscriptions and purchases as stored here, shares,
   * its team membership, a team it owns with that team's people, invitations and folders), its
   * sign-in code and the checkouts its computers started. If the account had a trial, its email's
   * trial fingerprint (`trialHash`) stays in `trial_used`, so the trial can't start again. False if
   * there was no such account.
   */
  accountDelete(account: string, trialHash: string): Promise<boolean>;
  /**
   * `tabfold_team_sync_prune`: deletes the shared folders (team sync items and state) of every team
   * whose subscription isn't live and ended before this time (ms). The number of teams emptied.
   */
  teamSyncPruneEnded(endedBefore: number): Promise<number>;
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
    /** Where shared folders' pages live (the `web/` site, `SHARE_BASE_URL`). Default https://tabfold.app. */
    shareBaseUrl?: string;
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
  /** 1.0: `POST /account/delete` without the account's email as confirmation. */
  | 'invalid'
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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
/** A route's handler; `param` is the part of the path a route with one takes (an id, a day, an email). */
type Handler = (req: Request, deps: Deps, param: string) => Promise<Reply>;
type Handlers = Partial<Record<Method, Handler>>;

const ROUTES: Record<string, Handlers> = {
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
  '/team': { GET: teamGet, PATCH: teamPatch },
  '/team/invites': { POST: teamInvite },
  '/team/leave': { POST: teamLeave },
  '/team/sync': { GET: teamSyncGet, POST: teamSyncPost },
  '/shares': { POST: shareCreate },
  '/account/delete': { POST: accountDelete },
};

/** Routes with a part that varies, which the handler gets as `param` (URL-decoded). */
const PARAM_ROUTES: [RegExp, Handlers][] = [
  [/^\/backups\/([^/]+)$/, { GET: backupGet }],
  [/^\/team\/invites\/([^/]+)$/, { DELETE: teamUninvite }],
  [/^\/team\/members\/([^/]+)$/, { DELETE: teamRemove }],
  [/^\/shares\/([^/]+)$/, { GET: shareInfo, PUT: shareReplace, DELETE: shareStop }],
  [/^\/public\/shares\/([^/]+)$/, { GET: publicShare }],
];

const nothingHere = () => new HttpError(404, 'server', 'There’s nothing here.');

async function route(req: Request, deps: Deps): Promise<Reply> {
  const path = routePath(new URL(req.url).pathname);
  let handlers = ROUTES[path];
  let param = '';
  if (!handlers) {
    for (const [pattern, candidate] of PARAM_ROUTES) {
      const match = pattern.exec(path);
      if (!match) continue;
      try {
        param = decodeURIComponent(match[1]!);
      } catch {
        throw nothingHere();
      }
      handlers = candidate;
      break;
    }
  }
  if (!handlers) throw nothingHere();
  const run = METHODS.includes(req.method) ? handlers[req.method as Method] : undefined;
  if (!run) throw new HttpError(405, 'server', `Use ${Object.keys(handlers).join(' or ')} here.`);
  return run(req, deps, param);
}

/** The path after the function's name: Supabase passes `/tabfold/me` (or `/functions/v1/tabfold/me`). */
function routePath(pathname: string): string {
  const path = pathname.replace(/^.*?\/tabfold(?=\/|$)/, '').replace(/\/+$/, '');
  return path || '/';
}

/** The path for the log: the varying part (an email, a share id) left out. */
function loggedPath(pathname: string): string {
  const path = routePath(pathname);
  for (const [pattern] of PARAM_ROUTES) {
    const match = pattern.exec(path);
    if (match) return `${path.slice(0, path.length - match[1]!.length)}…`;
  }
  return path;
}

function errorReply(error: unknown, req: Request, deps: Deps): Reply {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.code, message: error.message, ...error.extra } };
  }
  deps.log?.(`${req.method} ${loggedPath(new URL(req.url).pathname)} failed: ${describe(error)}`);
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
  // A shared folder's public page is on another site (`web/`), and anyone may read it.
  if (routePath(new URL(req.url).pathname).startsWith('/public/')) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
    };
  }
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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

/**
 * Hex SHA-256: device tokens and profile keys (32 random bytes or more, so they can't be guessed
 * back) are only ever stored like this. Emails and IP addresses never are: they get a keyed HMAC
 * (rateKey, trialFingerprint).
 */
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

/**
 * An email's trial fingerprint: HMAC-SHA256 of `trial:<email>` (trimmed, lower-cased), keyed with the
 * code secret, in hex. One-way: the address can't be read back from it, and without the secret it
 * can't even be checked against a guess. Kept in `trial_used` once the email has had a trial, also
 * after its account is deleted, so the 7-day trial can't be started again with the same email.
 * Changing the secret (CODE_SECRET, or the service role key while CODE_SECRET isn't set) makes the
 * kept fingerprints unrecognisable: set CODE_SECRET once and keep it.
 */
export async function trialFingerprint(secret: string, email: string): Promise<string> {
  if (!secret) throw new Error('CODE_SECRET is not set');
  return hmacSha256Hex(secret, `trial:${email.trim().toLowerCase()}`);
}

const fingerprintOf = (deps: Deps, account: Account) => trialFingerprint(deps.config.codeSecret, account.email);

/** What a rate limit counts by: an email, a computer (its token's hash), or a visitor's IP address. */
export type RateKind = 'email' | 'token' | 'checkout' | 'share-read';

/**
 * A rate limit's key: `<kind>:` and an HMAC-SHA256 of the value (an email, a device token's hash,
 * an IP address), keyed with the code secret like the trial fingerprint. One-way: without the
 * secret, a stored key can't be turned back into the email or address, even by trying every IPv4
 * address. The rows last at most a day (`tabfold_rate_take`).
 */
export async function rateKey(secret: string, kind: RateKind, value: string): Promise<string> {
  if (!secret) throw new Error('CODE_SECRET is not set');
  return `${kind}:${await hmacSha256Hex(secret, `rate:${kind}:${value}`)}`;
}

/** This account, or an earlier (deleted) account with the same email, had a trial. */
async function hadTrial(deps: Deps, account: Account): Promise<boolean> {
  if (account.trialStartedAt !== null) return true;
  return deps.store.trialUsed(await fingerprintOf(deps, account));
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

/** The team's subscription (kept on its owner's account). */
async function teamSubscription(deps: Deps, team: TeamRecord): Promise<Subscription | null> {
  return team.subscriptionId ? deps.store.subscriptionGet(team.subscriptionId) : null;
}

/** The account's team, as the plan rules take it. */
async function teamInputOf(deps: Deps, account: string): Promise<TeamInput | null> {
  const membership = await deps.store.teamOf(account);
  if (!membership) return null;
  const { team, role } = membership;
  const subscription = await teamSubscription(deps, team);
  return { id: team.id, name: team.name, role, seats: subscription?.quantity ?? 1, subscription };
}

async function planOf(deps: Deps, account: Account | null): Promise<PlanState> {
  if (!account) return planFor({ account: null, subscriptions: [] }, deps.now());
  const [subscriptions, purchases, team] = await Promise.all([
    deps.store.subscriptionList(account.id),
    deps.store.purchaseList(account.id),
    teamInputOf(deps, account.id),
  ]);
  const plan = planFor(
    { account: { email: account.email, trialStartedAt: account.trialStartedAt }, subscriptions, purchases, team },
    deps.now(),
  );
  // Where a trial could be offered, say whether this email already had one (on a deleted account).
  if (!plan.trialUsed && plan.status === null && !plan.team && deps.config.codeSecret) {
    if (await deps.store.trialUsed(await fingerprintOf(deps, account))) return { ...plan, trialUsed: true };
  }
  return plan;
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

const cutChars = (text: string, max: number) => Array.from(text).slice(0, max).join('');

/** Text for a name: one line, no control characters, whitespace tidied, at most `max` characters. */
export function cleanLine(value: string, max: number): string {
  return cutChars(oneLine(value), max).trim();
}

const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();

interface GraphemeSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}

/**
 * At most `max` characters (code points), never ending partway through one: a letter with its
 * accents, a flag or an emoji sequence is kept whole or left out.
 */
export function cutWhole(text: string, max: number): string {
  if (Array.from(text).length <= max) return text;
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter })
    .Segmenter;
  if (!Segmenter) return cutChars(text, max);
  let out = '';
  let count = 0;
  for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const size = Array.from(segment).length;
    if (count + size > max) break;
    out += segment;
    count += size;
  }
  return out;
}

/** A folder's note (1.0): one line, whitespace squeezed, at most 140 characters, never cut partway through one. */
export function cleanNote(value: unknown): string {
  return typeof value === 'string' ? cutWhole(oneLine(value), LIMITS.shareNote).trim() : '';
}

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

/** Paid, or nothing to pay (a 100% promotion code). A bank debit can complete before it is paid. */
const isPaid = (session: CheckoutInfo) => session.paymentStatus === 'paid' || session.paymentStatus === 'no_payment_required';

/**
 * A completed checkout, from the webhook or `GET /me`: the account (the signed-in one the server
 * named in the metadata, else the email typed on Stripe's page), its Stripe customer, what it
 * bought (a subscription, Pro for life, or a Teams plan and its team), and the computer that
 * started it. Safe to run more than once. Returns the email to sign in with when the computer
 * couldn't be signed in.
 */
async function processCheckout(deps: Deps, session: CheckoutInfo): Promise<string | null> {
  if (session.status !== 'complete') return null;
  // A one-time payment still on its way: `checkout.session.async_payment_succeeded` comes later.
  if (session.mode === 'payment' && !isPaid(session)) return null;
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
  if (session.subscriptionId) {
    const subscription = await deps.payments.getSubscription(session.subscriptionId);
    await store.subscriptionPut(account.id, subscription);
    if (session.metadata.plan === 'teams') await makeTeam(deps, account, session, subscription);
  }
  if (session.mode === 'payment' && session.metadata.plan === LIFETIME_LOOKUP_KEY) {
    await store.purchasePut(account.id, {
      id: session.id,
      lookupKey: LIFETIME_LOOKUP_KEY,
      customerId: session.customerId,
      paymentIntentId: session.paymentIntentId,
      createdAt: deps.now(),
    });
  }
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
  await rateLimit(deps, await rateKey(deps.config.codeSecret, 'token', tokenHash), LIMITS.codesPerTokenPerHour, 'codes');
  await rateLimit(deps, await rateKey(deps.config.codeSecret, 'email', email), LIMITS.codesPerEmailPerHour, 'codes');
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

/**
 * Starts the 7-day Pro AI trial if this email never had one (on this account or a deleted one with
 * the same email) and has no live subscription.
 */
async function startTrial(deps: Deps, account: Account): Promise<TrialResult> {
  const plan = await planOf(deps, account);
  const used = await hadTrial(deps, account);
  // A team already gives Pro AI: the trial keeps for later.
  if (plan.status !== null || plan.team || used) return { account, trialStarted: false, trialUsed: used };
  const started = await deps.store.startTrial(account.id, await fingerprintOf(deps, account));
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
  // The code proved the email: an invitation to a team sent to it is accepted now.
  await joinInvitedTeam(deps, account);
  let trialStarted = false;
  let trialUsed = await hadTrial(deps, account);
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

/** Seats for a Teams checkout: 1 to 100, 3 when not given. */
function readSeats(value: unknown): number {
  if (value === undefined || value === null) return LIMITS.teamSeatsDefault;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > LIMITS.teamSeatsMax) {
    throw badRequest(`“seats” must be a whole number from 1 to ${LIMITS.teamSeatsMax}.`);
  }
  return value;
}

/** A team's name: one line, at most 60 characters; "My team" when not given (at checkout). */
function readTeamName(value: unknown, required: boolean): string {
  if ((value === undefined || value === null) && !required) return DEFAULT_TEAM_NAME;
  if (typeof value !== 'string') throw badRequest('Give the team a name.');
  const name = cleanLine(value, LIMITS.teamName);
  if (name) return name;
  if (required) throw badRequest('Give the team a name.');
  return DEFAULT_TEAM_NAME;
}

const CHECKOUT_TIERS = ['pro', 'pro-ai', 'pro-lifetime', 'teams'] as const;
type CheckoutTier = (typeof CHECKOUT_TIERS)[number];

async function checkout(req: Request, deps: Deps): Promise<Reply> {
  const { tokenHash, account } = await whoIs(req, deps);
  const body = await readObject(req, '{ tier, interval }');
  const { interval } = body;
  const tier = body.tier as CheckoutTier;
  if (!CHECKOUT_TIERS.includes(tier)) throw badRequest('“tier” must be pro, pro-ai, pro-lifetime or teams.');
  // Pro for life is one payment: no period.
  if (tier !== 'pro-lifetime' && interval !== 'month' && interval !== 'year') {
    throw badRequest('“interval” must be month or year.');
  }
  const period = interval as 'month' | 'year';
  const lookupKey =
    tier === 'pro-lifetime' ? LIFETIME_LOOKUP_KEY : tier === 'teams' ? TEAMS_LOOKUP_KEYS[period] : LOOKUP_KEYS[tier][period];
  const base = publicUrl(deps);
  const input: CheckoutInput = {
    lookupKey,
    successUrl: `${base}/checkout/done?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/checkout/cancel`,
    automaticTax: deps.config.automaticTax,
    metadata: {},
  };
  // What's bought, for when the completed checkout is processed (only the server sets metadata).
  if (tier === 'pro-lifetime') {
    input.mode = 'payment';
    input.metadata.plan = LIFETIME_LOOKUP_KEY;
  } else if (tier === 'teams') {
    input.quantity = readSeats(body.seats);
    input.metadata.plan = 'teams';
    input.metadata.teamName = readTeamName(body.teamName, false);
  }
  if (account) {
    const plan = await planOf(deps, account);
    if (tier === 'pro-lifetime') {
      if (plan.lifetime) throw new HttpError(409, 'already-subscribed', 'You already have Tabfold Pro for life.');
    } else if (tier === 'teams') {
      // One team per account; a team whose plan ended takes the new one.
      if (plan.team?.role === 'owner') throw new HttpError(409, 'already-subscribed', 'You already have a Teams plan. Change it in billing.');
      if (plan.team) throw new HttpError(409, 'already-subscribed', `You’re already in ${plan.team.name}. Leave it first to start your own team.`);
    } else if (plan.status !== null) {
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
  await rateLimit(deps, await rateKey(deps.config.codeSecret, 'checkout', tokenHash), LIMITS.checkoutsPerTokenPerHour, 'checkouts');
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
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
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
  await dailyPrune(deps);
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

/**
 * Once a day, whichever sync write gets there first: backups older than 30 days go for every
 * account, including accounts whose plan ended and that no longer write (theirs would otherwise
 * stay); and the shared folders of teams whose plan ended more than 30 days ago go too (they stay
 * readable for those 30 days, so people can keep a copy). Never fails the write.
 */
async function dailyPrune(deps: Deps): Promise<void> {
  try {
    if ((await deps.store.rateTake('prune:daily', 1, DAY_MS / 1000)) > 0) return;
  } catch (error) {
    deps.log?.(`Pruning old backups failed: ${describe(error)}`);
    return;
  }
  const now = deps.now();
  try {
    await deps.store.backupPruneAll(oldestKeptDay(now));
  } catch (error) {
    deps.log?.(`Pruning old backups failed: ${describe(error)}`);
  }
  try {
    await deps.store.teamSyncPruneEnded(now - LIMITS.teamReadableMs);
  } catch (error) {
    deps.log?.(`Pruning ended teams’ folders failed: ${describe(error)}`);
  }
}

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
      if (tabs.length < 2) throw badRequest('Organise needs at least two tabs.');
      return countedRun(deps, account, () => deps.model.organise(tabs).then((groups) => ({ groups })));
    case 'name':
      return lightTask(deps, account, () => deps.model.name(tabs).then((name) => ({ name })));
    case 'context': {
      const { name } = body;
      if (typeof name !== 'string') throw badRequest('“name” must be the group’s name.');
      return lightTask(deps, account, () => deps.model.context(name, tabs).then((summary) => ({ summary })));
    }
    case 'ask': {
      const { query } = body;
      if (typeof query !== 'string' || !query.trim()) throw badRequest('“query” must be what you’re looking for.');
      return lightTask(deps, account, () => deps.model.ask(query, tabs).then((matches) => ({ matches })));
    }
    case 'tidy': {
      const folders = cleanFolders(body.folders);
      if (!folders) throw badRequest('“folders” must be a list of { id, name }.');
      // Fewer tabs than a suggestion needs: nothing to ask the model, nothing counted.
      if (tabs.length < MIN_TIDY_TABS) {
        const now = deps.now();
        return ok({ suggestions: [], runs: aiRuns((await deps.store.aiUsage(account, monthOf(now))).runs, now) });
      }
      return countedRun(deps, account, () => deps.model.tidy(tabs, folders).then((suggestions) => ({ suggestions })));
    }
    default:
      throw badRequest('“task” must be organise, name, context, ask or tidy.');
  }
}

/** A tidy-up suggestion has at least this many tabs. */
const MIN_TIDY_TABS = 5;

/** Organise and the tidy-up count one run each, and only once the model has answered well. */
async function countedRun(deps: Deps, account: string, run: () => Promise<object>): Promise<Reply> {
  const now = deps.now();
  const month = monthOf(now);
  const message = `You’ve used this month’s ${LIMITS.runsPerMonth} AI runs.`;
  const { runs } = await deps.store.aiUsage(account, month);
  if (runs >= LIMITS.runsPerMonth) throw usedUp(message, runs, now);
  const result = await runModel(deps, run);
  const used = await deps.store.takeRun(account, month, 'runs', LIMITS.runsPerMonth);
  // Another computer took the last run while this one was thinking.
  if (used === RUN_LIMIT_REACHED) throw usedUp(message, LIMITS.runsPerMonth, now);
  return ok({ ...result, runs: aiRuns(used, now) });
}

/** Smart names, Copy as context and Ask your tabs aren't runs, but share a monthly cap. */
async function lightTask(deps: Deps, account: string, run: () => Promise<object>): Promise<Reply> {
  const now = deps.now();
  const month = monthOf(now);
  const message = 'Smart names, Copy as context and Ask your tabs are paused for the rest of the month.';
  const usage = await deps.store.aiUsage(account, month);
  if (usage.light >= LIMITS.lightPerMonth) throw usedUp(message, usage.runs, now);
  const result = await runModel(deps, run);
  if ((await deps.store.takeRun(account, month, 'light', LIMITS.lightPerMonth)) === RUN_LIMIT_REACHED) {
    throw usedUp(message, usage.runs, now);
  }
  return ok(result);
}

// ---- Teams ----

const notInTeam = () => new HttpError(404, 'server', 'You’re not in a team.');
const ownerOnly = () => new HttpError(403, 'server', 'Only the team’s owner can do this.');
const teamEnded = () => new HttpError(402, 'needs-pro-ai', 'This team’s plan has ended. Its owner can start it again in Tabfold.');

/** active, past due (still on), or ended. */
function teamStatus(subscription: Subscription | null): 'active' | 'past_due' | 'ended' {
  if (!subscription || !isLive(subscription)) return 'ended';
  return subscription.status === 'past_due' ? 'past_due' : 'active';
}

/** A team's folders can be read while its plan is on, and for 30 days after it ends. */
function teamReadable(subscription: Subscription | null, now: number): boolean {
  if (!subscription) return false;
  if (isLive(subscription)) return true;
  const endedAt = subscription.endedAt ?? subscription.cancelAt ?? subscription.currentPeriodEnd;
  return typeof endedAt === 'number' && now < endedAt + LIMITS.teamReadableMs;
}

/**
 * A Teams checkout was paid: its team, owned by the payer. An account is in one team at most, so
 * a payer already in a team whose plan is on gets none (it can only happen when two checkouts
 * race: the log says so, and the extra plan can be cancelled in billing).
 */
async function makeTeam(deps: Deps, account: Account, session: CheckoutInfo, subscription: Subscription): Promise<void> {
  const membership = await deps.store.teamOf(account.id);
  if (membership && membership.team.subscriptionId !== subscription.id && isLive(await teamSubscription(deps, membership.team))) {
    deps.log?.('A Teams checkout was paid by an account already in a team whose plan is on; no team was made for it');
    return;
  }
  const name = cleanLine(session.metadata.teamName ?? '', LIMITS.teamName) || DEFAULT_TEAM_NAME;
  await deps.store.teamCreate(account.id, name, subscription.id);
}

/**
 * After a code sign-in: joins the first team (oldest invitation first) that invited this email and
 * whose plan is on, and adds a seat to its plan if it now has more people than seats. Never fails
 * the sign-in: problems go to the log.
 */
async function joinInvitedTeam(deps: Deps, account: Account): Promise<void> {
  try {
    if (await deps.store.teamOf(account.id)) return;
    for (const teamId of await deps.store.teamInvitesFor(account.email)) {
      const team = await deps.store.teamGet(teamId);
      if (!team || !isLive(await teamSubscription(deps, team))) continue;
      if (await deps.store.teamJoin(team.id, account.id, account.email)) {
        await matchSeats(deps, team, 'joined');
        return;
      }
    }
  } catch (error) {
    deps.log?.(`Joining a team failed: ${describe(error)}`);
  }
}

/**
 * Keeps a team's paid seats in step with its people (prorated by Stripe): someone joining makes it
 * at least the number of members; someone leaving takes one seat off, never below the members
 * left or 1. Stripe trouble goes to the log; the next change catches up.
 */
async function matchSeats(deps: Deps, team: TeamRecord, change: 'joined' | 'left'): Promise<void> {
  try {
    const subscription = await teamSubscription(deps, team);
    if (!subscription || !isLive(subscription) || !subscription.itemId) return;
    const members = (await deps.store.teamMembers(team.id)).length;
    const seats = subscription.quantity ?? 1;
    const target = change === 'joined' ? Math.max(seats, members) : Math.max(1, members, seats - 1);
    if (target === seats) return;
    await deps.payments.updateQuantity(subscription.itemId, target);
    await deps.store.subscriptionPut(team.ownerId, await deps.payments.getSubscription(subscription.id));
  } catch (error) {
    deps.log?.(`Changing a team’s seats failed: ${describe(error)}`);
  }
}

/** The signed-in account and its team; 401 when not signed in, 404 when not in a team. */
async function memberOf(req: Request, deps: Deps): Promise<{ account: Account; membership: TeamMembership }> {
  const { account } = await signedIn(req, deps);
  const membership = await deps.store.teamOf(account.id);
  if (!membership) throw notInTeam();
  return { account, membership };
}

/** The same, for the team's owner only (403 for other members). */
async function ownerOf(req: Request, deps: Deps): Promise<{ account: Account; membership: TeamMembership }> {
  const found = await memberOf(req, deps);
  if (found.membership.role !== 'owner') throw ownerOnly();
  return found;
}

async function teamInfo(deps: Deps, membership: TeamMembership) {
  const subscription = await teamSubscription(deps, membership.team);
  return {
    id: membership.team.id,
    name: membership.team.name,
    seats: subscription?.quantity ?? 1,
    role: membership.role,
    status: teamStatus(subscription),
  };
}

async function teamGet(req: Request, deps: Deps): Promise<Reply> {
  const { membership } = await memberOf(req, deps);
  const [team, members, invites] = await Promise.all([
    teamInfo(deps, membership),
    deps.store.teamMembers(membership.team.id),
    deps.store.teamInvites(membership.team.id),
  ]);
  return ok({ team, members, invites });
}

async function teamPatch(req: Request, deps: Deps): Promise<Reply> {
  const { membership } = await ownerOf(req, deps);
  const name = readTeamName((await readObject(req, '{ name }')).name, true);
  await deps.store.teamRename(membership.team.id, name);
  return ok({ team: await teamInfo(deps, { ...membership, team: { ...membership.team, name } }) });
}

async function teamInvite(req: Request, deps: Deps): Promise<Reply> {
  const { account, membership } = await ownerOf(req, deps);
  const { team } = membership;
  const body = await readObject(req, '{ emails }');
  if (!Array.isArray(body.emails) || body.emails.length === 0) throw badRequest('Send { emails: [...] }.');
  if (body.emails.length > LIMITS.invitesPerRequest) throw badRequest(`Invite at most ${LIMITS.invitesPerRequest} people at a time.`);
  const emails: string[] = [];
  for (const raw of body.emails) {
    const email = cleanEmail(raw);
    if (!email) throw new HttpError(400, 'invalid-email', `That doesn’t look like an email address: ${String(raw).slice(0, 80)}`);
    if (!emails.includes(email)) emails.push(email);
  }
  if (!isLive(await teamSubscription(deps, team))) throw teamEnded();
  const [members, invites] = await Promise.all([deps.store.teamMembers(team.id), deps.store.teamInvites(team.id)]);
  const known = new Set([...members.map((m) => m.email), ...invites.map((i) => i.email)]);
  const fresh = emails.filter((email) => !known.has(email));
  if (known.size + fresh.length > LIMITS.teamMaxPeople) {
    throw badRequest(`A team can have up to ${LIMITS.teamMaxPeople} people, invitations included.`);
  }
  let invited = 0;
  for (const email of fresh) {
    const wait = await deps.store.rateTake(`invite:${team.id}`, LIMITS.invitesPerTeamPerDay, DAY_MS / 1000);
    if (wait > 0) {
      const hours = Math.max(1, Math.ceil(wait / 3600));
      throw new HttpError(429, 'rate-limited', `That’s a lot of invitations for one day. Try again in ${hours} hour${hours === 1 ? '' : 's'}.`, {
        retryAfter: Math.ceil(wait),
        invited,
      });
    }
    if (!(await deps.store.teamInvitePut(team.id, email))) continue;
    try {
      await deps.mailer.sendInvite(email, team.name, account.email);
    } catch (error) {
      // Not sent, so not invited: the owner can try again.
      await deps.store.teamInviteDelete(team.id, email);
      if (!isNamed(error, 'MailError')) throw error;
      deps.log?.(`Sending an invitation failed: ${describe(error)}`);
      throw new HttpError(502, 'send-failed', 'Couldn’t send the invitation. Check your connection and try again.', { invited });
    }
    invited += 1;
  }
  return ok({ invited });
}

async function teamUninvite(req: Request, deps: Deps, param: string): Promise<Reply> {
  const { membership } = await ownerOf(req, deps);
  const email = cleanEmail(param);
  if (email) await deps.store.teamInviteDelete(membership.team.id, email);
  return ok({ ok: true });
}

async function teamRemove(req: Request, deps: Deps, param: string): Promise<Reply> {
  const { account, membership } = await ownerOf(req, deps);
  if (param === account.id) throw badRequest('You own this team, so you can’t remove yourself. To stop, cancel the plan in billing.');
  if (!(await deps.store.teamLeave(membership.team.id, param))) throw new HttpError(404, 'server', 'That person isn’t in your team.');
  await matchSeats(deps, membership.team, 'left');
  return ok({ ok: true });
}

async function teamLeave(req: Request, deps: Deps): Promise<Reply> {
  const { account, membership } = await memberOf(req, deps);
  if (membership.role === 'owner') throw badRequest('You own this team, so you can’t leave it. To stop, cancel the plan in billing.');
  await deps.store.teamLeave(membership.team.id, account.id);
  await matchSeats(deps, membership.team, 'left');
  return ok({ ok: true });
}

async function teamSyncGet(req: Request, deps: Deps): Promise<Reply> {
  const { membership } = await memberOf(req, deps);
  if (!teamReadable(await teamSubscription(deps, membership.team), deps.now())) throw teamEnded();
  const { items, version } = await deps.store.teamSyncRead(membership.team.id);
  return ok({ items, version });
}

async function teamSyncPost(req: Request, deps: Deps): Promise<Reply> {
  const { membership } = await memberOf(req, deps);
  if (!isLive(await teamSubscription(deps, membership.team))) throw teamEnded();
  const team = membership.team.id;
  const input = readSyncWrite(await readJson(req));
  const result = await deps.store.teamSyncWrite(team, input.baseVersion, input.set, input.remove, LIMITS.maxSyncBytes);
  if (result === SYNC_CONFLICT) {
    const version = await deps.store.teamSyncVersion(team);
    throw new HttpError(409, 'conflict', 'The team’s folders changed on another computer. Read them again first.', { version });
  }
  if (result === SYNC_TOO_LARGE) {
    throw new HttpError(413, 'server', 'That’s more than a team can keep (8 MB of folders).');
  }
  if (result < 0) throw new Error(`Unexpected team sync write result ${result}`);
  return ok({ version: result });
}

// ---- Shared folders ----

const SHARE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 10 letters and digits, uniform: bytes at or above the last whole multiple of 62 are drawn again. */
export function newShareId(random: (bytes: number) => Uint8Array = defaultRandom): string {
  const limit = Math.floor(256 / SHARE_ALPHABET.length) * SHARE_ALPHABET.length;
  let id = '';
  while (id.length < 10) {
    for (const byte of random(16)) {
      if (byte < limit && id.length < 10) id += SHARE_ALPHABET[byte % SHARE_ALPHABET.length];
    }
  }
  return id;
}

function shareUrl(deps: Deps, id: string): string {
  return `${(deps.config.shareBaseUrl || DEFAULT_SITE_URL).replace(/\/+$/, '')}/s/${id}`;
}

/** A page's address for the public page: http(s) only, without a user name or password, at most 2,000 characters. */
export function pageAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.username = '';
  url.password = '';
  return url.href.length <= LIMITS.shareUrl ? url.href : null;
}

/**
 * A shared folder's contents: name, colour, at most 1,000 tabs with http(s) addresses, titles cut to
 * 200 characters, and (1.0) the folder's note, one line of at most 140 characters ('' when none).
 */
export function readShare(body: Record<string, unknown>): ShareContent {
  if (typeof body.name !== 'string') throw badRequest('Send { name, color, tabs, live }.');
  const name = cleanLine(body.name, LIMITS.shareName);
  if (!name) throw badRequest('Give the folder a name.');
  if (!Array.isArray(body.tabs)) throw badRequest('“tabs” must be a list of { title, url }.');
  const color = (SHARE_COLORS as readonly unknown[]).includes(body.color) ? (body.color as string) : 'grey';
  const tabs: ShareContent['tabs'] = [];
  for (const entry of body.tabs) {
    if (tabs.length >= LIMITS.shareMaxTabs) break;
    if (!isObject(entry)) throw badRequest('“tabs” must be a list of { title, url }.');
    const url = pageAddress(entry.url);
    if (!url) continue;
    tabs.push({ title: typeof entry.title === 'string' ? cleanLine(entry.title, LIMITS.shareTitle) : '', url });
  }
  return { name, color, tabs, live: body.live === true, note: cleanNote(body.note) };
}

const noShare = () => new HttpError(404, 'server', 'This link doesn’t work any more.');

/** The handler's share id; 404 for anything that can't be one. */
function shareIdOf(param: string): string {
  if (!SHARE_ID_PATTERN.test(param)) throw noShare();
  return param;
}

async function shareCreate(req: Request, deps: Deps): Promise<Reply> {
  const account = await accountFor(req, deps, 'pro');
  const content = readShare(await readObject(req, '{ name, color, tabs, live }'));
  if ((await deps.store.shareCount(account)) >= LIMITS.sharesPerAccount) {
    throw badRequest(`You can share up to ${LIMITS.sharesPerAccount} folders. Stop sharing one you don’t need first.`);
  }
  // 62^10 ids: a clash is very unlikely, and another id is tried.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = newShareId(deps.random ? (bytes) => deps.random!(bytes) : undefined);
    if (await deps.store.shareCreate(id, account, content)) return ok({ id, url: shareUrl(deps, id) });
  }
  throw new Error('Could not find a free share id');
}

async function shareReplace(req: Request, deps: Deps, param: string): Promise<Reply> {
  const account = await accountFor(req, deps, 'pro');
  const id = shareIdOf(param);
  const content = readShare(await readObject(req, '{ name, color, tabs, live }'));
  const share = await deps.store.shareUpdate(id, account, content);
  if (!share) throw noShare();
  return ok({ id, url: shareUrl(deps, id), views: share.views, live: share.live });
}

async function shareInfo(req: Request, deps: Deps, param: string): Promise<Reply> {
  const { account } = await signedIn(req, deps);
  const id = shareIdOf(param);
  const share = await deps.store.shareGet(id);
  if (!share || share.accountId !== account.id) throw noShare();
  return ok({ id, url: shareUrl(deps, id), views: share.views, live: share.live, updatedAt: share.updatedAt, note: share.note ?? '' });
}

/** Stops sharing: the link stops working at once. Fine to ask twice. */
async function shareStop(req: Request, deps: Deps, param: string): Promise<Reply> {
  const { account } = await signedIn(req, deps);
  if (SHARE_ID_PATTERN.test(param)) await deps.store.shareDelete(param, account.id);
  return ok({ ok: true });
}

/** The visitor's address, from the proxy in front of the function, for the public page's limit. */
function clientAddress(req: Request): string {
  const cloudflare = req.headers.get('cf-connecting-ip')?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'unknown';
}

/** The public page's data: no token, any site may read it, and each read counts a view. */
async function publicShare(req: Request, deps: Deps, param: string): Promise<Reply> {
  const key = await rateKey(deps.config.codeSecret, 'share-read', clientAddress(req));
  const wait = await deps.store.rateTake(key, LIMITS.shareReadsPerMinute, 60);
  if (wait > 0) {
    throw new HttpError(429, 'rate-limited', 'That’s a lot of visits just now. Try again in a minute.', { retryAfter: Math.ceil(wait) });
  }
  const share = await deps.store.shareView(shareIdOf(param));
  if (!share) throw noShare();
  return ok({ ...share, note: share.note ?? '' });
}

// ---- Deleting an account (1.0) ----

/** Stripe's states for a subscription that has ended for good. */
const ENDED_STATUSES = ['canceled', 'incomplete_expired'];

/**
 * Cancels a subscription at once, unless it has already ended (Stripe's answer now is the truth:
 * the stored state can be a little behind).
 */
async function cancelSubscription(deps: Deps, stored: Subscription): Promise<void> {
  if (ENDED_STATUSES.includes(stored.status)) return;
  try {
    const current = await deps.payments.getSubscription(stored.id);
    if (ENDED_STATUSES.includes(current.status)) return;
    await deps.payments.cancelSubscription(stored.id);
  } catch (error) {
    // Stripe doesn't know it (a test-mode id after switching to live keys, say): nothing can charge
    // it, so it counts as ended. Anything else stops the deletion, to be tried again.
    if (isNamed(error, 'PaymentsError') && (error as { status?: unknown }).status === 404) return;
    throw error;
  }
}

/**
 * `POST /account/delete`: the person typed their account's email to confirm. Stripe first, so that
 * when it can't be reached nothing is deleted and they can try again: every subscription on the
 * account (its own, and a team's it owns) is cancelled at once. Then the account and everything
 * kept for it go in one step (Store.accountDelete): its computers are signed out, its synced copy,
 * backups, shares (their links stop working), AI usage and a Pro for life purchase go, and a team it
 * owns ends for everyone in it. A member's team gets one seat fewer, as when someone leaves.
 * Stripe keeps its own records of payments. If the account had a trial, the email's trial
 * fingerprint stays (see trialFingerprint), so the same email can't start another.
 */
async function accountDelete(req: Request, deps: Deps): Promise<Reply> {
  const { account } = await signedIn(req, deps);
  const body = await readObject(req, '{ confirm }');
  const typed = typeof body.confirm === 'string' ? body.confirm.trim().toLowerCase() : '';
  if (!typed || typed !== account.email) throw new HttpError(400, 'invalid', 'Type your account’s email to confirm.');
  const membership = await deps.store.teamOf(account.id);
  // Worked out first: if the secret is missing, nothing is cancelled or deleted.
  const trialHash = await fingerprintOf(deps, account);
  for (const subscription of await deps.store.subscriptionList(account.id)) await cancelSubscription(deps, subscription);
  await deps.store.accountDelete(account.id, trialHash);
  if (membership && membership.role === 'member') await matchSeats(deps, membership.team, 'left');
  return ok({ ok: true });
}
