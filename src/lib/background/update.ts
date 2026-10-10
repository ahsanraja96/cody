import { browser } from 'wxt/browser';
import { updateReady } from '../state';
import { ownOrigin } from './browserState';

/**
 * Chrome downloaded a new version of Tabfold. With no Tabfold page open, reload at once so the
 * update installs. Otherwise remember it: open pages show "Tabfold was updated · Reload", and
 * reloading (runtime.reload) installs it without interrupting anything.
 */
export async function onUpdateAvailable(version: string): Promise<void> {
  await updateReady.set({ version, at: Date.now() });
  if (!(await tabfoldPageOpen())) browser.runtime.reload();
}

/** The new version is running: nothing is waiting any more. */
export async function onUpdated(): Promise<void> {
  await updateReady.set(null);
}

/** Is a Tabfold page (library, popup, onboarding) open? */
export async function tabfoldPageOpen(): Promise<boolean> {
  if (typeof browser.runtime.getContexts === 'function') {
    try {
      const contexts = await browser.runtime.getContexts({ contextTypes: ['TAB', 'POPUP'] });
      return contexts.length > 0;
    } catch {
      // Older Chrome: fall back to looking for our pages among the open tabs.
    }
  }
  const origin = ownOrigin();
  const tabs = await browser.tabs.query({});
  return tabs.some((tab) => (tab.url || tab.pendingUrl || '').startsWith(origin));
}
