import { browser } from 'wxt/browser';
import { db } from '../db';
import { formatDay } from '../exporters';
import type { Command, CommandResults, FoldOutcome } from '../messages';
import { colourGroups, contextMarkdown, cutText, freshRuns, pickTabsForAi, readRuns, toAiTab } from '../pro/ai';
import { api, ProError } from '../pro/api';
import { proConfigured } from '../pro/config';
import { addFreed, dismissMilestone, monthKey } from '../pro/milestone';
import { focusCheckout, openBilling, openCheckout, type Source } from '../pro/checkout';
import { refreshPlan, signinFinish, signinStart, signOut, startTrial } from '../pro/plan';
import { aiRuns, milestoneState, planState, projectsState } from '../pro/state';
import { hasPro, hasProAi } from '../pro/tiers';
import { AI_MAX_TABS, type AiGroup, type AiRuns, type BackupInfo, type OrganiseResult, type PlanState } from '../pro/types';
import { getSessionGraph, listFoldedTabs, listLiveSessions, restoreRecords, setProjects, setSmartName } from '../repo';
import { updateSettings } from '../settings';
import { cloudSyncActive } from '../sync/cloud';
import { cloudSyncNow } from '../sync/engine';
import { CLOUD_LIMITS, unpack } from '../sync/records';
import { restoreWindows } from './restore';

/**
 * Pro and Pro AI in the worker: the plan, signing in and out, Stripe Checkout and billing tabs,
 * Organise with AI, Copy as context, smart fold names, daily backups, sync with the Tabfold
 * account, the memory milestone and "Reopen everything". Only tab titles and sites ever go to the
 * AI, never pages or Incognito tabs.
 */

type ProCommand = Extract<
  Command,
  {
    type:
      | 'plan-refresh'
      | 'checkout-open'
      | 'checkout-focus'
      | 'billing-open'
      | 'signin-start'
      | 'signin-finish'
      | 'trial-start'
      | 'signout'
      | 'ai-organise'
      | 'ai-apply'
      | 'ai-context'
      | 'backups-list'
      | 'backup-restore'
      | 'cloud-sync-now'
      | 'milestone-dismiss'
      | 'reopen-everything';
  }
>;

export async function handleProCommand(command: ProCommand, source: Source = {}): Promise<CommandResults[ProCommand['type']]> {
  switch (command.type) {
    case 'plan-refresh':
      return refreshPlan({ force: command.force === true });
    case 'checkout-open':
      return openCheckout(command.tier, command.interval, source);
    case 'checkout-focus':
      return focusCheckout();
    case 'billing-open':
      return openBilling({ flow: command.flow }, source);
    case 'signin-start':
      return signinStart(command.email, command.purpose);
    case 'signin-finish':
      return signinFinish(command.email, command.code, command.startTrial);
    case 'trial-start':
      return startTrial();
    case 'signout':
      return signOut();
    case 'ai-organise':
      return organise();
    case 'ai-apply':
      return applyProjects(command.groups);
    case 'ai-context':
      return copyAsContext(command.tabRecordIds, command.name);
    case 'backups-list':
      return listBackups();
    case 'backup-restore':
      return restoreBackup(command.day);
    case 'cloud-sync-now':
      return (await cloudSyncActive()) ? cloudSyncNow() : { ok: false };
    case 'milestone-dismiss':
      return dismissMilestoneNow();
    case 'reopen-everything':
      return reopenEverything();
  }
}

