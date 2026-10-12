import { useEffect, useMemo, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { getSettings, updateSettings, watchSettings, DEFAULT_SETTINGS, type Settings } from '@/lib/settings';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import {
  aiRuns as aiRunsState,
  checkoutState,
  cloudSyncStatus,
  milestoneState,
  needsSignIn as needsSignInState,
  planEnded as planEndedState,
  planState,
  projectsState,
} from '@/lib/pro/state';
import { FREE_PLAN, type AiRuns, type CheckoutState, type MilestoneState, type PlanState, type ProjectsState } from '@/lib/pro/types';
import { listLiveSessions } from '@/lib/repo';
import { avatarColors, isTeamSession } from '@/lib/teams';
import { teamDetails as teamDetailsState, teamGone as teamGoneState } from '@/lib/pro/state';
import type { TeamDetails, TeamGone, TeamInfo } from '@/lib/pro/types';
import type { Person } from './components/Avatars';
import type { FolderRecord, SessionRecord, TabRecord } from '@/lib/types';
import type { SiteKinds } from '@/lib/categories';
import { FREE_LIMITS } from '@/lib/limits';
import { hasFreeLimits } from '@/lib/pro/tiers';
import {
  autoFoldNotice as autoFoldNoticeState,
  liveFolders as liveFoldersState,
  siteKinds as siteKindsState,
  snoozeBack as snoozeBackState,
  tidyState as tidyStateItem,
  type AutoFoldNotice,
  type LiveFolder,
  type SnoozeBack,
  type TidyState,
} from '@/lib/state';
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
export function useFoldWindows(): {
  /** Windows a fold covers (Incognito ones only with the setting on). */
  windows: OpenWindow[];
  /** Every open window Chrome shows Tabfold, for "Open windows" (an Incognito one shows "Stays open"). */
  allWindows: OpenWindow[];
  loaded: boolean;
  foldsIncognito: boolean;
} {
  const [settings, , settingsLoaded] = useSettings();
  const access = useIncognitoAccess();
  const { windows: allWindows, loaded } = useOpenWindows({
    includeIncognito: access === true,
    paused: !settingsLoaded || access === undefined,
  });
  const foldsIncognito = settings.foldIncognito && access === true;
  const windows = useMemo(() => (foldsIncognito ? allWindows : allWindows.filter((w) => !w.incognito)), [allWindows, foldsIncognito]);
  return { windows, allWindows, loaded, foldsIncognito };
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

/** A stored value that pages follow live (initial read, then storage changes). */
function useStored<T>(read: () => Promise<T | undefined>, watch: (cb: (value: T | undefined) => void) => () => void): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let alive = true;
    read()
      .then((v) => alive && setValue(v))
      .catch(() => undefined);
    const stop = watch((v) => setValue(v));
    return () => {
      alive = false;
      stop();
    };
    // read and watch are module-level functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

/** The plan (Free until the server has been asked). */
export function usePlan(): PlanState {
  return useStored(planState.get, planState.watch) ?? FREE_PLAN;
}

/** Sync with the Tabfold account (Pro). Undefined while it has never run. */
export function useCloudSyncStatus() {
  return useStored(cloudSyncStatus.get, cloudSyncStatus.watch);
}

export function useProjects(): ProjectsState {
  return useStored(projectsState.get, projectsState.watch) ?? { projects: [], organisedAt: 0 };
}

export function useAiRuns(): AiRuns | undefined {
  return useStored(aiRunsState.get, aiRunsState.watch);
}

export function useMilestoneState(): MilestoneState | undefined {
  return useStored(milestoneState.get, milestoneState.watch);
}

/** Set once when a trial or paid plan ends (cleared when its notice is dismissed). */
export function usePlanEnded() {
  return useStored(planEndedState.get, planEndedState.watch);
}

/** The plan, or undefined until it has been read, so a page doesn't flash Free-only lines on Pro. */
export function useLoadedPlan(): PlanState | undefined {
  return useStored(planState.get, planState.watch);
}

/** The Stripe Checkout tab the worker is watching, if any (the plans page waits while it is open). */
export function useCheckout(): CheckoutState | undefined {
  return useStored(checkoutState.get, checkoutState.watch);
}

/** A payment from this computer landed on an account it isn't signed in to: the email to sign in with. */
export function useNeedsSignIn(): string | undefined {
  return useStored(needsSignInState.get, needsSignInState.watch)?.email ?? undefined;
}

// ---- 0.6: folders, limits, snooze, fold automatically, live folders, tidy-up -----------------------

/** Live folders, in the left column's order. Undefined while loading. */
export function useFolders(): FolderRecord[] | undefined {
  return useLiveQuery(async () => (await db.folders.where('deletedAt').equals(0).toArray()).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt), []);
}

/** Sites the person moved to another kind (pass to `categorize` / `groupByCategory`). */
export function useSiteKinds(): SiteKinds {
  return useStored(siteKindsState.get, siteKindsState.watch) ?? {};
}

/**
 * Folded tabs and folders in use, from the folds' tab counts (cheap enough for the popup). Snoozed
 * tabs count. Undefined while loading.
 */
export function useFoldedCount(): { tabs: number; folders: number } | undefined {
  return useLiveQuery(async () => {
    // A team's fold and folders count toward no Free limit.
    const folds = (await listLiveSessions()).filter((fold) => !isTeamSession(fold));
    const tabs = folds.reduce((sum, fold) => sum + (fold.tabCount || 0), 0);
    const folders = await db.folders.where('deletedAt').equals(0).filter((f) => !f.teamId).count();
    return { tabs, folders };
  }, []);
}

/**
 * The Free limits apply to this plan (src/lib/limits.ts FREE_LIMITS)? False on Pro, Pro AI, a
 * Teams plan or Pro for life. One rule for the worker and the pages (src/lib/pro/tiers.ts).
 */
export { hasFreeLimits };

/** The free list's state: room left, near the limit (450+), or full. Null on paid plans. */
export function useListRoom(): { tabs: number; limit: number; room: number; near: boolean; full: boolean } | null | undefined {
  const plan = usePlan();
  const count = useFoldedCount();
  if (!hasFreeLimits(plan)) return null;
  if (!count) return undefined;
  const room = Math.max(0, FREE_LIMITS.tabs - count.tabs);
  return { tabs: count.tabs, limit: FREE_LIMITS.tabs, room, near: count.tabs >= FREE_LIMITS.nearTabs, full: room === 0 };
}

/** Folders open as live Chrome tab groups (Pro), by folder id. */
export function useLiveFolders(): Record<string, LiveFolder> {
  return useStored(liveFoldersState.get, liveFoldersState.watch) ?? {};
}

/** Snoozed tabs that came back and haven't been looked at. */
export function useSnoozeBack(): SnoozeBack | undefined {
  return useStored(snoozeBackState.get, snoozeBackState.watch);
}

/** The last automatic fold ("Folded 23 tabs at 18:00 (your weekday rule) · Undo"). */
export function useAutoFoldNotice(): AutoFoldNotice | undefined {
  return useStored(autoFoldNoticeState.get, autoFoldNoticeState.watch);
}

/** Pro AI's weekly tidy-up. */
export function useTidy(): TidyState | undefined {
  return useStored(tidyStateItem.get, tidyStateItem.watch);
}

// ---- 0.6 screens (UI) ------------------------------------------------------------------------------

import { autoFoldLast as autoFoldLastState, type AutoFoldRuns } from '@/lib/state';

/** When each auto-fold rule last ran and what it folded, by rule id ("Last ran today 14:00 · folded 6 tabs"). */
export function useAutoFoldLast(): AutoFoldRuns {
  return useStored(autoFoldLastState.get, autoFoldLastState.watch) ?? {};
}

// ---- Teams --------------------------------------------------------------------------------------

/** The team as `team-get` last read it (people and invitations), or undefined. */
export function useTeamDetails(): (TeamDetails & { at: number }) | undefined {
  return useStored(teamDetailsState.get, teamDetailsState.watch) ?? undefined;
}

/** Teams whose folders left this computer, waiting on "Keep a copy" or dismiss. */
export function useTeamGone(): TeamGone[] {
  return useStored(teamGoneState.get, teamGoneState.watch) ?? [];
}

export interface TeamView {
  /** The plan's team (signed in), or null. */
  team: TeamInfo | null;
  /** Everyone in it, owner first, with their avatar colours (empty until `team-get` has answered). */
  people: Person[];
  /** Someone's avatar colour (grey for someone no longer in the team). */
  colorOf: (email: string) => Person['color'];
  /** This computer's account. */
  email: string | null;
}

/** The plan's team, its people and their colours, for the left column, folder headers and Settings. */
export function useTeam(plan: PlanState): TeamView {
  const details = useTeamDetails();
  return useMemo(() => {
    const team = plan.email ? (plan.team ?? null) : null;
    const current = team && details?.team.id === team.id ? details : null;
    const colors = avatarColors(current);
    return {
      team,
      people: (current?.members ?? []).map((m) => ({ email: m.email, color: colors.get(m.email) ?? 'grey' })),
      colorOf: (email: string) => colors.get(email.toLowerCase()) ?? 'grey',
      email: plan.email,
    };
  }, [plan.email, plan.team, details]);
}

// ---- 1.0 contracts ------------------------------------------------------------------------------
import {
  groupFolders as groupFoldersState,
  starredTeamFolders as starredTeamFoldersState,
  weeklyStats as weeklyStatsState,
  weeklySummarySeen as weeklySummarySeenState,
  type WeekStats,
} from '@/lib/state';
import { summaryToShow } from '@/lib/weekly';

/** Chrome tab groups opened from a folder, by group id (they fold back into it). */
export function useGroupFolders(): Record<string, string> {
  return useStored(groupFoldersState.get, groupFoldersState.watch) ?? {};
}

/** Team folders this person starred (folder id → when). Personal folders carry `starredAt`. */
export function useStarredTeamFolders(): Record<string, number> {
  return useStored(starredTeamFoldersState.get, starredTeamFoldersState.watch) ?? {};
}

/** Is this folder starred for this person (a personal folder's `starredAt`, or a team folder's own star)? */
export function isStarred(folder: FolderRecord, teamStars: Readonly<Record<string, number>>): boolean {
  return folder.teamId ? !!teamStars[folder.id] : !!folder.starredAt;
}

/** Last week's summary to show now ("Last week you folded 340 tabs…"), or null. */
export function useWeeklySummary(): (WeekStats & { week: string }) | null {
  const [settings] = useSettings();
  const stats = useStored(weeklyStatsState.get, weeklyStatsState.watch);
  const seen = useStored(weeklySummarySeenState.get, weeklySummarySeenState.watch);
  const now = useNow(true, 60 * 60_000);
  return useMemo(
    () => (stats ? summaryToShow(stats, now, seen, settings.weeklySummary) : null),
    [stats, now, seen, settings.weeklySummary],
  );
}
