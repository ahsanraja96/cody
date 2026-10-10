import { AI_RUNS_PER_MONTH, hasPro, hasProAi, planFromUser, type ExtPayUser, type PlanState } from '../_shared/plan.ts';
import { cleanTabs, type AiTab, type Model } from './ai.ts';

/**
 * The Tabfold Pro server (server/API.md): routes, sign-in with the ExtensionPay key, plan checks,
 * sync, daily backups and the AI tasks. Only web-standard APIs, with the database, ExtensionPay
 * and the model injected, so the same code runs in the Edge Function (index.ts) and in tests.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const LIMITS = {
  maxBodyBytes: 10 * 1024 * 1024,
  /** The account's synced items in total (keys plus JSON values). */
  maxSyncBytes: 8 * 1024 * 1024,
  maxKeyLength: 128,
  extpayCacheMs: 5 * MINUTE_MS,
  backupDays: 30,
  runsPerMonth: AI_RUNS_PER_MONTH,
  /** Smart names and Copy as context together, a month. */
  lightPerMonth: 1000,
} as const;

/** What `tabfold_sync_write` returns instead of a version. */
export const SYNC_CONFLICT = -1;
export const SYNC_TOO_LARGE = -2;
/** What `tabfold_take_run` returns when the month's limit is reached. */
export const RUN_LIMIT_REACHED = -1;

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

/** The database, as the SQL in server/supabase/migrations defines it. */
export interface Store {
  /** The account for this (lower-cased) email, created on first use. */
  accountId(email: string): Promise<string>;
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
  extpayCacheGet(keyHash: string): Promise<{ user: ExtPayUser; checkedAt: number } | null>;
  extpayCachePut(keyHash: string, user: ExtPayUser, checkedAt: number): Promise<void>;
}

export interface Deps {
  store: Store;
  /** ExtensionPay's user for this key; null when ExtensionPay doesn't know the key. */
  extpayUser(apiKey: string): Promise<ExtPayUser | null>;
  model: Model;
  now(): number;
  config: {
    extpayId: string;
    /** `chrome-extension://<id>` origins allowed to call; `*` allows any extension. */
    allowedOrigins: string[];
  };
  /** Server logs. Never given keys or tab titles. */
  log?(message: string): void;
}

type ErrorCode = 'not-signed-in' | 'needs-pro' | 'needs-pro-ai' | 'conflict' | 'runs-used-up' | 'ai-failed' | 'server';

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface Reply {
  status: number;
  body: unknown;
}

const ok = (body: unknown): Reply => ({ status: 200, body });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.config.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let reply: Reply;
  try {
    reply = await route(req, deps);
  } catch (error) {
    reply = errorReply(error, req, deps);
  }
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function route(req: Request, deps: Deps): Promise<Reply> {
  const path = routePath(new URL(req.url).pathname);
  const method = req.method;
  if (path === '/me') return only(method, 'GET', () => me(req, deps));
  if (path === '/sync') {
    if (method === 'GET') return syncGet(req, deps);
    return only(method, 'POST', () => syncPost(req, deps));
  }
  if (path === '/backups') return only(method, 'GET', () => backupsList(req, deps));
  const backupDay = /^\/backups\/([^/]+)$/.exec(path)?.[1];
  if (backupDay !== undefined) return only(method, 'GET', () => backupGet(req, deps, backupDay));
  if (path === '/ai') return only(method, 'POST', () => ai(req, deps));
  throw new HttpError(404, 'server', 'There’s nothing here.');
}

/** The path after the function's name: Supabase passes `/tabfold/me` (or `/functions/v1/tabfold/me`). */
function routePath(pathname: string): string {
  const path = pathname.replace(/^.*?\/tabfold(?=\/|$)/, '').replace(/\/+$/, '');
  return path || '/';
}

function only(method: string, allowed: string, run: () => Promise<Reply>): Promise<Reply> {
  if (method !== allowed) throw new HttpError(405, 'server', `Use ${allowed} here.`);
  return run();
}

function errorReply(error: unknown, req: Request, deps: Deps): Reply {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.code, message: error.message, ...error.extra } };
  }
  deps.log?.(`${req.method} ${routePath(new URL(req.url).pathname)} failed: ${describe(error)}`);
  return {
    status: 500,
    body: { error: 'server', message: 'Something went wrong on the Tabfold server. Try again in a minute.' },
  };
}

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

// ---- Sign-in and plans ----

