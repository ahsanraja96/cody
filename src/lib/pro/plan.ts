import { browser } from 'wxt/browser';
import { proConfigured } from './config';
import { ensureApiKey, EXTPAY_KEY, extpayPageUrl, fetchUser, type ExtPayPage } from './extpay';
import { planEnded, planState } from './state';
import { hasPro, planFromUser } from './tiers';
import { FREE_PLAN, type BillingInterval, type PlanState, type Tier } from './types';

/**
 * The plan, as ExtensionPay knows it, cached in `planState`. Read when the worker starts (at most
 * hourly), every 6 hours, when a Tabfold page opens (at most once a minute), when the trial ends,
 * and every 5 seconds while an ExtensionPay page Tabfold opened is open (that's how a payment,
 * trial or sign-in is noticed without ExtensionPay's content script).
 */

/** Pages ask on open; real reads happen at most this often unless forced. */
export const MIN_READ_INTERVAL_MS = 60_000;
/** On worker start (the worker starts often). */
export const STARTUP_READ_INTERVAL_MS = 60 * 60_000;
export const PLAN_ALARM = 'tabfold-plan';
export const PLAN_ALARM_MINUTES = 6 * 60;
export const TRIAL_END_ALARM = 'tabfold-trial-end';

export const NOT_AVAILABLE = 'Pro isn’t available in this build of Tabfold yet.';
const UNREACHABLE = 'Couldn’t reach ExtensionPay, which handles payments for Tabfold. Check your connection and try again.';

let inFlight: Promise<PlanState> | null = null;
let lastReadAt = 0;

/** For tests: forget the in-memory throttle. */
export function resetPlanThrottle(): void {
  lastReadAt = 0;
  inFlight = null;
}

/**
 * Store a newly read plan. A paid plan or trial that dropped to Free leaves a one-time notice
 * (`planEnded`); paying again clears it.
 */
export async function applyPlan(next: PlanState, now = Date.now()): Promise<void> {
  const previous = await planState.get();
  await planState.set(next);
  if (hasPro(previous) && next.tier === 'free') {
    await planEnded.set({ at: now, tier: previous.tier as Exclude<Tier, 'free'>, wasTrial: previous.trial !== null });
  } else if (hasPro(next) && (await planEnded.get())) {
    await planEnded.set(null);
  }
  await scheduleTrialEnd(next);
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

/**
 * Read the plan from ExtensionPay and store it. Network and ExtensionPay errors keep the cached
 * plan. Without a key nothing is called: a Free user. In a build without Pro it is always Free.
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
  if (!options.force && now - Math.max(lastReadAt, cached.checkedAt) < (options.maxAgeMs ?? MIN_READ_INTERVAL_MS)) return cached;
  lastReadAt = now;
  const run = (async () => {
    let next: PlanState;
    try {
      const user = await fetchUser();
      const at = Date.now();
      next = user ? planFromUser(user, at) : { ...FREE_PLAN, checkedAt: at };
    } catch (error) {
      console.warn('[tabfold] plan check failed', (error as Error)?.message ?? error);
      return cached;
    }
    await applyPlan(next);
    return next;
  })();
  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

// ---------------------------------------------------------------------------------------------
// ExtensionPay pages

/** An ExtensionPay tab or window Tabfold opened, watched until it closes (at most 15 minutes). */
export interface PageWatch {
  kind: 'tab' | 'window';
  id: number;
  until: number;
}

const WATCH_KEY = 'planPageWatch';
export const WATCH_POLL_MS = 5_000;
export const WATCH_MAX_MS = 15 * 60_000;

let pollTimer: ReturnType<typeof setTimeout> | undefined;

export async function getPageWatch(): Promise<PageWatch | undefined> {
  return (await browser.storage.session.get(WATCH_KEY))[WATCH_KEY] as PageWatch | undefined;
}

async function setPageWatch(watch: PageWatch | null): Promise<void> {
  if (watch) await browser.storage.session.set({ [WATCH_KEY]: watch });
  else await browser.storage.session.remove(WATCH_KEY);
}

function schedulePoll(delayMs = WATCH_POLL_MS): void {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    pollPageWatch().catch((error) => console.warn('[tabfold] plan poll failed', error));
  }, delayMs);
}

