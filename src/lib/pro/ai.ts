import { markdownLink } from '../exporters';
import type { TabGroupColor, TabRecord } from '../types';
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
