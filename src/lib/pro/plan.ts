import { browser } from 'wxt/browser';
import { readRuns } from './ai';
import { ensureProfileKey, forgetDeviceToken, isToken, peekDeviceToken, PROFILE_KEY, setSignedOutHere, usableProfileKey } from './account';
import { api, ProError } from './api';
import { proConfigured } from './config';
import { aiRuns, forgetCloudSyncState, needsSignIn, planEnded, planState, readPlan } from './state';
import { FREE_PLAN, type PlanState, type SigninPurpose, type SigninResult, type Tier } from './types';

/**
 * The plan, as the server works it out (`GET /me`), cached in `planState`. Read when the worker
 * starts (at most hourly), every 6 hours, when a Tabfold page opens or comes back into focus (at
 * most once a minute), when the trial ends, and every few seconds while a Stripe checkout tab is
 * open (checkout.ts). A computer that never signed in, paid or started a trial has no device token
 * and asks the server nothing.
 *
 * Signing in is an emailed 6-digit code (`signin-start`, `signin-finish`). After any sign-in this
 * computer makes the Chrome profile key if there's none and registers it, so other computers on
 * the same Chrome profile sign themselves in with it (`POST /signin/profile`), once per worker
 * start and key, unless the person signed out there.
 */

/** Pages ask on open; real reads happen at most this often unless forced. */
export const MIN_READ_INTERVAL_MS = 60_000;
/** On worker start (the worker starts often). */
export const STARTUP_READ_INTERVAL_MS = 60 * 60_000;
export const PLAN_ALARM = 'tabfold-plan';
export const PLAN_ALARM_MINUTES = 6 * 60;
export const TRIAL_END_ALARM = 'tabfold-trial-end';

let inFlight: Promise<PlanState> | null = null;
let lastReadAt = 0;
/** The profile key this worker already tried to sign in with. */
let profileTried: string | null = null;

/** For tests: forget the in-memory throttle and the profile key tried. */
export function resetPlanRuntime(): void {
  lastReadAt = 0;
  inFlight = null;
  profileTried = null;
}

/** `GET /me`, `POST /signin/profile`: the plan and this month's AI runs (Pro AI). */
interface PlanAnswer {
  plan?: unknown;
  runs?: unknown;
  /** `GET /me` only: a checkout from here was paid with an email that already had an account; sign in with a code to use it. */
  needsSignIn?: unknown;
}

/** Keep (or forget) "your payment is on … : sign in" for the pages; only while this computer isn't signed in. */
async function storeNeedsSignIn(plan: PlanState, value: unknown): Promise<void> {
  const email = value && typeof value === 'object' ? (value as { email?: unknown }).email : undefined;
  if (plan.email === null && typeof email === 'string' && email.includes('@')) {
    const current = await needsSignIn.get();
    if (current?.email !== email) await needsSignIn.set({ email });
  } else if (await needsSignIn.get()) {
    await needsSignIn.set(null);
  }
}

/** `POST /signin/finish`, `POST /trial`. */
interface SigninAnswer extends PlanAnswer {
  trialStarted?: unknown;
  trialUsed?: unknown;
}

function planOf(answer: PlanAnswer | null | undefined): PlanState {
  const plan = readPlan(answer?.plan);
  if (!plan) throw new ProError('server', 'Tabfold’s server sent an unexpected answer.');
  return plan;
}

async function storeRuns(value: unknown): Promise<void> {
  const runs = readRuns(value);
  if (runs) await aiRuns.set(runs);
}

/** The error's code (never its details) for the console. */
function codeOf(error: unknown): string {
  return error instanceof ProError ? error.code : ((error as Error)?.name ?? 'error');
}

/**
 * Free, with the Free limits: no paid tier, no Pro for life, no team (a Teams plan or Pro for life
 * counts as paid everywhere). The same rule as `hasFreeLimits` (src/ui/hooks.ts).
 */
function isFree(plan: PlanState): boolean {
  return plan.tier === 'free' && !plan.lifetime && !plan.team;
}

/**
 * Store a plan. A paid plan or trial that ended while the same account stays signed in leaves a
 * one-time notice (`planEnded`), only when the person ends up Free (a team ending for someone with
 * Pro for life or their own plan says nothing); signing out doesn't, and paying again clears it.
 * Signing in (the email changed, or any sign-in with a code) registers the Chrome profile key.
 */
