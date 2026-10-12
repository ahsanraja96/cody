import { browser } from 'wxt/browser';
import { category, categorize, siteKey, type CategoryId, type SiteKinds } from '@/lib/categories';
import { CommandError, send } from '@/lib/messages';
import { FREE_LIMITS } from '@/lib/limits';
import type { FolderRecord, TabGroupColor, TabRecord } from '@/lib/types';
import { toast } from '@/ui/components/Toast';
import { commandProblem, foldOutcomeText, undoableToast } from '@/ui/openTabs';
import { formatSnoozeTime } from '@/ui/snooze';
import { openLibrary } from '@/lib/openLibrary';
import { putBackTabs, removeTabsWithSnapshot } from '@/lib/repo';

/**
 * What the side panel's controls do: each sends one command to the worker and says what happened
 * in a toast, with Undo when the worker gives an action id. Free limits say so and offer the plans.
 */

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function approx(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `~${Math.max(10, Math.round(mb / 10) * 10)} MB`;
  return `~${(mb / 1024).toFixed(1)} GB`;
}

/** A failed command: Free limits get their own words and Upgrade. */
export function problem(error: unknown): void {
  const code = error instanceof CommandError ? error.code : undefined;
  const upgrade = { label: 'Upgrade', onClick: () => void openLibrary('#/pro') };
  if (code === 'folder-limit') toast(`Free has ${FREE_LIMITS.folders} folders. Upgrade for as many as you like.`, { tone: 'error', action: upgrade });
  else if (code === 'snooze-limit') toast(`Free has ${FREE_LIMITS.snoozes} snoozed tabs at a time. Wake one, or upgrade.`, { tone: 'error', action: upgrade });
  else if (code === 'list-full')
    toast('Your free list is full. Make room in the full list, or upgrade.', { tone: 'error', action: { label: 'Make room', onClick: () => void openLibrary('#/room') } });
  else toast(commandProblem(error), { tone: 'error' });
}

/** Fold a window ("Fold", "Fold this window"), or some of its tabs, maybe into a folder. */
export async function fold(options: {
  windowId?: number;
  keepWindowOpen?: boolean;
  tabIds?: number[];
  intoFolderId?: string;
  newFolderName?: string;
}): Promise<boolean> {
  try {
    const outcome = await send({ type: 'fold', ...options });
    if (outcome.savedTabs === 0 && outcome.closedTabs === 0 && outcome.skippedDuplicates === 0) {
      toast('Nothing to fold. Only pinned, playing or new tab pages are open.');
      return false;
    }
    undoableToast(foldOutcomeText(outcome, outcome.freedBytes > 0 ? ` · freed ${approx(outcome.freedBytes)}` : ''), outcome.actionId);
    return true;
  } catch (error) {
    problem(error);
    return false;
  }
}

/** An open tab dropped on a kind of site: fold it, and move its site to that kind when it isn't. */
export async function foldTabToKind(tab: { id: number; url: string }, kind: CategoryId, siteKinds: SiteKinds): Promise<void> {
  const host = siteKey(tab.url);
  if (host && categorize(tab.url, siteKinds) !== kind) {
    await send({ type: 'site-kind-set', host, kind }).catch(() => undefined);
  }
  await fold({ tabIds: [tab.id], keepWindowOpen: true });
}

/** Folded tabs into a folder, or out of their folder (`folder` null). */
export async function moveTabs(tabs: TabRecord[], folder: FolderRecord | null, from?: FolderRecord | null): Promise<void> {
  if (!tabs.length) return;
  try {
    const { moved, actionId } = await send({ type: 'tabs-move', tabRecordIds: tabs.map((t) => t.id), folderId: folder?.id ?? null });
    const n = moved || tabs.length;
    undoableToast(folder ? `Moved ${plural(n, 'tab')} to ${folder.name}` : `Took ${plural(n, 'tab')} out of ${from?.name ?? 'the folder'}`, actionId);
  } catch (error) {
    problem(error);
  }
}

