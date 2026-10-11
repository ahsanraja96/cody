import { browser } from 'wxt/browser';
import { db } from '../db';
import { addFolder, duplicateGroups, freeLimitsNow, listLiveFolders, setTabsFolder } from '../folders';
import { CommandError, type AskMatch, type Command, type CommandResults } from '../messages';
import { cutText, pickAskTabs, pickTabsForAi, readAskMatches, readTidyGroups } from '../pro/ai';
import { api } from '../pro/api';
import { proConfigured } from '../pro/config';
import { planState } from '../pro/state';
import { hasProAi } from '../pro/tiers';
import { listFoldedTabs, removeDuplicateCopies } from '../repo';
import { getSettings } from '../settings';
import { tidyState, type TidyState, type TidySuggestion } from '../state';
import type { TabRecord } from '../types';
import { requirePlan } from './pro';
import { recordChangeUndo } from './save';

/**
 * Ask your tabs and the weekly tidy-up (Mx-Ask board, Pro AI). Only titles and sites go to the AI,
 * never pages, and never tabs folded from Incognito.
 */
export type TidyCommand = Extract<Command, { type: 'ai-ask' | 'tidy-run' | 'tidy-apply' | 'tidy-dismiss' }>;

export async function handleTidyCommand(command: TidyCommand): Promise<CommandResults[TidyCommand['type']]> {
  switch (command.type) {
    case 'ai-ask':
      return askTabs(command.query);
    case 'tidy-run':
      return runTidy();
    case 'tidy-apply':
      return applyTidy(command.suggestionId);
    case 'tidy-dismiss':
      return dismissTidy();
  }
}

const AI_TIMEOUT_MS = 90_000;
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Ask your tabs

/**
 * Find folded tabs by what they're about: up to 300 likely ones (title and site words first, then
 * the newest) go to the AI with the question; it answers with the best few and why.
 */
export async function askTabs(query: string): Promise<{ matches: AskMatch[] }> {
  const question = cutText(query, 200);
  if (!question) return { matches: [] };
  await requirePlan('pro-ai');
  const sent = pickAskTabs(await listFoldedTabs(), question);
  if (sent.length === 0) return { matches: [] };
  const answer = await api<{ matches?: unknown }>('/ai', {
    method: 'POST',
    body: { task: 'ask', query: question, tabs: sent },
    timeoutMs: AI_TIMEOUT_MS,
  });
  return { matches: readAskMatches(answer?.matches, sent.map((t) => t.id)) };
}

// ---------------------------------------------------------------------------------------------
// The weekly tidy-up

/** Tabs not opened from Tabfold (or folded) for this long are offered to tidy away. */
export const TIDY_STALE_DAYS = 30;
/** Fewer stale tabs than this aren't worth asking about. */
const TIDY_MIN_TABS = 5;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function duplicatesSuggestion(tabs: TabRecord[]): TidySuggestion | null {
  const extras = duplicateGroups(tabs).flatMap((group) => group.slice(1));
  if (extras.length === 0) return null;
  return {
    id: 'duplicates',
    kind: 'duplicates',
    text: `${extras.length} ${plural(extras.length, 'tab is', 'tabs are')} the same page twice`,
    action: 'Remove duplicates',
    tabRecordIds: extras.map((t) => t.id),
  };
}

/**
 * This week's tidy-up: tabs nobody has opened in a month, grouped by the AI with where they belong
 * (an existing folder or a new one), and the same page folded twice. Stored in `tidyState` for the
 * card at the top of the list. `quiet` (the Monday alarm): an AI failure just leaves the AI part out.
 */
export async function runTidy(options: { quiet?: boolean; now?: number } = {}): Promise<TidyState> {
  const now = options.now ?? Date.now();
  await requirePlan('pro-ai');
  const tabs = await listFoldedTabs();
  const suggestions: TidySuggestion[] = [];

  const cutoff = now - TIDY_STALE_DAYS * DAY;
  const stale = tabs.filter((t) => !t.incognito && !t.folderId && !t.snoozeUntil && (t.lastOpenedAt ?? t.savedAt) < cutoff);
  if (stale.length >= TIDY_MIN_TABS) {
    const { sent } = pickTabsForAi(stale);
    const folders = await listLiveFolders();
    try {
      const answer = await api<{ suggestions?: unknown }>('/ai', {
        method: 'POST',
        body: { task: 'tidy', tabs: sent, folders: folders.map((f) => ({ id: f.id, name: f.name })) },
        timeoutMs: AI_TIMEOUT_MS,
      });
      readTidyGroups(answer?.suggestions, sent.map((t) => t.id), folders).forEach((group, index) => {
        suggestions.push({
          id: `fold-${index + 1}`,
          kind: 'fold-into',
          text: `${group.summary} haven’t been opened in a month`,
          action: group.folderId ? `Fold into ${group.folderName}` : `Make a folder ‘${group.folderName}’`,
          tabRecordIds: group.tabIds,
          ...(group.folderId ? { folderId: group.folderId } : {}),
          folderName: group.folderName,
        });
      });
    } catch (error) {
      if (!options.quiet) throw error;
    }
  }
  const duplicates = duplicatesSuggestion(tabs);
  if (duplicates) suggestions.push(duplicates);

  const state: TidyState = { at: now, suggestions };
  await tidyState.set(state);
  return state;
}