export async function applyPlan(next: PlanState, options: { viaProfile?: boolean; withCode?: boolean; now?: number } = {}): Promise<void> {
  const now = options.now ?? Date.now();
  const previous = await planState.get();
  await planState.set(next);
  if (!isFree(previous) && isFree(next) && previous.email !== null && next.email === previous.email) {
    const tier: Exclude<Tier, 'free'> = previous.tier === 'free' ? 'pro' : previous.tier;
    await planEnded.set({ at: now, tier, wasTrial: previous.trial !== null });
  } else if (!isFree(next) && (await planEnded.get())) {
    await planEnded.set(null);
  }
  await scheduleTrialEnd(next);
  if (next.email) await storeNeedsSignIn(next, null);
  if (next.email && (next.email !== previous.email || options.withCode)) {
    await afterSignIn(previous.email, next.email, options.viaProfile === true);
  }
}

/**
 * Signed in (with a code, by paying, or with the profile key): this computer may use the profile
 * key again, and other computers on this Chrome profile can sign in with it. The key is registered
 * again after every code sign-in, even when it already exists: the server may have dropped it
 * (when an account made by a checkout is first proved with a code, its other computers are signed
 * out and its profile key goes).
 */
async function afterSignIn(previousEmail: string | null, email: string, viaProfile: boolean): Promise<void> {
  await setSignedOutHere(false);
  // Signed in as someone else: what this computer knew about the other account's copy doesn't apply.
  if (previousEmail && previousEmail !== email) await forgetCloudSyncState();
  if (viaProfile) return;
  try {
    const profileKey = await ensureProfileKey();
    if (profileKey) await api('/profile', { method: 'POST', body: { profileKey } });
  } catch (error) {
    // Other computers then sign in with a code; nothing else depends on it.
    console.warn('[tabfold] couldn’t register the Chrome profile key', codeOf(error));
  }
}

/** Read the plan again exactly when the trial ends, so it doesn't run on until the next 6-hourly read. */
async function scheduleTrialEnd(plan: PlanState): Promise<void> {
  try {
    if (plan.trial) await browser.alarms.create(TRIAL_END_ALARM, { when: plan.trial.endsAt + 30_000 });
    else await browser.alarms.clear(TRIAL_END_ALARM);
  } catch {
    // The 6-hourly read catches it.
  }
}

/** Sign in with the Chrome profile key. Null when the server doesn't know the key (then nothing changes). */
async function signInWithProfile(profileKey: string, hadToken: boolean): Promise<PlanState | null> {
  profileTried = profileKey;
  let answer: PlanAnswer;
  try {
    answer = await api<PlanAnswer>('/signin/profile', { method: 'POST', body: { profileKey } });
  } catch (error) {
    if (error instanceof ProError && error.code === 'not-signed-in') {
      // A token made just for this try is of no use: Free stays without one.
      if (!hadToken) await forgetDeviceToken();
      return null;
    }
    // Offline or the server failing: try again next time.
    profileTried = null;
    throw error;
  }
  const plan = planOf(answer);
  await applyPlan(plan, { viaProfile: true });
  await storeRuns(answer.runs);
  return plan;
}

async function readFromServer(): Promise<PlanState> {
  const token = await peekDeviceToken();
  const profileKey = await usableProfileKey();
  const tryProfile = profileKey !== null && profileTried !== profileKey;
  if (!token) {
    if (tryProfile) {
      const signedIn = await signInWithProfile(profileKey, false);
      if (signedIn) return signedIn;
    }
    // Never signed in here: Free, and the server isn't asked.
    const free = { ...FREE_PLAN, checkedAt: Date.now() };
    await applyPlan(free);
    await storeNeedsSignIn(free, null);
    return free;
  }
  const answer = await api<PlanAnswer>('/me');
  const plan = planOf(answer);
  if (plan.email === null && tryProfile) {
    const signedIn = await signInWithProfile(profileKey, true);
    if (signedIn) return signedIn;
  }
  await applyPlan(plan);
  await storeRuns(answer.runs);
  await storeNeedsSignIn(plan, answer.needsSignIn);
  return plan;
}