type Need = 'any' | 'pro' | 'pro-ai';

const notSignedIn = () => new HttpError(401, 'not-signed-in', 'This computer isn’t signed in to Tabfold Pro.');

function bearerKey(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization')?.trim() ?? '');
  const key = match?.[1];
  return key && /^[\w.-]{8,200}$/.test(key) ? key : null;
}

/** Hex SHA-256: the cache's key, so the ExtensionPay key itself is never stored. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function allows(plan: PlanState, need: Need): boolean {
  if (need === 'any') return true;
  // The account is the plan's email; without one there is nothing to sync or count against.
  if (!plan.email) return false;
  return need === 'pro' ? hasPro(plan) : hasProAi(plan);
}

async function askExtPay(deps: Deps, key: string, keyHash: string, now: number): Promise<ExtPayUser> {
  const user = await deps.extpayUser(key);
  if (!user) throw notSignedIn();
  await deps.store.extpayCachePut(keyHash, user, now);
  return user;
}

async function signIn(req: Request, deps: Deps, need: Need): Promise<PlanState> {
  if (!deps.config.extpayId) throw new HttpError(500, 'server', 'The Tabfold server isn’t set up yet.');
  const key = bearerKey(req);
  if (!key) throw notSignedIn();
  const keyHash = await sha256Hex(key);
  const now = deps.now();
  const cached = await deps.store.extpayCacheGet(keyHash);
  const cacheFresh = !!cached && now >= cached.checkedAt && now - cached.checkedAt < LIMITS.extpayCacheMs;
  let plan = planFromUser(cacheFresh ? cached.user : await askExtPay(deps, key, keyHash, now), now);
  // A cached plan that refuses may be out of date (the person may have just paid): ask again.
  if (cacheFresh && !allows(plan, need)) plan = planFromUser(await askExtPay(deps, key, keyHash, now), now);
  if (!allows(plan, need)) {
    throw need === 'pro-ai'
      ? new HttpError(402, 'needs-pro-ai', 'This needs Tabfold Pro AI.')
      : new HttpError(402, 'needs-pro', 'This needs Tabfold Pro.');
  }
  return plan;
}

const accountEmail = (email: string) => email.trim().toLowerCase();

/** Signs in for a Pro route and returns the account id. */
async function accountFor(req: Request, deps: Deps, need: 'pro' | 'pro-ai'): Promise<string> {
  const plan = await signIn(req, deps, need);
  // signIn refuses Pro routes to a plan without an email.
  return deps.store.accountId(accountEmail(plan.email!));
}

/** ExtensionPay's JSON as an ExtPayUser, keeping only fields of the expected types. */
export function readExtPayUser(json: unknown): ExtPayUser | null {
  if (!isObject(json)) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const plan = isObject(json.plan) ? json.plan : null;
  const interval = plan?.interval;
  const status = json.subscriptionStatus;
  return {
    paid: json.paid === true,
    paidAt: text(json.paidAt),
    installedAt: text(json.installedAt),
    trialStartedAt: text(json.trialStartedAt),
    email: text(json.email),
    plan: plan && {
      unitAmountCents: typeof plan.unitAmountCents === 'number' ? plan.unitAmountCents : undefined,
      currency: text(plan.currency) ?? undefined,
      nickname: text(plan.nickname),
      interval: interval === 'month' || interval === 'year' || interval === 'once' ? interval : null,
      intervalCount: typeof plan.intervalCount === 'number' ? plan.intervalCount : null,
    },
    subscriptionStatus: status === 'active' || status === 'past_due' || status === 'canceled' ? status : null,
    subscriptionCancelAt: text(json.subscriptionCancelAt),
  };
}

// ---- Request bodies ----

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const tooLarge = () => new HttpError(413, 'server', 'That request is too large.');
const badRequest = (message: string) => new HttpError(400, 'server', message);

async function readJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > LIMITS.maxBodyBytes) throw tooLarge();
  const text = await readText(req, LIMITS.maxBodyBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('The request isn’t valid JSON.');
  }
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
  const plan = await signIn(req, deps, 'any');
  let runs: AiRuns | null = null;
  if (plan.email && hasProAi(plan)) {
    const account = await deps.store.accountId(accountEmail(plan.email));
    const now = deps.now();
    runs = aiRuns((await deps.store.aiUsage(account, monthOf(now))).runs, now);
  }
  return ok({ plan, runs });
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