async function stillOpen(watch: PageWatch): Promise<boolean> {
  try {
    if (watch.kind === 'tab') await browser.tabs.get(watch.id);
    else await browser.windows.get(watch.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * One poll while an ExtensionPay page is open: read the plan; when the page has closed (or 15
 * minutes have passed), read it one last time and stop.
 */
export async function pollPageWatch(now = Date.now()): Promise<'watching' | 'done' | 'idle'> {
  const watch = await getPageWatch();
  if (!watch) return 'idle';
  if (now >= watch.until || !(await stillOpen(watch))) {
    await setPageWatch(null);
    await refreshPlan({ force: true });
    return 'done';
  }
  await refreshPlan({ force: true });
  schedulePoll();
  return 'watching';
}

/** tabs.onRemoved / windows.onRemoved: the watched page closed, so read the plan once more. */
export async function onPageClosed(kind: PageWatch['kind'], id: number): Promise<void> {
  const watch = await getPageWatch();
  if (!watch || watch.kind !== kind || watch.id !== id) return;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  await setPageWatch(null);
  await refreshPlan({ force: true });
}

async function watchPage(kind: PageWatch['kind'], id: number): Promise<void> {
  await setPageWatch({ kind, id, until: Date.now() + WATCH_MAX_MS });
  schedulePoll();
}

/** A popup window centred over the window the person is in. */
async function openCentredPopup(url: string, width: number, height: number) {
  let position: { left?: number; top?: number } = {};
  try {
    const current = await browser.windows.getLastFocused();
    if (current.left !== undefined && current.top !== undefined && current.width !== undefined && current.height !== undefined) {
      position = {
        left: Math.round(current.left + (current.width - width) / 2),
        top: Math.max(current.top, Math.round(current.top + (current.height - height) / 2)),
      };
    }
  } catch {
    // No window to centre on: Chrome places it.
  }
  try {
    return await browser.windows.create({ url, type: 'popup', width, height, focused: true, ...position });
  } catch {
    // Chrome refuses a position it thinks is off-screen.
    return browser.windows.create({ url, type: 'popup', width, height, focused: true }).catch(() => undefined);
  }
}

/**
 * Open ExtensionPay: checkout (a tab), managing the subscription (a tab), the trial sign-up or
 * sign-in (a small window). The plan is then read every 5 s while the page is open.
 */
export async function openPlanPage(
  page: ExtPayPage,
  plan: { tier?: Exclude<Tier, 'free'>; interval?: BillingInterval } = {},
): Promise<{ opened: boolean; reason?: string }> {
  if (!proConfigured()) return { opened: false, reason: NOT_AVAILABLE };
  let key: string;
  try {
    key = await ensureApiKey();
  } catch {
    return { opened: false, reason: UNREACHABLE };
  }
  const url = extpayPageUrl(page, key, plan);
  try {
    if (page === 'payment' || page === 'manage') {
      const tab = await browser.tabs.create({ url, active: true });
      if (tab.id !== undefined) await watchPage('tab', tab.id);
    } else {
      const created = await openCentredPopup(url, 500, page === 'trial' ? 700 : 800);
      if (created?.id === undefined) return { opened: false, reason: 'Chrome couldn’t open the window. Try again.' };
      await watchPage('window', created.id);
    }
  } catch {
    return { opened: false, reason: 'Chrome couldn’t open the page. Try again.' };
  }
  return { opened: true };
}

// ---------------------------------------------------------------------------------------------
// In the worker

/** Called once at the worker's top level: read the plan (at most hourly), pick up a page being watched. */
export function setupPlan(): void {
  // The key arrived from another computer through Chrome sync (or was created): read the plan.
  browser.storage.onChanged.addListener((changes, area) => {
    if ((area === 'sync' || area === 'local') && EXTPAY_KEY in changes) {
      refreshPlan({ force: true }).catch(() => undefined);
    }
  });
  (async () => {
    await refreshPlan({ maxAgeMs: STARTUP_READ_INTERVAL_MS });
    const watch = await getPageWatch();
    if (watch) schedulePoll(0);
  })().catch((error) => console.warn('[tabfold] plan setup failed', error));
}

/** chrome.alarms: the 6-hourly read and the trial's end. Returns false for other alarms. */
export function onPlanAlarm(name: string): boolean {
  if (name !== PLAN_ALARM && name !== TRIAL_END_ALARM) return false;
  refreshPlan({ force: true }).catch(() => undefined);
  return true;
}
