import { browser } from 'wxt/browser';
import type { SyncStatus } from '../state';
import { FREE_PLAN, type AiRuns, type CheckoutState, type MilestoneState, type PlanState, type ProjectsState, type TeamDetails, type TeamGone, type TeamInfo, type Tier } from './types';

/** Pro state kept in extension storage, shared by the worker and the pages. */

const PLAN = 'plan';
const PLAN_ENDED = 'planEnded';
const CLOUD_SYNC_STATUS = 'cloudSyncStatus';
const MILESTONE = 'milestone';
const PROJECTS = 'projects';
const AI_RUNS = 'aiRuns';
const CHECKOUT = 'checkoutState';
const CHECKOUT_NOTICE = 'checkoutNotice';
const NEEDS_SIGN_IN = 'needsSignIn';
/** What this computer remembers about the Tabfold account's copy of the folded tabs (src/lib/sync/cloud.ts). */
export const CLOUD_SYNC_STATE_KEY = 'cloudSyncState';

type Area = 'local' | 'session';

async function get<T>(key: string, area: Area = 'local'): Promise<T | undefined> {
  const result = await browser.storage[area].get(key);
  return result[key] as T | undefined;
}

function watch<T>(key: string, callback: (value: T | undefined) => void, area: Area = 'local'): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, changed: string) => {
    if (changed === area && key in changes) callback(changes[key]!.newValue as T | undefined);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

function item<T>(key: string, area: Area = 'local') {
  return {
    get: () => get<T>(key, area),
    set: (value: T | null) => (value === null ? browser.storage[area].remove(key) : browser.storage[area].set({ [key]: value })),
    watch: (callback: (value: T | undefined) => void) => watch<T>(key, callback, area),
  };
}

const TIERS: readonly Tier[] = ['free', 'pro', 'pro-ai'];
const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A Teams plan as the server sent it (server/API.md "Teams"), or null. */
export function readTeam(value: unknown): TeamInfo | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || typeof v.name !== 'string') return null;
  if (v.role !== 'owner' && v.role !== 'member') return null;
  const seats = typeof v.seats === 'number' && Number.isFinite(v.seats) && v.seats > 0 ? Math.floor(v.seats) : 1;
  return { id: v.id, name: v.name.slice(0, 60), role: v.role, seats };
}

/**
 * A plan as the server sent it or as stored, checked field by field. Fields a plan stored by an
 * older version lacks read as their empty value (trialUsed false, renewsAt null), and such a plan
 * counts as never checked, so it is read again at once. Null when it isn't a plan at all.
 */
export function readPlan(value: unknown): PlanState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!TIERS.includes(v.tier as Tier)) return null;
  const trial = v.trial as { startedAt?: unknown; endsAt?: unknown } | null | undefined;
  const startedAt = time(trial?.startedAt);
  const endsAt = time(trial?.endsAt);
  return {
    tier: v.tier as Tier,
    trial: startedAt !== null && endsAt !== null ? { startedAt, endsAt } : null,
    trialUsed: v.trialUsed === true,
    email: typeof v.email === 'string' && v.email ? v.email : null,
    interval: v.interval === 'month' || v.interval === 'year' ? v.interval : null,
    status: v.status === 'active' || v.status === 'past_due' || v.status === 'canceled' ? v.status : null,
    cancelAt: time(v.cancelAt),
    renewsAt: time(v.renewsAt),
    checkedAt: 'renewsAt' in v ? (time(v.checkedAt) ?? 0) : 0,
    // Pro for life and Teams (0.6): only when present, so older plans read exactly as before.
    ...(v.lifetime === true ? { lifetime: true } : {}),
    ...(readTeam(v.team) ? { team: readTeam(v.team) } : {}),
  };
}

/** The plan as the server last said (refreshed by the worker). Free until known. */
export const planState = {
  get: async (): Promise<PlanState> => readPlan(await get(PLAN)) ?? FREE_PLAN,
  set: (value: PlanState | null) => (value === null ? browser.storage.local.remove(PLAN) : browser.storage.local.set({ [PLAN]: value })),
  watch: (callback: (value: PlanState | undefined) => void) => watch<unknown>(PLAN, (value) => callback(readPlan(value) ?? undefined)),
};

/** Set when a trial or paid plan ends, for the one-time "Your Pro AI trial has ended" notice. */
export const planEnded = item<{ at: number; tier: Exclude<Tier, 'free'>; wasTrial: boolean }>(PLAN_ENDED);

/** Sync with the Tabfold account (Pro): the same shape as Chrome sync's status. */
export const cloudSyncStatus = item<SyncStatus>(CLOUD_SYNC_STATUS);

export const milestoneState = item<MilestoneState>(MILESTONE);

/** AI projects for the By project view. */
export const projectsState = {
  ...item<ProjectsState>(PROJECTS),
  get: async () => (await get<ProjectsState>(PROJECTS)) ?? { projects: [], organisedAt: 0 },
};

/** AI runs this month, as the server last reported them. */
export const aiRuns = item<AiRuns>(AI_RUNS);

/** The Stripe Checkout tab Tabfold is watching (session storage: gone when the browser closes). */
export const checkoutState = item<CheckoutState>(CHECKOUT, 'session');

/** One-shot news for the pages about a checkout: the person closed it without paying. */
export const checkoutNotice = item<{ kind: 'closed'; at: number }>(CHECKOUT_NOTICE, 'session');

/**
 * A checkout this computer started was paid with an email that already had a Tabfold account
 * (`GET /me` → `needsSignIn`): the plan is on that account, and this computer signs in with a code
 * to use it. Set only while this computer isn't signed in.
 */
export const needsSignIn = item<{ email: string }>(NEEDS_SIGN_IN);

// ---- Teams (0.6) ----

/** What this computer remembers about its team's copy (src/lib/sync/team.ts), with the team's id. */
export const TEAM_SYNC_STATE_KEY = 'teamSyncState';

/** Sync of the team's folders: the same shape as Chrome sync's status. */
export const teamSyncStatus = item<SyncStatus>('teamSyncStatus');

/** The team as `GET /team` last said (its people for the avatars, open invitations), and when. */
export const teamDetails = item<TeamDetails & { at: number }>('teamDetails');

/** Teams whose folders were taken out of the list here, waiting for "Keep a copy" or dismiss. */
export const teamGone = {
  ...item<TeamGone[]>('teamGone'),
  get: async (): Promise<TeamGone[]> => {
    const value = await get<unknown>('teamGone');
    return Array.isArray(value) ? (value as TeamGone[]).filter((g) => !!g && typeof g.teamId === 'string') : [];
  },
};

/** Forget what this computer knew about the account's copy, so the next account sync starts fresh (signing out or in as someone else). */
export async function forgetCloudSyncState(): Promise<void> {
  await browser.storage.local.remove(CLOUD_SYNC_STATE_KEY);
}
