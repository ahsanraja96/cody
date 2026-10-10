import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { isMac } from '@/ui/hooks';

/** Tabfold's Chrome commands, in the order the boards list them. */
export const COMMANDS = [
  { name: '_execute_action', short: 'Open Tabfold', long: 'Open Tabfold' },
  { name: 'save-all', short: 'Save all tabs', long: 'Save all tabs & free memory' },
  { name: 'save-window', short: 'Save this window', long: 'Save this window' },
  { name: 'save-tab', short: 'Save this tab', long: 'Save this tab' },
] as const;

/** Chrome's own page for changing extension shortcuts (pages can't link to chrome:// directly). */
export const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';

export function openShortcutsPage(): void {
  void browser.tabs.create({ url: SHORTCUTS_PAGE }).catch(() => undefined);
}

/**
 * The real bindings from chrome.commands.getAll(), as Chrome formats them for this platform
 * ("⌥⇧F" on a Mac, "Alt+Shift+F" elsewhere). An empty string means the user removed it.
 */
export function useCommandShortcuts(): { shortcuts: Record<string, string>; loaded: boolean } {
  const [shortcuts, setShortcuts] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      browser.commands
        .getAll()
        .then((commands) => {
          if (!alive) return;
          setShortcuts(Object.fromEntries(commands.map((c) => [c.name ?? '', c.shortcut ?? ''])));
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    void load();
    // Shortcuts change on Chrome's page; pick them up when the user comes back.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  return { shortcuts, loaded };
}

/** The platform's modifier for in-app keys: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl';

/** A key combination for display: "⌘Z" on a Mac, "Ctrl+Z" elsewhere. */
export function combo(...keys: string[]): string {
  return isMac ? keys.map((k) => (k === 'Ctrl' ? '⌘' : k)).join('') : keys.join('+');
}

/** Keys inside the popup and the library (Library-Shortcuts, "In Tabfold"). */
export const APP_KEYS: Array<{ label: string; keys: string[] }> = [
  { label: 'Search', keys: ['/'] },
  { label: 'Move', keys: ['↑', '↓'] },
  { label: 'Open', keys: ['↵'] },
  { label: 'Open in background', keys: [combo('Ctrl', '↵')] },
  { label: 'Move to Trash', keys: ['Delete'] },
  { label: 'Undo', keys: [combo('Ctrl', 'Z')] },
  { label: 'Close or clear', keys: ['Esc'] },
  { label: 'This list', keys: ['?'] },
];

export const PLATFORM_NOTE = isMac
  ? 'Shown for Mac. Windows and Linux use Ctrl for ⌘ and Alt for ⌥.'
  : 'Shown for Windows and Linux. A Mac uses ⌘ for Ctrl and ⌥ for Alt.';
