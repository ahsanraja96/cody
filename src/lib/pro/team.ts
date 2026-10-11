import { api, ProError, type ApiRequest } from './api';
import { readTeam } from './state';
import type { TeamDetails, TeamInvite, TeamMember, TeamStatus, TeamSummary } from './types';

/**
 * The Teams routes of the Tabfold server (server/API.md "Teams"), typed. Every request carries this
 * computer's device token, as for Pro. The server says 404 when the account is in no team and 403
 * when someone who isn't the owner asks for an owner's route: those become `not-in-team` and
 * `owner-only`, with a message people can read. Nothing here logs emails.
 */

/** Emails invited at a time (the server takes at most 20). */
export const MAX_INVITES = 20;

const STATUSES: readonly TeamStatus[] = ['active', 'past_due', 'ended'];

function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readMember(value: unknown): TeamMember | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || typeof v.email !== 'string' || !v.email) return null;
  return { id: v.id, email: v.email.toLowerCase(), role: v.role === 'owner' ? 'owner' : 'member', joinedAt: time(v.joinedAt) };
}

function readInvite(value: unknown): TeamInvite | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.email !== 'string' || !v.email) return null;
  return { email: v.email.toLowerCase(), invitedAt: time(v.invitedAt) };
}

/** `team` as the server sent it, with its status (read as active when it says nothing). */
export function readTeamSummary(value: unknown): TeamSummary | null {
  const team = readTeam(value);
  if (!team) return null;
  const status = (value as { status?: unknown }).status;
  return { ...team, status: STATUSES.includes(status as TeamStatus) ? (status as TeamStatus) : 'active' };
}

/** `GET /team`'s answer, checked; null when it isn't one. */
export function readTeamDetails(value: unknown): TeamDetails | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const team = readTeamSummary(v.team);
  if (!team) return null;
  const members = (Array.isArray(v.members) ? v.members : []).map(readMember).filter((m): m is TeamMember => !!m);
  const invites = (Array.isArray(v.invites) ? v.invites : []).map(readInvite).filter((i): i is TeamInvite => !!i);
  return { team, members, invites };
}

/** A team route's failure, in the words people see. */
export function teamError(error: unknown): unknown {
  if (!(error instanceof ProError)) return error;
  if (error.status === 403) return new ProError('owner-only', undefined, 403, error.body);
  if (error.status === 404) return new ProError('not-in-team', undefined, 404, error.body);
  return error;
}

async function call<T>(request: ApiRequest, path: string, init?: Parameters<ApiRequest>[1]): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (error) {
    throw teamError(error);
  }
}

/** `GET /team`: the team, its people (owner first) and its open invitations. */
export async function fetchTeam(request: ApiRequest = api): Promise<TeamDetails> {
  const details = readTeamDetails(await call<unknown>(request, '/team'));
  if (!details) throw new ProError('server', 'Tabfold’s server sent an unexpected answer.');
  return details;
}

/** `PATCH /team` (owner): a new name, at most 60 characters. */
export async function renameTeam(name: string, request: ApiRequest = api): Promise<TeamSummary> {
  const answer = await call<{ team?: unknown }>(request, '/team', { method: 'PATCH', body: { name } });
  const team = readTeamSummary(answer?.team);
  if (!team) throw new ProError('server', 'Tabfold’s server sent an unexpected answer.');
  return team;
}

/** `POST /team/invites` (owner): emails each address an invitation. How many were new. */
export async function inviteToTeam(emails: string[], request: ApiRequest = api): Promise<{ invited: number }> {
  const answer = await call<{ invited?: unknown }>(request, '/team/invites', { method: 'POST', body: { emails } });
  return { invited: typeof answer?.invited === 'number' ? answer.invited : 0 };
}

/** `DELETE /team/invites/<email>` (owner). Fine when there was no such invitation. */
export async function cancelInvite(email: string, request: ApiRequest = api): Promise<void> {
  await call(request, `/team/invites/${encodeURIComponent(email.trim().toLowerCase())}`, { method: 'DELETE' });
}

/** `DELETE /team/members/<id>` (owner; not themself). */
export async function removeMember(memberId: string, request: ApiRequest = api): Promise<void> {
  await call(request, `/team/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
}

/** `POST /team/leave` (a member who isn't the owner). */
export async function leaveTeam(request: ApiRequest = api): Promise<void> {
  await call(request, '/team/leave', { method: 'POST' });
}

// ---------------------------------------------------------------------------------------------
// The invite field

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export type InviteParse =
  | { ok: true; emails: string[] }
  | { ok: false; reason: 'empty' | 'invalid' | 'too-many'; message: string; invalid?: string };

/**
 * The invite field's text as emails: separated by commas, semicolons, spaces or new lines; trimmed,
 * lower-cased, each once ("<sara@x.com>" is read as sara@x.com).
 */
export function parseInviteEmails(text: string): InviteParse {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim().replace(/^<+|>+$/g, '').toLowerCase())
    .filter(Boolean);
  const emails: string[] = [];
  for (const part of parts) {
    if (!EMAIL.test(part)) {
      return { ok: false, reason: 'invalid', invalid: part, message: `“${part.slice(0, 60)}” doesn’t look like an email address.` };
    }
    if (!emails.includes(part)) emails.push(part);
  }
  if (emails.length === 0) return { ok: false, reason: 'empty', message: 'Add an email address first.' };
  if (emails.length > MAX_INVITES) return { ok: false, reason: 'too-many', message: `Invite up to ${MAX_INVITES} people at a time.` };
  return { ok: true, emails };
}
