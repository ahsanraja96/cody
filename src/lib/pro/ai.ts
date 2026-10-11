import { markdownLink } from '../exporters';
import type { AskMatch } from '../messages';
import type { FolderRecord, TabGroupColor, TabRecord } from '../types';
import { displayHost } from '../urls';
import { AI_MAX_TABS, AI_MAX_TITLE, AI_RUNS_PER_MONTH, type AiGroup, type AiRuns, type AiTab } from './types';

/**
 * Pro AI, the parts that don't need a browser: what is sent (titles and sites only, never pages;
 * never Incognito tabs; the newest 300; titles cut to 200 characters), the colours projects get,
 * and the Markdown "Copy as context" produces.
 */

/** Projects get Chrome tab group colours in this order (never grey, which reads as "Other"). */
export const PROJECT_COLORS: readonly TabGroupColor[] = ['blue', 'purple', 'yellow', 'green', 'pink', 'cyan', 'orange', 'red'];

/** Cut to `max` characters without splitting one in half. */
export function cutText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return Array.from(clean).slice(0, max).join('').trimEnd();
}

/** A folded tab as the AI sees it: its id, title (≤ 200 characters) and site. */
export function toAiTab(tab: Pick<TabRecord, 'id' | 'title' | 'url'>): AiTab {
  const host = displayHost(tab.url);
  return { id: tab.id, title: cutText(tab.title || host, AI_MAX_TITLE), host };
}

/** Newest first; ties by id, so the same list always sends the same tabs. */
function newestFirst(a: Pick<TabRecord, 'id' | 'savedAt'>, b: Pick<TabRecord, 'id' | 'savedAt'>): number {
  return b.savedAt - a.savedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** What Organise sends: the newest 300 folded tabs that aren't from Incognito. The rest are counted. */
export function pickTabsForAi(tabs: TabRecord[], max = AI_MAX_TABS): { sent: AiTab[]; notSent: number } {
  const eligible = tabs.filter((t) => !t.incognito).sort(newestFirst);
  const sent = eligible.slice(0, max).map(toAiTab);
  return { sent, notSent: tabs.length - sent.length };
}

/**
 * The AI's projects, checked and coloured: only ids that were sent, each tab in one project at most,
 * no empty or unnamed projects, names cut to 32 characters. Tabs sent but in no project are
 * `ungrouped` ("Everything else").
 */
export function colourGroups(
  raw: unknown,
  sentIds: string[],
): { groups: AiGroup[]; ungrouped: string[] } {
  const sent = new Set(sentIds);
  const used = new Set<string>();
  const names = new Set<string>();
  const groups: AiGroup[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, tabIds } = entry as { name?: unknown; tabIds?: unknown };
    if (typeof name !== 'string' || !Array.isArray(tabIds)) continue;
    const clean = cutText(name, 32);
    if (!clean || names.has(clean.toLowerCase())) continue;
    const ids = tabIds.filter((id): id is string => typeof id === 'string' && sent.has(id) && !used.has(id));
    if (ids.length === 0) continue;
    for (const id of ids) used.add(id);
    names.add(clean.toLowerCase());
    groups.push({ name: clean, color: PROJECT_COLORS[groups.length % PROJECT_COLORS.length]!, tabIds: ids });
  }
  return { groups, ungrouped: sentIds.filter((id) => !used.has(id)) };
}

/**
 * Organise fills folders: a group named like a folder that's already there (any case) goes into
 * it (`folderId`) and takes its colour; any other group will be a new folder.
 */
export function matchFolders(groups: AiGroup[], folders: Array<Pick<FolderRecord, 'id' | 'name' | 'color'>>): AiGroup[] {
  const byName = new Map<string, Pick<FolderRecord, 'id' | 'name' | 'color'>>();
  for (const folder of folders) {
    const key = folder.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, folder);
  }
  return groups.map((group) => {
    const folder = byName.get(group.name.trim().toLowerCase());
    return folder ? { ...group, folderId: folder.id, color: folder.color } : group;
  });
}

// ---- Ask your tabs (Pro AI) ----

const STOP_WORDS = new Set(
  'a an and are as at be by did do for from had has have i in is it its last me my of on or that the this to was week were what when where which who with you your'.split(' '),
);

/** The words of a question worth matching: lower case, two letters or more, common words left out. */
export function queryWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  return [...new Set(words)];
}

/** How well a tab's title and site match the words (0: not at all). */
export function askScore(tab: Pick<TabRecord, 'title' | 'url'>, words: string[]): number {
  if (words.length === 0) return 0;
  const title = tab.title.toLowerCase();
  const host = displayHost(tab.url).toLowerCase();
  let score = 0;
  for (const word of words) {
    if (title.includes(word)) score += 2;
    if (host.includes(word)) score += 1;
  }
  return score;
}

