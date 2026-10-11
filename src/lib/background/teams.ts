import { browser } from 'wxt/browser';
import { db } from '../db';
import { CommandError, type Command, type CommandResults } from '../messages';
import { ProError } from '../pro/api';
import { proConfigured } from '../pro/config';
import { refreshPlan } from '../pro/plan';
import { planState, teamDetails, teamGone } from '../pro/state';
import { cancelInvite, fetchTeam, inviteToTeam, leaveTeam, parseInviteEmails, removeMember, renameTeam } from '../pro/team';
import type { PlanState, TeamDetails, TeamGone } from '../pro/types';
import { getDeviceId } from '../state';
import { teamSyncNow } from '../sync/engine';
import { forgetTeamSyncState, onTeamGone } from '../sync/team';
import { keepTeamCopy, localTeams, purgeTeam, takeTeamOut } from '../teamFolders';
import { teamSessionName } from '../teams';

/**
 * Teams in the worker (Mx-Share): the team's details for Settings (`team-get`, cached for the
 * pages' avatars), renaming, inviting, cancelling invitations, removing people and leaving, syncing
 * the team's folders on demand, and what happens on this computer when the person is no longer in
 * the team: its folders leave the list and the full list asks once ("Keep a copy" or let them go).
 */

export type TeamCommand = Extract<
  Command,
  {
    type:
      | 'team-get'
      | 'team-rename'
      | 'team-invite'
      | 'team-cancel-invite'
      | 'team-remove'
      | 'team-leave'
      | 'team-sync-now'
      | 'team-keep-copy'
      | 'team-gone-dismiss';
  }
>;

export async function handleTeamCommand(command: TeamCommand): Promise<CommandResults[TeamCommand['type']]> {
  switch (command.type) {
    case 'team-get':
      return getTeam();
    case 'team-rename':
      return rename(command.name);
    case 'team-invite':
      return invite(command.emails);
    case 'team-cancel-invite':
      await requireTeam();
      await cancelInvite(command.email);
      await getTeam().catch(() => undefined);
      return { ok: true };
    case 'team-remove':
      await requireTeam();
      await removeMember(command.memberId);
      await afterSeatsChange();
      return { ok: true };
    case 'team-leave':
      return leave();
    case 'team-sync-now':
      return (await requireTeamQuietly()) ? teamSyncNow(command.background !== true) : { ok: false };
    case 'team-keep-copy':
      return keepCopy(command.teamId);
    case 'team-gone-dismiss':
      return dismissGone(command.teamId);
  }
}

/** Signed in and in a team (as the stored plan says), or a CommandError the pages can show. */
async function requireTeam(): Promise<PlanState & { team: NonNullable<PlanState['team']> }> {
  if (!proConfigured()) throw new ProError('not-configured');
  let plan = await planState.get();
  if (!plan.team) plan = await refreshPlan({ force: true });
  if (!plan.email) throw new ProError('not-signed-in');
  if (!plan.team) throw new ProError('not-in-team');
  return plan as PlanState & { team: NonNullable<PlanState['team']> };
}

async function requireTeamQuietly(): Promise<boolean> {
  if (!proConfigured()) return false;
  const plan = await planState.get();
  return !!plan.email && !!plan.team;
}

/** `GET /team`, kept for the pages (the left column's and folders' avatars). */
export async function getTeam(now = Date.now()): Promise<TeamDetails> {
  await requireTeam();
  try {
    const details = await fetchTeam();
    await teamDetails.set({ ...details, at: now });
    // The team's plan has ended (or this is another team now): the plan says so too.
    const plan = await planState.get();
    if (details.team.status === 'ended' || plan.team?.id !== details.team.id || plan.team?.name !== details.team.name) {
      void refreshPlan({ force: true }).catch(() => undefined);
    }
    return details;
  } catch (error) {
    if (error instanceof ProError && error.code === 'not-in-team') {
      await teamDetails.set(null);
      void afterGoneSignal();
    }
    throw error;
  }
}

async function rename(name: string): Promise<{ team: TeamDetails['team'] }> {
  const plan = await requireTeam();
  const clean = Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, 60).join('').trim();
  if (!clean) throw new CommandError('Give the team a name.', 'invalid-name');
  const team = await renameTeam(clean);
  const cached = await teamDetails.get();
  if (cached) await teamDetails.set({ ...cached, team });
  await planState.set({ ...plan, team: { ...plan.team, name: team.name } });
  await renameTeamFold(team.id, team.name);
  return { team };
}

/** The team's fold follows the team's name ("Team · Truewidgets"). */
async function renameTeamFold(teamId: string, name: string): Promise<void> {
  const deviceId = `team:${teamId}`;
  await db.transaction('rw', db.sessions, async () => {
    const sessions = await db.sessions.filter((s) => s.deviceId === deviceId && !s.deletedAt).toArray();
    for (const session of sessions) if (session.name !== teamSessionName(name)) await db.sessions.put({ ...session, name: teamSessionName(name) });
  });
}

async function invite(emails: string[]): Promise<{ invited: number }> {
  await requireTeam();
  const parsed = parseInviteEmails(emails.join(','));
  if (!parsed.ok) throw new CommandError(parsed.message, 'invalid-email');
  const result = await inviteToTeam(parsed.emails);
  await getTeam().catch(() => undefined);
  return result;
}