/** The plan includes this (reading it again first when the cached one says it doesn't), or a ProError. */
async function requirePlan(need: 'pro' | 'pro-ai'): Promise<PlanState> {
  if (!proConfigured()) throw new ProError('not-configured');
  const includes = (plan: PlanState) => (need === 'pro' ? hasPro(plan) : hasProAi(plan));
  let plan = await planState.get();
  if (!includes(plan)) plan = await refreshPlan({ force: true });
  if (!includes(plan)) throw new ProError(need === 'pro' ? 'needs-pro' : 'needs-pro-ai');
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Pro AI

/** The AI can take a while with 300 tabs. */
const AI_TIMEOUT_MS = 90_000;

async function storeRuns(value: unknown): Promise<AiRuns | null> {
  const runs = readRuns(value);
  if (runs) await aiRuns.set(runs);
  return runs;
}

/** Organise with AI: a preview of projects for the newest 300 folded tabs. Nothing changes yet. */
export async function organise(now = Date.now()): Promise<OrganiseResult> {
  await requirePlan('pro-ai');
  const { sent, notSent } = pickTabsForAi(await listFoldedTabs());
  if (sent.length === 0) {
    return { groups: [], ungrouped: [], notSent, runs: (await aiRuns.get()) ?? freshRuns(now) };
  }
  let answer: { groups?: unknown; runs?: unknown };
  try {
    answer = await api('/ai', { method: 'POST', body: { task: 'organise', tabs: sent }, timeoutMs: AI_TIMEOUT_MS });
  } catch (error) {
    // Used up: the server says how many, so the page can show when they start again.
    if (error instanceof ProError && error.code === 'runs-used-up') await storeRuns(error.body.runs);
    throw error;
  }
  const runs = (await storeRuns(answer?.runs)) ?? (await aiRuns.get()) ?? freshRuns(now);
  const { groups, ungrouped } = colourGroups(answer?.groups, sent.map((t) => t.id));
  return { groups, ungrouped, notSent, runs };
}

/** Keep the projects the person chose: tabs carry their project, and the list shows By project. */
export async function applyProjects(groups: AiGroup[], now = Date.now()): Promise<{ applied: number }> {
  const kept = groups.filter((g) => g.name.trim() && g.tabIds.length > 0);
  const { applied, projects: names } = await setProjects(kept);
  const colorOf = new Map<string, AiGroup['color']>();
  for (const group of kept) if (!colorOf.has(group.name.trim())) colorOf.set(group.name.trim(), group.color);
  const projects = names.map((name) => ({ name, color: colorOf.get(name) ?? 'blue' }));
  await projectsState.set({ projects, organisedAt: now });
  await updateSettings({ groupBy: 'project' });
  return { applied };
}

/** Copy as context: Markdown for Claude, ChatGPT or Cursor, with a short AI summary when it can have one. */
export async function copyAsContext(tabRecordIds: string[], name: string): Promise<{ markdown: string }> {
  const rows = (await db.tabs.bulkGet(tabRecordIds)).filter((t): t is NonNullable<typeof t> => !!t);
  let summary: string | null = null;
  const tabs = rows.filter((t) => !t.incognito).slice(0, AI_MAX_TABS).map(toAiTab);
  if (tabs.length && proConfigured() && hasProAi(await planState.get())) {
    try {
      const answer = await api<{ summary?: unknown }>('/ai', {
        method: 'POST',
        body: { task: 'context', name: cutText(name, 100), tabs },
        timeoutMs: AI_TIMEOUT_MS,
      });
      if (typeof answer?.summary === 'string') summary = answer.summary;
    } catch {
      // The links are still worth copying.
    }
  }
  return { markdown: contextMarkdown(name, rows, summary) };
}

/** A smart name for a fold that just finished (Pro AI). Quietly does nothing on any failure. */
export async function nameFold(sessionId: string): Promise<void> {
  if (!proConfigured() || !hasProAi(await planState.get())) return;
  const rows = await db.tabs.where('sessionId').equals(sessionId).toArray();
  const tabs = rows
    .filter((t) => !t.incognito)
    .sort((a, b) => a.order - b.order)
    .slice(0, AI_MAX_TABS)
    .map(toAiTab);
  if (tabs.length === 0) return;
  const answer = await api<{ name?: unknown }>('/ai', { method: 'POST', body: { task: 'name', tabs }, timeoutMs: AI_TIMEOUT_MS });
  if (typeof answer?.name === 'string') await setSmartName(sessionId, answer.name);
}

// ---------------------------------------------------------------------------------------------
// After a fold

/** Add a fold's freed memory to this month's total (for the occasional milestone line). */
export async function recordFreedMemory(bytes: number, now = Date.now()): Promise<void> {
  if (!(bytes > 0)) return;
  await milestoneState.set(addFreed(await milestoneState.get(), bytes, now));
}

/** When Tabfold first ran: no milestone in the first 3 days. Kept from the install time when known. */
export async function ensureMilestoneStart(now = Date.now()): Promise<void> {
  if (await milestoneState.get()) return;
  const installedAt = (await browser.storage.local.get('installedAt')).installedAt;
  const firstSeenAt = typeof installedAt === 'number' && installedAt > 0 && installedAt <= now ? installedAt : now;
  await milestoneState.set({ firstSeenAt, month: monthKey(now), freedBytes: 0, lastShownAt: 0, dismissedUntil: 0 });
}

async function dismissMilestoneNow(now = Date.now()): Promise<{ ok: boolean }> {
  const state = (await milestoneState.get()) ?? addFreed(undefined, 0, now);
  await milestoneState.set(dismissMilestone(state, now));
  return { ok: true };
}

/** Fire and forget, after every fold: the milestone total, and a smart name for Pro AI. */
export function afterFold(outcome: Pick<FoldOutcome, 'sessionId' | 'savedTabs' | 'freedBytes'>, now = Date.now()): Promise<void> {
  const tasks: Array<Promise<unknown>> = [recordFreedMemory(outcome.freedBytes, now)];
  if (outcome.sessionId && outcome.savedTabs > 0) tasks.push(nameFold(outcome.sessionId));
  return Promise.allSettled(tasks).then(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Backups (Pro)

function readBackups(value: unknown): BackupInfo[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (b): b is BackupInfo =>
      !!b &&
      typeof b === 'object' &&
      typeof (b as BackupInfo).day === 'string' &&
      typeof (b as BackupInfo).tabCount === 'number' &&
      typeof (b as BackupInfo).createdAt === 'number',
  );
}

export async function listBackups(): Promise<BackupInfo[]> {
  await requirePlan('pro');
  const answer = await api<{ backups?: unknown }>('/backups');
  return readBackups(answer?.backups);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Bring back the tabs in a daily backup that aren't in the list now, as one fold. Nothing is deleted. */
export async function restoreBackup(day: string): Promise<{ restored: number; sessionId: string | null }> {
  const match = DAY.exec(day);
  if (!match) throw new ProError('server', 'That backup doesn’t exist.');
  await requirePlan('pro');
  const answer = await api<{ items?: unknown }>(`/backups/${day}`);
  const items = answer?.items && typeof answer.items === 'object' ? (answer.items as Record<string, unknown>) : {};
  const { records } = unpack(items, CLOUD_LIMITS);
  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return restoreRecords(records, `Restored · ${formatDay(date, { year: false, utc: true })}`);
}

// ---------------------------------------------------------------------------------------------
// Reopen everything (before removing Tabfold)

/** Every live fold reopens as its windows, one fold after another: in the background, lazily. */
export async function reopenEverything(): Promise<{ opened: number; failed: number }> {
  // Oldest first, so the newest fold ends up in front.
  const sessions = (await listLiveSessions()).reverse();
  let opened = 0;
  let failed = 0;
  for (const session of sessions) {
    const graph = await getSessionGraph(session.id);
    if (!graph || graph.windows.length === 0) continue;
    const result = await restoreWindows(
      graph.windows.map((w) => ({
        name: w.name,
        bounds: w.bounds,
        state: w.state,
        focused: w.wasFocused,
        tabs: w.tabs,
        ...(w.incognito ? { incognito: true } : {}),
      })),
      { mode: 'original', lazy: true, background: true },
    );
    opened += result.opened;
    failed += result.failed.length;
  }
  return { opened, failed };
}
