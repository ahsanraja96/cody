import { browser } from 'wxt/browser';
import { create } from 'zustand';
import { resetDataGuard } from '@/lib/dataGuard';
import { exportCsv, exportFileName, exportHtml, exportJson, exportMarkdown } from '@/lib/exporters';
import { send } from '@/lib/messages';
import { PROFILE_KEY } from '@/lib/pro/account';
import { listLiveFolders } from '@/lib/folders';
import { clearAllData, exportGraphs, putBackTabs, removeTabsWithSnapshot, type RemovedTabs } from '@/lib/repo';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { lastAction, recoveryOffer, snapshotMirror, UNDO_WINDOW_MS } from '@/lib/state';
import type { FolderRecord, SessionGraph, SessionRecord, TabGroupColor, TabRecord } from '@/lib/types';
import { dismissToast, toast } from '@/ui/components/Toast';
import { copyText } from '@/ui/hooks';
import { errorCode, proErrorText } from '@/ui/pro';
import { count, foldTime } from './format';
import { goToPlans } from './router';
import { dropUndo, registerUndo } from './undo';

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------------------------
// Opening

/** Open a folded tab. It stays in the list. */
export async function openFolded(tab: TabRecord, active: boolean): Promise<void> {
  try {
    const { opened, reason } = await send({ type: 'open-saved-tab', tabRecordId: tab.id, active });
    if (!opened) toast(reason ?? 'Chrome would not open this page.', { tone: 'error' });
    else if (!active) toast('Opened in a background tab. It stays in the list.');
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

/** "Open all" on a group: the tabs open as one Chrome tab group in this window and stay in the list. */
export async function openGroup(tabs: TabRecord[], category: { name: string; color: TabGroupColor }): Promise<void> {
  try {
    const current = await browser.windows.getCurrent().catch(() => undefined);
    const { opened, reason } = await send({
      type: 'open-tabs',
      tabRecordIds: tabs.map((t) => t.id),
      asGroup: { name: category.name, color: category.color },
      windowId: current?.id,
    });
    if (reason) toast(opened ? `Opened ${opened} of ${tabs.length} tabs. ${reason}` : reason, { tone: 'error' });
    else toast(opened === tabs.length ? `Opened ${count(opened, 'tab')}. They stay in the list.` : `Opened ${opened} of ${tabs.length} tabs.`);
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

/** "Switch" on an open tab in search results. */
export async function switchToTab(tabId: number, windowId?: number): Promise<void> {
  try {
    await browser.tabs.update(tabId, { active: true });
    if (windowId !== undefined) await browser.windows.update(windowId, { focused: true });
  } catch {
    toast('That tab was closed.', { tone: 'error' });
  }
}

// ---------------------------------------------------------------------------------------------
// Removing, with Undo

export interface Removal {
  tab: TabRecord;
  removed: RemovedTabs;
  expiresAt: number;
}

/** Rows removed with ×: each shows "Removed … · Undo" in place for 10 seconds, then the list closes up. */
export const useRemovals = create<{ removals: Map<string, Removal>; set: (id: string, removal: Removal | null) => void }>((set) => ({
  removals: new Map(),
  set: (id, removal) =>
    set((s) => {
      const next = new Map(s.removals);
      if (removal) next.set(id, removal);
      else next.delete(id);
      return { removals: next };
    }),
}));

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export async function undoRemoval(tabId: string): Promise<void> {
  const removal = useRemovals.getState().removals.get(tabId);
  if (!removal) return;
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  dropUndo(`remove:${tabId}`);
  try {
    await putBackTabs(removal.removed);
    useRemovals.getState().set(tabId, null);
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

/** × on a row: removed at once, no question. */
export async function removeOne(tab: TabRecord): Promise<void> {
  try {
    const removed = await removeTabsWithSnapshot([tab.id]);
    const expiresAt = Date.now() + UNDO_WINDOW_MS;
    useRemovals.getState().set(tab.id, { tab, removed, expiresAt });
    registerUndo(`remove:${tab.id}`, () => void undoRemoval(tab.id), expiresAt);
    timers.set(
      tab.id,
      setTimeout(() => {
        timers.delete(tab.id);
        useRemovals.getState().set(tab.id, null);
      }, UNDO_WINDOW_MS),
    );
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

/** "Remove all N tabs" from a group's menu: no question, an Undo toast instead. */
export function removeGroup(tabs: TabRecord[]): Promise<void> {
  return removeWithUndo(tabs, (n) => `Removed ${count(n, 'tab')}`);
}

/** Delete on a Recent folds card: the fold's tabs leave the list, with the same Undo toast. */
export function deleteFold(fold: SessionRecord, tabs: TabRecord[]): Promise<void> {
  return removeWithUndo(
    tabs.filter((t) => t.sessionId === fold.id),
    (n) => `Deleted the fold from ${foldTime(fold.createdAt)} (${count(n, 'tab')})`,
  );
}

async function removeWithUndo(tabs: TabRecord[], describe: (removed: number) => string): Promise<void> {
  try {
    const removed = await removeTabsWithSnapshot(tabs.map((t) => t.id));
    const key = `remove-group:${Date.now()}`;
    let toastId = 0;
    const undo = () => {
      dropUndo(key);
      dismissToast(toastId);
      putBackTabs(removed).catch((error) => toast(errorText(error), { tone: 'error' }));
    };
    const message = describe(removed.tabs.length);
    toastId = toast(message, {
      duration: UNDO_WINDOW_MS,
      countdown: true,
      announce: `${message}. Undo available for 10 seconds.`,
      action: { label: 'Undo', onClick: undo },
    });
    registerUndo(key, undo);
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

// ---------------------------------------------------------------------------------------------
// Your tabs: export and clear

export function downloadText(fileName: string, text: string, type = 'text/html;charset=utf-8'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type ExportFormat = 'html' | 'markdown' | 'csv' | 'json';

/** Folders go into every export (a column, a heading; HTML lists them first). */
const EXPORTS: Record<ExportFormat, { extension: string; type: string; make: (graphs: SessionGraph[], folders: FolderRecord[]) => string }> = {
  html: { extension: 'html', type: 'text/html;charset=utf-8', make: (graphs, folders) => exportHtml(graphs, Date.now(), { folders }) },
  markdown: { extension: 'md', type: 'text/markdown;charset=utf-8', make: (graphs, folders) => exportMarkdown(graphs, Date.now(), { folders }) },
  csv: { extension: 'csv', type: 'text/csv;charset=utf-8', make: (graphs, folders) => exportCsv(graphs, { folders }) },
  json: { extension: 'json', type: 'application/json;charset=utf-8', make: (graphs, folders) => exportJson(graphs, Date.now(), { folders }) },
};

/**
 * Export… in Settings: every folded tab as a standalone HTML page (opens anywhere, imports as
 * bookmarks), or on Pro as Markdown, CSV or JSON. Returns how many tabs went into the file.
 */
export async function exportAll(format: ExportFormat = 'html'): Promise<number> {
  try {
    const graphs = await exportGraphs();
    const tabs = graphs.reduce((n, g) => n + g.windows.reduce((m, w) => m + w.tabs.length, 0), 0);
    if (tabs === 0) {
      toast('Nothing to export yet.');
      return 0;
    }
    const { extension, type, make } = EXPORTS[format];
    const folders = await listLiveFolders().catch(() => []);
    downloadText(exportFileName().replace(/\.html$/, `.${extension}`), make(graphs, folders), type);
    toast(`Exported ${count(tabs, 'tab')}.`);
    return tabs;
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
    return 0;
  }
}

/** "Copy as context for AI" on a group (Pro AI): Markdown with a short summary, onto the clipboard. */
export async function copyAsContext(tabs: TabRecord[], name: string): Promise<void> {
  try {
    const { markdown } = await send({ type: 'ai-context', tabRecordIds: tabs.map((t) => t.id), name });
    const ok = await copyText(markdown);
    if (ok) toast(`Copied ${count(tabs.length, 'tab')} as context`, { tone: 'success' });
    else toast('Couldn’t copy to the clipboard. Click the page, then try again.', { tone: 'error' });
  } catch (error) {
    if (errorCode(error) === 'needs-pro-ai') goToPlans();
    else toast(proErrorText(error), { tone: 'error' });
  }
}

/** Everything in the extension's Chrome sync storage except the profile key (signing in stays as it is). */
async function clearChromeSyncStorage(): Promise<void> {
  const keys = Object.keys(await browser.storage.sync.get(null)).filter((key) => key !== PROFILE_KEY);
  if (keys.length) await browser.storage.sync.remove(keys);
}

/**
 * Clear everything…, after the confirm: every folded tab, snapshot and setting on this computer,
 * and Tabfold's copy in Chrome sync. The Pro sign-in stays (this computer's device token and the
 * Chrome profile key other computers sign in with).
 */
export async function clearEverything(): Promise<void> {
  await clearAllData();
  await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
  await Promise.all([snapshotMirror.set(null), recoveryOffer.set(null), lastAction.set(null), clearChromeSyncStorage()]).catch(() => undefined);
  await resetDataGuard();
}