/** Seats follow people: the plan (and the team's details) read again. */
async function afterSeatsChange(): Promise<void> {
  await getTeam().catch(() => undefined);
  await refreshPlan({ force: true }).catch(() => undefined);
}

async function leave(): Promise<{ ok: true }> {
  const plan = await requireTeam();
  if (plan.team.role === 'owner') {
    throw new CommandError('You own this team, so you can’t leave it. To stop, cancel the plan in Manage billing.', 'owner-cant-leave');
  }
  await leaveTeam();
  await teamDetails.set(null);
  await refreshPlan({ force: true }).catch(() => undefined);
  await checkTeams({ reason: 'left' });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// No longer in the team

let checking: Promise<void> | null = null;

/**
 * Compare the teams this computer has folders from with the plan. Signed out: they leave quietly
 * (they come back with the team's copy when the person signs in again). Signed in and no longer in
 * one (left, removed, or its plan ended): its folders leave the list and the full list asks once.
 * Back in a team whose folders were waiting on that question: the question goes, and so do they
 * (the team's copy brings them back).
 */
export function checkTeams(options: { reason?: TeamGone['reason']; now?: number } = {}): Promise<void> {
  checking ??= (async () => {
    try {
      await runCheck(options);
    } finally {
      checking = null;
    }
  })();
  return checking;
}

async function runCheck(options: { reason?: TeamGone['reason']; now?: number }): Promise<void> {
  const now = options.now ?? Date.now();
  const plan = await planState.get();
  // Not read from the server yet: nothing to go by.
  if (plan.checkedAt === 0 && !plan.email) return;
  const gone = await teamGone.get();
  const current = plan.email ? (plan.team?.id ?? null) : null;

  // Back in a team that was waiting on "You’re no longer in …".
  if (current && gone.some((g) => g.teamId === current)) {
    await purgeTeam(current);
    await teamGone.set(gone.filter((g) => g.teamId !== current));
    await forgetTeamSyncState(now);
  }

  const local = await localTeams();
  for (const [teamId, info] of local) {
    if (teamId === current) continue;
    if (!plan.email) {
      await purgeTeam(teamId);
      await forgetTeamSyncState(now);
      continue;
    }
    let reason: TeamGone['reason'] = options.reason ?? 'left';
    let name = info.name;
    if (!options.reason) {
      try {
        const details = await fetchTeam();
        if (details.team.id === teamId && details.team.status === 'ended') {
          reason = 'ended';
          name = details.team.name;
        }
      } catch (error) {
        // Offline or the server failing: decide next time.
        if (!(error instanceof ProError) || error.code !== 'not-in-team') return;
      }
    }
    const taken = await takeTeamOut(teamId, now);
    await forgetTeamSyncState(now);
    const list = (await teamGone.get()).filter((g) => g.teamId !== teamId);
    list.push({ teamId, name: name || 'your team', reason, at: now, folders: taken.folders, tabs: taken.tabs });
    await teamGone.set(list);
    const cached = await teamDetails.get();
    if (cached?.team.id === teamId) await teamDetails.set(null);
  }
}

async function keepCopy(teamId: string): Promise<{ folders: number; tabs: number }> {
  const list = await teamGone.get();
  const entry = list.find((g) => g.teamId === teamId);
  if (!entry) throw new CommandError('Those folders are no longer on this computer.', 'not-found');
  const result = await keepTeamCopy(teamId, { name: entry.name, deviceId: await getDeviceId(), since: entry.at });
  await teamGone.set((await teamGone.get()).filter((g) => g.teamId !== teamId));
  return result;
}

async function dismissGone(teamId: string): Promise<{ ok: true }> {
  await purgeTeam(teamId);
  await teamGone.set((await teamGone.get()).filter((g) => g.teamId !== teamId));
  return { ok: true };
}

/** The server said "not in this team" or "its plan ended": read the plan again, then compare. */
async function afterGoneSignal(): Promise<void> {
  await refreshPlan({ force: true }).catch(() => undefined);
  await checkTeams();
}

/** After 30 days unanswered, the question goes: the team's rows went with Trash and old folders anyway. */
const GONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function pruneGone(now = Date.now()): Promise<void> {
  const list = await teamGone.get();
  const kept = list.filter((g) => g.at > now - GONE_TTL_MS);
  if (kept.length === list.length) return;
  for (const g of list) if (!kept.includes(g)) await purgeTeam(g.teamId);
  await teamGone.set(kept);
}

function safely(label: string, task: () => Promise<unknown>): void {
  task().catch((error) => console.error(`[tabfold] ${label} failed`, error instanceof ProError ? error.code : error));
}

/**
 * Called once at the worker's top level: the plan changing (joined, left, removed, signed out, the
 * team's plan ended) is followed, and the team's sync saying "not in this team" is too.
 */
export function setupTeams(): void {
  onTeamGone(() => safely('team check', afterGoneSignal));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('plan' in changes)) return;
    const change = changes.plan as { oldValue?: unknown; newValue?: unknown };
    const key = (value: unknown) => {
      const v = value as { email?: string | null; team?: { id?: string } | null } | undefined;
      return `${v?.email ?? ''}|${v?.team?.id ?? ''}`;
    };
    if (key(change.oldValue) !== key(change.newValue)) safely('team check', () => checkTeams());
  });
  safely('team check', async () => {
    await pruneGone();
    await checkTeams();
  });
}
