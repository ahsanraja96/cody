import { useEffect, useMemo, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { getSettings, updateSettings, watchSettings, DEFAULT_SETTINGS, type Settings } from '@/lib/settings';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { listLiveSessions } from '@/lib/repo';
import type { SessionRecord, TabRecord } from '@/lib/types';
import {
  activeFold,
  syncStatus,
  type ActiveFold,
  type SyncStatus,
  activeRestore,
  groupsUnavailable,
  lastAction,
  recoveryOffer,
  updateReady,
  windowNames,
  type ActiveRestore,
  type LastAction,
  type RecoveryOffer,
  type UpdateReady,
} from '@/lib/state';
import { SearchClient } from '@/lib/search/client';
import type { SearchDoc } from '@/lib/search/engine';
import type { SearchResponse } from '@/lib/search/protocol';
import { isWorkerEvent, type WorkerEvent } from '@/lib/messages';
import { displayHost } from '@/lib/urls';

export function useSettings(): [Settings, (patch: Partial<Settings>) => void, boolean] {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    return watchSettings(setSettings);
  }, []);
  const update = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    updateSettings(patch).catch(() => undefined);
  };
  return [settings, update, loaded];
}

export function useLastAction(): LastAction | undefined {
  const [value, setValue] = useState<LastAction>();
  useEffect(() => {
    lastAction.get().then(setValue);
    return lastAction.watch(setValue);
  }, []);
  return value;
}

export function useRecoveryOffer(): RecoveryOffer | undefined {
  const [value, setValue] = useState<RecoveryOffer>();
  useEffect(() => {
    recoveryOffer.get().then(setValue);
    return recoveryOffer.watch(setValue);
  }, []);
  return value;
}

/** The restore in progress (from any page), or undefined. */
export function useActiveRestore(): ActiveRestore | undefined {
  const [value, setValue] = useState<ActiveRestore>();
  useEffect(() => {
    activeRestore.get().then(setValue);
    return activeRestore.watch(setValue);
  }, []);
  return value;
}

/** The fold in progress or just finished (from any page), or undefined. */
export function useActiveFold(): ActiveFold | undefined {
  const [value, setValue] = useState<ActiveFold>();
  useEffect(() => {
    activeFold.get().then(setValue);
    return activeFold.watch(setValue);
  }, []);
  return value;
}

/** Chrome sync of folded tabs, or undefined before the first sync. */
export function useSyncStatus(): SyncStatus | undefined {
  const [value, setValue] = useState<SyncStatus>();
  useEffect(() => {
    syncStatus.get().then(setValue);
    return syncStatus.watch(setValue);
  }, []);
  return value;
}

export interface FoldedTabs {
  tabs: TabRecord[];
  /** Live folds (sessions), newest first: the "Recent folds" strip reads the first few. */
  folds: SessionRecord[];
}

/** Every folded tab in a live fold, kept fresh. Undefined while loading. */
export function useFoldedTabs(): FoldedTabs | undefined {
  return useLiveQuery(async () => {
    const folds = [...(await listLiveSessions())].sort((a, b) => b.updatedAt - a.updatedAt);
    const live = new Set(folds.map((f) => f.id));
    const tabs = (await db.tabs.toArray()).filter((t) => live.has(t.sessionId));
    return { tabs, folds };
  }, []);
}

/** A downloaded update waiting for the pages to reload (`browser.runtime.reload()` applies it). */
export function useUpdateReady(): UpdateReady | undefined {
  const [value, setValue] = useState<UpdateReady>();
  useEffect(() => {
    updateReady.get().then(setValue);
    return updateReady.watch(setValue);
  }, []);
  return value;
}

/** True when Chrome refuses the tab groups API (for example an organisation policy). */
export function useGroupsUnavailable(): boolean {
  const [value, setValue] = useState(false);
  useEffect(() => {
    groupsUnavailable.get().then(setValue);
    return groupsUnavailable.watch((v) => setValue(v === true));
  }, []);
  return value;
}

/** Re-render every second while a countdown is visible. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

export interface OpenWindow {
  id: number;
  name: string;
  focused: boolean;
  incognito: boolean;
  tabs: Browser.tabs.Tab[];
}

/**
 * Open normal windows with their tabs, kept fresh from tab and window events (batched, so a page
 * load's many update events cause one refresh). Closing a window while the popup is open is fine.
 */