/**
 * What Ask sends: up to 300 tabs (never Incognito), those whose title or site match the question's
 * words first (best first), then the newest to fill. Titles and sites only.
 */
export function pickAskTabs(tabs: TabRecord[], query: string, max = AI_MAX_TABS): AiTab[] {
  const words = queryWords(query);
  const eligible = tabs.filter((t) => !t.incognito).sort(newestFirst);
  const scored = eligible.map((tab) => ({ tab, score: askScore(tab, words) })).filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || newestFirst(a.tab, b.tab));
  const picked = scored.slice(0, max).map((s) => s.tab);
  const ids = new Set(picked.map((t) => t.id));
  for (const tab of eligible) {
    if (picked.length >= max) break;
    if (!ids.has(tab.id)) picked.push(tab);
  }
  return picked.map(toAiTab);
}

/** The AI's answer to Ask, checked: only tabs that were sent, each once, at most 8, reasons ≤ 80 characters. */
export function readAskMatches(raw: unknown, sentIds: string[]): AskMatch[] {
  const sent = new Set(sentIds);
  const seen = new Set<string>();
  const matches: AskMatch[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, reason } = entry as { id?: unknown; reason?: unknown };
    if (typeof id !== 'string' || !sent.has(id) || seen.has(id)) continue;
    seen.add(id);
    matches.push({ tabRecordId: id, reason: typeof reason === 'string' ? cutText(reason, 80) : '' });
    if (matches.length >= 8) break;
  }
  return matches;
}

// ---- The weekly tidy-up (Pro AI) ----

export interface TidyGroup {
  /** "38 tabs about Lisbon", its number matching the tabs kept. */
  summary: string;
  /** An existing folder, or null for a new one named `folderName`. */
  folderId: string | null;
  folderName: string;
  tabIds: string[];
}

/**
 * The AI's tidy-up suggestions, checked: only tabs that were sent, each in one suggestion, at least
 * `min` tabs each, an existing folder only when it is one of `folders` (otherwise a new folder with
 * its name), at most 3.
 */
export function readTidyGroups(
  raw: unknown,
  sentIds: string[],
  folders: Array<Pick<FolderRecord, 'id' | 'name'>>,
  min = 2,
): TidyGroup[] {
  const sent = new Set(sentIds);
  const used = new Set<string>();
  const known = new Map(folders.map((f) => [f.id, f]));
  const groups: TidyGroup[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { summary, folderId, folderName, tabIds } = entry as Record<string, unknown>;
    if (!Array.isArray(tabIds)) continue;
    const ids = tabIds.filter((id): id is string => typeof id === 'string' && sent.has(id) && !used.has(id));
    if (ids.length < min) continue;
    const folder = typeof folderId === 'string' ? known.get(folderId) : undefined;
    const name = folder?.name ?? (typeof folderName === 'string' ? cutText(folderName, 60) : '');
    if (!name) continue;
    for (const id of ids) used.add(id);
    let text = typeof summary === 'string' ? cutText(summary, 80) : '';
    // The number the person reads is the number of tabs that will move.
    text = /^\d[\d,]*\s/.test(text) ? text.replace(/^\d[\d,]*/, String(ids.length)) : `${ids.length} tabs about ${name}`;
    groups.push({ summary: text, folderId: folder ? folder.id : null, folderName: name, tabIds: ids });
    if (groups.length >= 3) break;
  }
  return groups;
}

/** Start of next month (UTC), when AI runs start again. */
export function nextMonthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Runs as the server reported them, or null when the answer isn't usable. */
export function readRuns(value: unknown): AiRuns | null {
  if (!value || typeof value !== 'object') return null;
  const { used, limit, resetsAt } = value as Partial<AiRuns>;
  if (typeof used !== 'number' || typeof limit !== 'number' || typeof resetsAt !== 'number') return null;
  return { used, limit, resetsAt };
}

/** Before the server has said anything: none used this month. */
export function freshRuns(now: number): AiRuns {
  return { used: 0, limit: AI_RUNS_PER_MONTH, resetsAt: nextMonthStart(now) };
}

/** "Copy as context": `## Name`, the AI's summary (when there is one), then a link per tab. */
export function contextMarkdown(name: string, tabs: Array<{ title: string; url: string }>, summary?: string | null): string {
  const heading = `## ${name.replace(/\s+/g, ' ').trim() || 'Tabs'}`;
  const parts = [heading];
  const about = summary?.trim();
  if (about) parts.push(about);
  if (tabs.length) parts.push(tabs.map(markdownLink).join('\n'));
  return `${parts.join('\n\n')}\n`;
}