/** A folded tab dropped on a kind of site: out of its folder, its site moved to that kind. */
export async function moveTabToKind(tab: TabRecord, kind: CategoryId, siteKinds: SiteKinds): Promise<void> {
  const host = siteKey(tab.url);
  try {
    if (tab.folderId) await send({ type: 'tabs-move', tabRecordIds: [tab.id], folderId: null });
    if (host && categorize(tab.url, siteKinds) !== kind) {
      const { actionId } = await send({ type: 'site-kind-set', host, kind });
      undoableToast(`Moved ${host} to ${category(kind).name}. Its new tabs go there too.`, actionId);
    }
  } catch (error) {
    problem(error);
  }
}

export async function snoozeTabs(tabs: TabRecord[], until: number): Promise<void> {
  try {
    const { snoozed, actionId } = await send({ type: 'snooze', until, tabRecordIds: tabs.map((t) => t.id) });
    const when = formatSnoozeTime(until).replace(/^(Today|Tomorrow|Yesterday)/, (w) => w.toLowerCase());
    undoableToast(`Snoozed ${plural(snoozed || tabs.length, 'tab')} until ${when}`, actionId);
  } catch (error) {
    problem(error);
  }
}

export async function wakeTabs(tabs: TabRecord[]): Promise<void> {
  try {
    const { opened } = await send({ type: 'snooze-wake', tabRecordIds: tabs.map((t) => t.id) });
    toast(opened ? `Opened ${plural(opened, 'tab')} in the background` : 'Nothing to wake: it’s back already.');
  } catch (error) {
    problem(error);
  }
}

/** Open a folded tab in this window (it stays in the list). */
export async function openFolded(tab: TabRecord, active: boolean, windowId?: number): Promise<void> {
  try {
    const { opened, reason } = await send({ type: 'open-saved-tab', tabRecordId: tab.id, active, windowId });
    if (!opened) toast(reason ?? 'Chrome wouldn’t open this page.', { tone: 'error' });
    else if (!active) toast('Opened in a background tab. It stays in the list.');
  } catch (error) {
    problem(error);
  }
}

/** "Open all" on a folder or kind of site: a Chrome tab group of the same name and colour. */
export async function openAll(
  tabs: TabRecord[],
  group: { name: string; color: TabGroupColor; folderId?: string },
  windowId?: number,
): Promise<void> {
  try {
    const { opened, reason } = await send({
      type: 'open-tabs',
      tabRecordIds: tabs.map((t) => t.id),
      asGroup: { name: group.name, color: group.color },
      windowId,
      ...(group.folderId ? { folderId: group.folderId } : {}),
    });
    if (reason) toast(opened ? `Opened ${opened} of ${tabs.length} tabs. ${reason}` : reason, { tone: 'error' });
    else toast(group.folderId ? `Opened ${plural(opened, 'tab')} as a “${group.name}” tab group. They stay in the folder.` : `Opened ${plural(opened, 'tab')}. They stay in the list.`);
  } catch (error) {
    problem(error);
  }
}

/** × on a folded tab's menu: removed from the list, Undo for 10 seconds. */
export async function removeTabs(tabs: TabRecord[]): Promise<void> {
  try {
    const removed = await removeTabsWithSnapshot(tabs.map((t) => t.id));
    const message = `Removed ${plural(removed.tabs.length, 'tab')}`;
    toast(message, {
      duration: 10_000,
      countdown: true,
      announce: `${message}. Undo available for 10 seconds.`,
      action: { label: 'Undo', onClick: () => void putBackTabs(removed).catch(() => undefined) },
    });
  } catch (error) {
    problem(error);
  }
}

/** Close an open tab (× on its row). */
export function closeTab(tabId: number): void {
  void browser.tabs.remove(tabId).catch(() => undefined);
}
