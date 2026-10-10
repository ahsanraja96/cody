import type { Browser } from 'wxt/browser';
import { isPlaceholderTitle, rawTabUrl } from '../capture';
import { db } from '../db';
import { fillTabTitle } from '../repo';
import { pendingTitles } from '../state';
import { capUrl, dedupeKey, displayHost } from '../urls';

/**
 * Tabs saved while their page was still loading (kept open) were given their host as a title. The
 * worker remembers browser tab id -> saved tab id and fills the real title in when Chrome reports
 * it. Only the worker writes this map, so a copy is kept in memory for the life of the worker.
 */

let cache: Record<string, string> | undefined;

async function load(): Promise<Record<string, string>> {
  cache ??= await pendingTitles.get();
  return cache;
}

async function save(next: Record<string, string>): Promise<void> {
  cache = next;
  await pendingTitles.set(next);
}

export async function rememberPendingTitles(entries: Array<[browserTabId: number, savedTabId: string]>): Promise<void> {
  if (entries.length === 0) return;
  const next = { ...(await load()) };
  for (const [tabId, savedId] of entries) next[tabId] = savedId;
  await save(next);
}

export async function forgetPendingTitle(tabId: number): Promise<void> {
  const current = await load();
  if (!(tabId in current)) return;
  const next = { ...current };
  delete next[tabId];
  await save(next);
}

/**
 * tabs.onUpdated: store the real title of a pending tab once it arrives. Pages that set their title
 * from a script after loading are covered too: the tab is remembered until it closes or leaves
 * the site, and until then its address stands in for the title.
 */
export async function onTabUpdated(tabId: number, change: Browser.tabs.OnUpdatedInfo, tab: Browser.tabs.Tab): Promise<void> {
  if (change.title === undefined && change.status !== 'complete') return;
  const current = await load();
  const savedId = current[tabId];
  if (!savedId) return;

  const record = await db.tabs.get(savedId);
  const url = capUrl(rawTabUrl(tab)).url;
  // Gone (undone or deleted), or the tab went somewhere else entirely (a redirect on the same site is fine).
  if (!record || (url && dedupeKey(url) !== dedupeKey(record.url) && displayHost(url) !== displayHost(record.url))) {
    await forgetPendingTitle(tabId);
    return;
  }
  const title = (change.title ?? tab.title ?? '').trim();
  if (isPlaceholderTitle(title, rawTabUrl(tab) || record.url)) return;
  await fillTabTitle(savedId, title);
  await forgetPendingTitle(tabId);
}

/** For tests: drop the in-memory copy so the next call reads storage again. */
export function resetTitleCache(): void {
  cache = undefined;
}