/** Undo for a suggestion done (the `undo` command); null when it can't be kept. */
async function undoable(change: Parameters<typeof recordChangeUndo>[0]): Promise<string | null> {
  try {
    return await recordChangeUndo(change);
  } catch {
    return null;
  }
}

/** Do one suggestion (with Undo); it leaves the card. */
export async function applyTidy(suggestionId: string): Promise<{ done: number; actionId: string | null }> {
  const state = await tidyState.get();
  const suggestion = state?.suggestions.find((s) => s.id === suggestionId);
  if (!state || !suggestion) throw new CommandError('This suggestion is no longer there.', 'not-found');
  let done = 0;
  let actionId: string | null = null;
  if (suggestion.kind === 'duplicates') {
    const rows = (await db.tabs.bulkGet(suggestion.tabRecordIds)).filter((t): t is TabRecord => !!t);
    if (rows.length) {
      const { removed, placements } = await removeDuplicateCopies([...new Set(rows.map((t) => t.url))]);
      done = removed.tabs.length;
      if (done) actionId = await undoable({ putBack: removed, patches: placements });
    }
  } else if (suggestion.kind === 'fold-into') {
    const live = await listLiveFolders();
    const name = suggestion.folderName ?? '';
    let folderId =
      live.find((f) => f.id === suggestion.folderId)?.id ?? live.find((f) => f.name.toLowerCase() === name.toLowerCase())?.id;
    const created: string[] = [];
    if (!folderId) {
      const folder = await addFolder({ name, source: 'ai' }, { unlimited: !(await freeLimitsNow()) });
      created.push(folder.id);
      folderId = folder.id;
    }
    const { moved, before } = await setTabsFolder(suggestion.tabRecordIds, folderId);
    done = moved;
    if (moved || created.length) actionId = await undoable({ patches: before, foldersMade: created });
  }
  await tidyState.set({ ...state, suggestions: state.suggestions.filter((s) => s.id !== suggestionId) });
  return { done, actionId };
}

/** "Not now": the card hides until next week's tidy-up. */
export async function dismissTidy(now = Date.now()): Promise<{ ok: true }> {
  const state = await tidyState.get();
  if (state) await tidyState.set({ ...state, dismissedAt: now });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Every Monday

export const TIDY_ALARM = 'tabfold-tidy';
const WEEK_MINUTES = 7 * 24 * 60;

/** Next Monday at 9:00 (local time), after `now`. */
export function nextMondayMorning(now: number): number {
  const date = new Date(now);
  date.setHours(9, 0, 0, 0);
  const daysAhead = (8 - date.getDay()) % 7;
  date.setDate(date.getDate() + daysAhead);
  if (date.getTime() <= now) date.setDate(date.getDate() + 7);
  return date.getTime();
}

/** The Monday alarm: Pro AI with the weekly tidy-up on works this week's out. Never throws. */
export async function onTidyAlarm(name: string, now = Date.now()): Promise<void> {
  if (name !== TIDY_ALARM) return;
  try {
    if (!proConfigured() || !hasProAi(await planState.get())) return;
    if (!(await getSettings()).tidyUp) return;
    const last = await tidyState.get();
    // A missed alarm fires at the next start: once a week is enough.
    if (last && now - last.at < 6 * DAY) return;
    await runTidy({ quiet: true, now });
  } catch (error) {
    console.warn('[tabfold] weekly tidy-up failed', (error as Error)?.message ?? error);
  }
}

/** Register the alarm's listener (at the worker's top level) and make sure the alarm exists. */
export function setupTidy(): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TIDY_ALARM) void onTidyAlarm(alarm.name);
  });
  void (async () => {
    if (!(await browser.alarms.get(TIDY_ALARM))) {
      await browser.alarms.create(TIDY_ALARM, { when: nextMondayMorning(Date.now()), periodInMinutes: WEEK_MINUTES });
    }
  })().catch((error) => console.warn('[tabfold] tidy-up alarm', error));
}
