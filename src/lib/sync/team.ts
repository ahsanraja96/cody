import { browser } from 'wxt/browser';
import { checkWiped } from '../dataGuard';
import { db } from '../db';
import { api, ProError, type ApiRequest } from '../pro/api';
import { proConfigured } from '../pro/config';
import { planState, TEAM_SYNC_STATE_KEY, teamGone } from '../pro/state';
import { getDeviceId } from '../state';
import type { SyncDeps, SyncFailure, SyncScope } from './engine';
import { cloudSyncArea, describeCloudError, type CloudSyncArea } from './cloud';
import { defaultSyncState, type SyncLocalState, type SyncStateStore } from './localState';
import { CLOUD_LIMITS } from './records';

/**
 * Sync of a team's folders (Teams): the same engine, format and limits as the Tabfold account
 * (./cloud.ts), against the team's own copy on the server (`GET /team/sync`, `POST /team/sync`,
 * server/API.md "Teams"). It carries only the team's folders (`FolderRecord.teamId`) and the tabs in
 * the team's fold, each saying who added it (record field [9]). It runs while the plan says this
 * account is in a team (`PlanState.team`): at worker start, every 2 minutes while a Tabfold page is
 * open and when one comes into focus (`team-sync-now`), and soon after a change here.
 */

export interface TeamRef {
  id: string;
  name: string;
}

interface StoredTeamState {
  teamId: string;
  state: SyncLocalState;
}

function readStored(value: unknown): StoredTeamState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<StoredTeamState>;
  return typeof v.teamId === 'string' && v.state && typeof v.state === 'object' ? (v as StoredTeamState) : null;
}

/** What this computer remembers about one team's copy (another team's, or none: a fresh start). */
export function teamSyncState(teamId: () => Promise<string | null>): SyncStateStore {
  return {
    async get() {
      const id = await teamId();
      const stored = readStored((await browser.storage.local.get(TEAM_SYNC_STATE_KEY))[TEAM_SYNC_STATE_KEY]);
      return stored && id && stored.teamId === id ? { ...defaultSyncState(), ...stored.state } : defaultSyncState();
    },
    async set(state) {
      const id = await teamId();
      if (id) await browser.storage.local.set({ [TEAM_SYNC_STATE_KEY]: { teamId: id, state } satisfies StoredTeamState });
    },
  };
}

/**
 * Forget what this computer knew about a team's copy (after "Clear everything" emptied the list,
 * or the team's folders left this computer), so the next run reads it afresh and never takes the
 * missing tabs for removals. A run already going notices and doesn't write.
 */
export async function forgetTeamSyncState(now = Date.now()): Promise<void> {
  const stored = readStored((await browser.storage.local.get(TEAM_SYNC_STATE_KEY))[TEAM_SYNC_STATE_KEY]);
  if (!stored) return;
  await browser.storage.local.set({ [TEAM_SYNC_STATE_KEY]: { teamId: stored.teamId, state: { ...defaultSyncState(), epoch: now } } });
}

/** The team this computer syncs now: in the plan, signed in, and not waiting on "You’re no longer in …". */
export async function currentTeam(): Promise<TeamRef | null> {
  if (!proConfigured()) return null;
  const plan = await planState.get();
  if (!plan.email || !plan.team) return null;
  if ((await teamGone.get()).some((g) => g.teamId === plan.team!.id)) return null;
  return { id: plan.team.id, name: plan.team.name };
}

/** How a failed request to the team's copy reads in its status. */
export function describeTeamError(error: unknown): SyncFailure {
  if (error instanceof ProError) {
    if (error.status === 404) return { message: 'You’re not in this team any more.', minDelayMs: 15 * 60_000, shrink: false };
    if (error.status === 402) return { message: 'This team’s plan has ended.', minDelayMs: 15 * 60_000, shrink: false };
    if (error.status === 413) return { message: 'The team’s folders are full. Trying again with fewer tabs.', minDelayMs: 60_000, shrink: true };
    if (error.status !== 409 && error.code !== 'offline' && error.code !== 'not-signed-in') {
      return { message: 'Couldn’t sync the team’s folders. Trying again later.', minDelayMs: 0, shrink: false };
    }
  }
  const failure = describeCloudError(error);
  return error instanceof ProError && error.code === 'offline'
    ? { ...failure, message: 'Can’t reach Tabfold for the team’s folders. Trying again soon.' }
    : failure;
}

/**
 * The team's items on the server: `/team/sync` with versions, like the account's copy.
 * `onGone` runs when the server says this account isn't in the team (404) or its plan has ended
 * (402): the plan is read again, and the team's folders may leave this computer.
 */
export function teamSyncArea(request: ApiRequest = api, onGone?: () => void): CloudSyncArea {
  const path = '/team/sync';
  const area = cloudSyncArea(async <T>(p: string, init?: Parameters<ApiRequest>[1]) => {
    try {
      return await request<T>(p === '/sync' ? path : p, init);
    } catch (error) {
      if (error instanceof ProError && (error.status === 404 || error.status === 402 || error.status === 401)) onGone?.();
      throw error;
    }
  });
  return Object.assign(area, { label: 'your team', describeError: describeTeamError });
}

/** The team's scope: its folders and the tabs in its fold, with who added them. */
export function teamScope(team: TeamRef): SyncScope {
  return { team: { id: team.id, name: team.name } };
}

let goneListener: (() => void) | null = null;

/** The worker says what to do when the server says the team is gone (src/lib/background/teams.ts). */
export function onTeamGone(listener: (() => void) | null): void {
  goneListener = listener;
}

export function teamSyncDeps(): SyncDeps {
  // One run, one team: read once per run.
  let team: Promise<TeamRef | null> | undefined;
  const current = () => (team ??= currentTeam());
  return {
    database: db,
    area: teamSyncArea(api, () => goneListener?.()),
    store: teamSyncState(async () => (await current())?.id ?? null),
    deviceId: getDeviceId,
    enabled: async () => !!(await current()),
    isWiped: async () => (await checkWiped(db)).wiped,
    now: () => Date.now(),
    limits: CLOUD_LIMITS,
    scope: async () => {
      const ref = await current();
      return ref ? teamScope(ref) : null;
    },
  };
}