export function useOpenWindows(
  options: { includeIncognito?: boolean; paused?: boolean } = {},
): { windows: OpenWindow[]; loaded: boolean } {
  const includeIncognito = options.includeIncognito ?? false;
  // Paused until the caller knows whether to include Incognito, so the counts don't jump.
  const paused = options.paused ?? false;
  const [windows, setWindows] = useState<OpenWindow[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (paused) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const [all, names] = await Promise.all([
        browser.windows.getAll({ populate: true, windowTypes: ['normal'] }),
        windowNames.get(),
      ]);
      if (!alive) return;
      setWindows(
        all
          .filter((w) => (includeIncognito || !w.incognito) && w.id !== undefined)
          .map((w) => ({
            id: w.id!,
            name: names[w.id!] ?? '',
            focused: w.focused,
            incognito: w.incognito,
            tabs: (w.tabs ?? []).filter((t) => includeIncognito || !t.incognito).sort((a, b) => a.index - b.index),
          })),
      );
      setLoaded(true);
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refresh().catch(() => undefined), 120);
    };
    refresh().catch(() => setLoaded(true));
    const onUpdated = (_id: number, change: Browser.tabs.OnUpdatedInfo) => {
      if (
        change.title !== undefined ||
        change.url !== undefined ||
        change.discarded !== undefined ||
        change.audible !== undefined ||
        change.pinned !== undefined ||
        change.favIconUrl !== undefined ||
        change.status === 'complete'
      ) {
        schedule();
      }
    };
    const events = [
      browser.tabs.onCreated,
      browser.tabs.onRemoved,
      browser.tabs.onMoved,
      browser.tabs.onAttached,
      browser.tabs.onDetached,
      browser.tabs.onActivated,
      browser.tabs.onHighlighted,
      browser.windows.onCreated,
      browser.windows.onRemoved,
    ] as Array<{ addListener: (fn: () => void) => void; removeListener: (fn: () => void) => void }>;
    for (const event of events) event.addListener(schedule);
    browser.tabs.onUpdated.addListener(onUpdated);
    const stopNames = windowNames.watch(schedule);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      for (const event of events) event.removeListener(schedule);
      browser.tabs.onUpdated.removeListener(onUpdated);
      stopNames();
    };
  }, [includeIncognito, paused]);
  return { windows, loaded };
}

/**
 * The open windows a fold covers: Incognito ones too while "Fold Incognito windows too" is on and
 * Chrome allows Tabfold in Incognito.
 */
export function useFoldWindows(): { windows: OpenWindow[]; loaded: boolean } {
  const [settings, , settingsLoaded] = useSettings();
  const access = useIncognitoAccess();
  return useOpenWindows({
    includeIncognito: settings.foldIncognito && access === true,
    paused: !settingsLoaded || (settings.foldIncognito && access === undefined),
  });
}

/** "Allow in Incognito" is on for Tabfold in chrome://extensions (undefined until known). */
export function useIncognitoAccess(): boolean | undefined {
  const [allowed, setAllowed] = useState<boolean>();
  useEffect(() => {
    const check = () =>
      browser.extension
        .isAllowedIncognitoAccess()
        .then(setAllowed)
        .catch(() => setAllowed(false));
    void check();
    // Turned on in Chrome's extension settings: picked up when the person comes back.
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);
  return allowed;
}

export function openDocsFrom(windows: OpenWindow[]): SearchDoc[] {
  return windows.flatMap((window, index) =>
    window.tabs
      .filter((t) => t.id !== undefined && (t.url || t.pendingUrl))
      .map((t) => ({
        id: `open:${t.id}`,
        kind: 'open' as const,
        title: t.title || displayHost(t.url || t.pendingUrl || ''),
        url: t.url || t.pendingUrl || '',
        keywords: [],
        favIconUrl: t.favIconUrl ?? '',
        tabId: t.id,
        windowId: window.id,
        windowLabel: window.name || `Window ${index + 1}`,
        discarded: t.discarded,
      })),
  );
}

/** Search as you type. Queries go to the worker; answers to older keystrokes are dropped. */
export function useTabSearch(
  query: string,
  openDocs: SearchDoc[],
  options: { scope?: 'live' | 'trash'; limit?: number; warm?: boolean } = {},
): { result: SearchResponse | null; searching: boolean } {
  const client = useRef<SearchClient | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  if (!client.current) client.current = new SearchClient();

  useEffect(() => {
    const c = client.current;
    if (options.warm) {
      const id = setTimeout(() => c?.warm(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [options.warm]);

  useEffect(() => () => client.current?.dispose(), []);

  const openKey = useMemo(() => openDocs.map((d) => d.id + d.title).join('|'), [openDocs]);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResult(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      client.current
        ?.query(q, openDocs, { scope: options.scope, limit: options.limit })
        .then((response) => {
          if (response) {
            setResult(response);
            setSearching(false);
          }
        });
    }, 40);
    return () => clearTimeout(timer);
    // openDocs identity changes often; openKey captures what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, openKey, options.scope, options.limit]);

  return { result, searching };
}

export function useWorkerEvents(callback: (event: WorkerEvent) => void): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const listener = (message: unknown) => {
      if (isWorkerEvent(message)) ref.current(message.event);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);
}

/** The screen area of this page's window, so restored windows land on a screen that exists. */
export function currentScreen() {
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  return { left: s.availLeft ?? 0, top: s.availTop ?? 0, width: s.availWidth, height: s.availHeight };
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** "⌘" on a Mac, "Ctrl" elsewhere, for hints like ⌘↵. */
export const modKey = isMac ? '⌘' : 'Ctrl+';

/** The user's current shortcut for one of Tabfold's commands, as Chrome shows it. */
export function useCommandShortcut(name: string): string {
  const [shortcut, setShortcut] = useState('');
  useEffect(() => {
    browser.commands
      .getAll()
      .then((commands) => setShortcut(commands.find((c) => c.name === name)?.shortcut ?? ''))
      .catch(() => undefined);
  }, [name]);
  return shortcut;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
