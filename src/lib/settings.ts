import { browser } from 'wxt/browser';

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemeSetting;
  /** Pinned tabs stay open (and out of the session) when saving everything. */
  keepPinnedOpen: boolean;
  /** "Save all" covers every window; off means only the current window. */
  includeAllWindows: boolean;
  skipBlankPages: boolean;
  /**
   * Tabs already saved in any session: skip them (they still close, and stay saved where they are),
   * save them again, or ask in the popup. Saves without a page to ask in (shortcuts, menus) treat
   * "ask" as "keep" so nothing is ever dropped silently.
   */
  duplicates: 'skip' | 'keep' | 'ask';
  /** Before closing tabs that are playing audio, ask whether to keep them open. */
  warnAudioBeforeClose: boolean;
  afterRestore: 'keep' | 'trash';
  /** The last choice in the restore options dialog. */
  lastRestoreMode: 'original' | 'current' | 'new-window';
  lazyRestore: boolean;
  autoSuspend: boolean;
  autoSuspendMinutes: number;
  neverSuspendPinned: boolean;
  neverSuspendAudible: boolean;
  neverSuspendDomains: string[];
  suggestKeywords: boolean;
  askKeywordsOnSingleSave: boolean;
  backupReminder: boolean;
  /** Share the newest folded tabs through Chrome sync (no account; works when signed in to Chrome). */
  syncWithChrome: boolean;
  /**
   * Fold Incognito windows too (needs "Allow in Incognito" for Tabfold). Their tabs stay on this
   * computer (never in Chrome sync) and reopen only in Incognito.
   */
  foldIncognito: boolean;
  /** Before 0.6 (By site / By project). Unused: folders replaced projects. */
  groupBy: 'site' | 'project';
  /** Fold automatically (Mx-Auto board). Free runs only the first enabled rule, and only an `idle` one. */
  autoFold: AutoFoldRule[];
  /** Pro AI's weekly tidy-up card (Mondays). */
  tidyUp: boolean;
}

/**
 * When an auto-fold rule runs:
 * - `idle`: tabs not looked at for `days` days (Chrome's tab.lastAccessed).
 * - `time`: every chosen weekday (0 Sunday … 6 Saturday) at `hour`:`minute`, everything open.
 * - `site-idle`: tabs from these sites not looked at for `minutes` minutes.
 */
export type AutoFoldWhen =
  | { type: 'idle'; days: number }
  | { type: 'time'; hour: number; minute: number; weekdays: number[] }
  | { type: 'site-idle'; hosts: string[]; minutes: number };

/** Where a rule's tabs go: their kind of site (no folder), a folder, or (time rules) one new fold. */
export type AutoFoldInto = { type: 'site' } | { type: 'folder'; folderId: string };

export interface AutoFoldRule {
  id: string;
  enabled: boolean;
  when: AutoFoldWhen;
  into: AutoFoldInto;
  createdAt: number;
}

/** Calls and meeting sites are never suspended; tabs using a camera or mic can't be detected without reading pages. */
export const MEETING_DOMAINS = [
  'meet.google.com',
  'zoom.us',
  'app.zoom.us',
  'teams.microsoft.com',
  'teams.live.com',
  'whereby.com',
];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  keepPinnedOpen: true,
  includeAllWindows: true,
  skipBlankPages: true,
  duplicates: 'ask',
  warnAudioBeforeClose: true,
  afterRestore: 'keep',
  lastRestoreMode: 'original',
  lazyRestore: true,
  autoSuspend: true,
  autoSuspendMinutes: 30,
  neverSuspendPinned: true,
  neverSuspendAudible: true,
  neverSuspendDomains: [...MEETING_DOMAINS],
  suggestKeywords: true,
  askKeywordsOnSingleSave: true,
  backupReminder: true,
  syncWithChrome: true,
  foldIncognito: false,
  groupBy: 'site',
  autoFold: [],
  tidyUp: true,
};

export const AUTO_SUSPEND_CHOICES = [5, 10, 15, 30, 60, 120, 240];

const KEY = 'settings';

export function withDefaults(stored: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function getSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(KEY);
  return withDefaults(result[KEY] as Partial<Settings> | undefined);
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export function watchSettings(callback: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local' || !(KEY in changes)) return;
    callback(withDefaults(changes[KEY]?.newValue as Partial<Settings> | undefined));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Lower-cases and strips scheme/path so "https://www.Figma.com/file" becomes "figma.com". */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  let host = trimmed;
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  if (host === 'localhost') return host;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** True when the host is the domain or one of its subdomains. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.replace(/^www\./, '').toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}