/**
 * Read the plan from the server and store it. Network and server errors keep the cached plan. In
 * a build without Pro it is always Free.
 */
export async function refreshPlan(options: { force?: boolean; maxAgeMs?: number } = {}): Promise<PlanState> {
  if (!proConfigured()) {
    const current = await planState.get();
    if (JSON.stringify(current) !== JSON.stringify(FREE_PLAN)) await planState.set(FREE_PLAN);
    return FREE_PLAN;
  }
  if (inFlight) return inFlight;
  const cached = await planState.get();
  const now = Date.now();
  // The server's clock may run ahead of this one.
  const last = Math.max(lastReadAt, Math.min(cached.checkedAt, now));
  if (!options.force && now - last < (options.maxAgeMs ?? MIN_READ_INTERVAL_MS)) return cached;
  lastReadAt = now;
  const run = (async () => {
    try {
      return await readFromServer();
    } catch (error) {
      console.warn('[tabfold] plan check failed', codeOf(error));
      return cached;
    }
  })();
  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Signing in and out

/** Email a 6-digit code (valid 10 minutes, 5 tries). */
export async function signinStart(email: string, purpose: SigninPurpose): Promise<{ sent: true }> {
  await api('/signin/start', { method: 'POST', body: { email: email.trim(), purpose } });
  return { sent: true };
}

async function signedIn(answer: SigninAnswer | null | undefined, withCode: boolean): Promise<SigninResult> {
  const plan = planOf(answer);
  lastReadAt = Date.now();
  await applyPlan(plan, { withCode });
  await storeRuns(answer?.runs);
  return { plan, trialStarted: answer?.trialStarted === true, trialUsed: answer?.trialUsed === true };
}

/** Check the code and sign this computer in; with `startTrial`, start the trial if this email never had one. */
export async function signinFinish(email: string, code: string, startTrial: boolean): Promise<SigninResult> {
  const answer = await api<SigninAnswer>('/signin/finish', {
    method: 'POST',
    body: { email: email.trim(), code: code.replace(/\D/g, ''), startTrial },
  });
  return signedIn(answer, true);
}

/** Start the trial for the account this computer is signed in to (no code needed). */
export async function startTrial(): Promise<SigninResult> {
  return signedIn(await api<SigninAnswer>('/trial', { method: 'POST' }), false);
}

/**
 * Sign out on this computer: the server unlinks its token, this computer drops it and stops using
 * the profile key, and the plan here is Free (no "plan ended" notice: the plan itself goes on).
 * Offline, it signs out here all the same.
 */
export async function signOut(now = Date.now()): Promise<{ ok: true }> {
  if (!proConfigured()) throw new ProError('not-configured');
  try {
    if (await peekDeviceToken()) await api('/signout', { method: 'POST' });
  } catch (error) {
    console.warn('[tabfold] sign-out request failed', codeOf(error));
  }
  await forgetDeviceToken();
  await setSignedOutHere(true);
  lastReadAt = now;
  await applyPlan({ ...FREE_PLAN, checkedAt: now }, { now });
  await Promise.all([aiRuns.set(null), needsSignIn.set(null), forgetCloudSyncState()]);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// In the worker

/** Called once at the worker's top level: read the plan (at most hourly), and follow the profile key. */
export function setupPlan(): void {
  // Another computer on this Chrome profile signed in: sign in here too (unless signed in already, or signed out here).
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !(PROFILE_KEY in changes) || !isToken(changes[PROFILE_KEY]!.newValue)) return;
    (async () => {
      if ((await planState.get()).email === null) await refreshPlan({ force: true });
    })().catch(() => undefined);
  });
  refreshPlan({ maxAgeMs: STARTUP_READ_INTERVAL_MS }).catch((error) => console.warn('[tabfold] plan setup failed', codeOf(error)));
}

/** chrome.alarms: the 6-hourly read and the trial's end. Returns false for other alarms. */
export function onPlanAlarm(name: string): boolean {
  if (name !== PLAN_ALARM && name !== TRIAL_END_ALARM) return false;
  refreshPlan({ force: true }).catch(() => undefined);
  return true;
}
