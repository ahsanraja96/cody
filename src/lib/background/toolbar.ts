import { browser } from 'wxt/browser';
import { getSettings, type Settings } from '../settings';
import { getNormalWindows, incognitoAllowed } from './browserState';

/**
 * What Tabfold's toolbar button (and its Open Tabfold shortcut, `_execute_action`) opens (1.0,
 * Settings › "Toolbar button opens"): the popup, or the side panel. Applied at worker start and
 * whenever the setting changes. Without Chrome's side panel API, the popup stays.
 */

interface SidePanelApi {
  open?: (options: { windowId: number }) => Promise<void>;
  setPanelBehavior?: (behavior: { openPanelOnActionClick: boolean }) => Promise<void>;
}

export function sidePanelApi(): SidePanelApi | undefined {
  return (browser as unknown as { sidePanel?: SidePanelApi }).sidePanel;
}

/** The popup's page, as the manifest names it. */
const POPUP = 'popup.html';

/** The setting as last applied in this worker's life (undefined until then). */
let applied: Settings['toolbarOpens'] | undefined;
/** Several windows a fold would ask about, as last seen (undefined until known). */
let severalWindows: boolean | undefined;

/** Make the toolbar button open what the setting says. Never throws. */
export async function applyToolbarSetting(value?: Settings['toolbarOpens']): Promise<Settings['toolbarOpens']> {
  const wanted = value ?? (await getSettings()).toolbarOpens;
  const panel = sidePanelApi();
  const side = wanted === 'side-panel' && typeof panel?.setPanelBehavior === 'function';
  try {
    if (typeof panel?.setPanelBehavior === 'function') await panel.setPanelBehavior({ openPanelOnActionClick: side });
  } catch (error) {
    console.warn('[tabfold] side panel behaviour not set', (error as Error)?.name ?? error);
  }
  try {
    await browser.action.setPopup({ popup: side ? '' : POPUP });
  } catch (error) {
    console.warn('[tabfold] toolbar popup not set', (error as Error)?.name ?? error);
  }
  applied = side ? 'side-panel' : 'popup';
  return applied;
}

/** How many windows a fold would ask about, kept for the fold shortcut's quick answer. */
export async function refreshWindowHint(): Promise<void> {
  try {
    const [windows, settings] = await Promise.all([getNormalWindows(), getSettings()]);
    const incognito = settings.foldIncognito && (await incognitoAllowed());
    severalWindows = windows.filter((w) => incognito || !w.incognito).length > 1;
    applied ??= settings.toolbarOpens;
  } catch {
    severalWindows = undefined;
  }
}

/**
 * Without waiting: will the fold shortcut ask in the side panel? Chrome opens the side panel only
 * in answer to the shortcut itself, so the shortcut's handler asks this before anything else (a
 * fresh worker doesn't know yet and asks Chrome afterwards, falling back to the popup).
 */
export function foldAsksInSidePanel(): boolean {
  return applied === 'side-panel' && severalWindows === true;
}

/** Called once at the worker's top level. */
export function setupToolbar(): void {
  const safely = (task: Promise<unknown>) => task.catch((error) => console.warn('[tabfold] toolbar setting', (error as Error)?.name ?? error));
  safely(applyToolbarSetting());
  safely(refreshWindowHint());
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('settings' in changes)) return;
    const change = changes.settings as { oldValue?: Partial<Settings>; newValue?: Partial<Settings> };
    const before = change.oldValue?.toolbarOpens ?? 'popup';
    const after = change.newValue?.toolbarOpens ?? 'popup';
    if (before !== after) safely(applyToolbarSetting(after));
    if ((change.oldValue?.foldIncognito ?? false) !== (change.newValue?.foldIncognito ?? false)) safely(refreshWindowHint());
  });
  browser.windows.onCreated.addListener(() => void safely(refreshWindowHint()));
  browser.windows.onRemoved.addListener(() => void safely(refreshWindowHint()));
}

/** For tests: forget what this worker knew. */
export function resetToolbarRuntime(): void {
  applied = undefined;
  severalWindows = undefined;
}
