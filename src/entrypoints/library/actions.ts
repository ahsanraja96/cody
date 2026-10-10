import { browser } from 'wxt/browser';
import { create } from 'zustand';
import { resetDataGuard } from '@/lib/dataGuard';
import { exportFileName, exportHtml } from '@/lib/exporters';
import { send } from '@/lib/messages';
import type { Category } from '@/lib/categories';
import { clearAllData, exportGraphs, putBackTabs, removeTabsWithSnapshot, type RemovedTabs } from '@/lib/repo';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { lastAction, recoveryOffer, snapshotMirror, UNDO_WINDOW_MS } from '@/lib/state';
import type { TabRecord } from '@/lib/types';
import { dismissToast, toast } from '@/ui/components/Toast';
import { count } from './format';
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
export async function openGroup(tabs: TabRecord[], category: Category): Promise<void> {
  try {
    const current = await browser.windows.getCurrent().catch(() => undefined);
    const { opened } = await send({
      type: 'open-tabs',
      tabRecordIds: tabs.map((t) => t.id),
      asGroup: { name: category.name, color: category.color },
      windowId: current?.id,
    });
    toast(opened === tabs.length ? `Opened ${count(opened, 'tab')}. They stay in the list.` : `Opened ${opened} of ${tabs.length} tabs.`);
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
export async function removeGroup(tabs: TabRecord[]): Promise<void> {
  try {
    const removed = await removeTabsWithSnapshot(tabs.map((t) => t.id));
    const key = `remove-group:${Date.now()}`;
    let toastId = 0;
    const undo = () => {
      dropUndo(key);
      dismissToast(toastId);
      putBackTabs(removed).catch((error) => toast(errorText(error), { tone: 'error' }));
    };
    const message = `Removed ${count(removed.tabs.length, 'tab')}`;
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

/** Export… in Settings: every folded tab as a standalone HTML page (opens anywhere, imports as bookmarks). */
export async function exportAll(): Promise<void> {
  try {
    const graphs = await exportGraphs();
    const tabs = graphs.reduce((n, g) => n + g.windows.reduce((m, w) => m + w.tabs.length, 0), 0);
    if (tabs === 0) {
      toast('Nothing to export yet.');
      return;
    }
    downloadText(exportFileName(), exportHtml(graphs));
    toast(`Exported ${count(tabs, 'tab')}.`);
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

/**
 * Clear everything…, after the confirm: every folded tab, snapshot and setting on this computer,
 * and Tabfold's copy in Chrome sync (the extension's own sync storage, which holds nothing else).
 */
export async function clearEverything(): Promise<void> {
  await clearAllData();
  await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
  await Promise.all([
    snapshotMirror.set(null),
    recoveryOffer.set(null),
    lastAction.set(null),
    browser.storage.sync.clear(),
  ]).catch(() => undefined);
  await resetDataGuard();
}
