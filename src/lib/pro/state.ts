import { browser } from 'wxt/browser';
import type { SyncStatus } from '../state';
import { FREE_PLAN, type AiRuns, type MilestoneState, type PlanState, type ProjectsState, type Tier } from './types';

/** Pro state kept in chrome.storage.local, shared by the worker and the pages. */

const PLAN = 'plan';
const PLAN_ENDED = 'planEnded';
const CLOUD_SYNC_STATUS = 'cloudSyncStatus';
const MILESTONE = 'milestone';
const PROJECTS = 'projects';
const AI_RUNS = 'aiRuns';

async function get<T>(key: string): Promise<T | undefined> {
  const result = await browser.storage.local.get(key);
  return result[key] as T | undefined;
}

function watch<T>(key: string, callback: (value: T | undefined) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && key in changes) callback(changes[key]!.newValue as T | undefined);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

function item<T>(key: string) {
  return {
    get: () => get<T>(key),
    set: (value: T | null) => (value === null ? browser.storage.local.remove(key) : browser.storage.local.set({ [key]: value })),
    watch: (callback: (value: T | undefined) => void) => watch<T>(key, callback),
  };
}

/** The plan as last read from ExtensionPay (refreshed by the worker). Free until known. */
export const planState = {
  ...item<PlanState>(PLAN),
  get: async () => (await get<PlanState>(PLAN)) ?? FREE_PLAN,
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
