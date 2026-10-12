import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { Archive, ArrowRight, Clock, ExternalLink, Folder, Layers, Search, Settings as SettingsIcon, Star, StarOff, StickyNote, Trash2, Undo2, X } from 'lucide-react';
import { extUrl } from '@/lib/extUrl';
import { FREE_LIMITS } from '@/lib/limits';
import { openLibrary } from '@/lib/openLibrary';
import { pendingFoldAsk, pendingFoldInto } from '@/lib/state';
import { personalFolders, teamFolders } from '@/lib/teams';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { FolderIcon } from '@/ui/components/FolderIcon';
import { Logo } from '@/ui/components/Logo';
import { Menu, type MenuAnchor, type MenuEntry } from '@/ui/components/Menu';
import { starFolder } from '@/ui/components/NoteField';
import { PlanChip, UpgradeButton } from '@/ui/components/ProBits';
import { QuickResults, RESULTS_ID, type SearchNav } from '@/ui/components/QuickResults';
import { ToastViewport } from '@/ui/components/Toast';
import { WindowMenu, type FoldTarget } from '@/ui/components/WindowMenu';
import { cx } from '@/ui/cx';
import { folderCounts } from '@/ui/folders';
import {
  foldIntoOrder,
  hasFreeLimits,
  isStarred,
  useActiveFold,
  useFoldedTabs,
  useFolders,
  useFoldWindows,
  useListRoom,
  useLoadedPlan,
  useNow,
  usePendingFoldAsk,
  usePendingFoldInto,
  useRecentFolders,
  useSettings,
  useSiteKinds,
  useStarredTeamFolders,
  useTabGroups,
  useTabSearch,
} from '@/ui/hooks';
import { closeCopies, copiesIn, openSearchDocs, renameWindow, tidyWindow } from '@/ui/openTabs';
import { PLANS_HASH } from '@/ui/pro';
import { snoozeChoices } from '@/ui/snooze';
import { describeWindows, foldChoice, type WindowInfo } from '@/ui/windows';
import { longAgo } from '../popup/popupHooks';
import { FoldAsk } from '../popup/Hero';
import { fold, moveTabs, openAll, openFolded, removeTabs, snoozeTabs } from './actions';
import { Folded } from './Folded';
import { OpenNow } from './OpenNow';

/**
 * Tabfold in Chrome's side panel (1.0, Fi-Panel, Fi-Panel-Dark, Fi-Panel-States): open while you
 * browse. The header (plan, Upgrade on Free, Settings), search ("/"), "Open now" with each window
 * and its tabs (live from Chrome's tab and window events), then "Folded": starred folders first,
 * kinds of site, Snoozed. The footer opens the full list and counts the tabs (Free: "312 of 500
 * tabs", amber from 450). It paints from the open windows and the folders right away; the folded
 * tabs fill in as soon as they're read.
 */

/** A right-click hand-off is only picked up shortly after it was made. */
const PENDING_MAX_AGE_MS = 60_000;
const SEARCH_LIMIT = 50;

type PanelMenu =
  | { kind: 'window'; info: WindowInfo; anchor: MenuAnchor; button: HTMLElement | null }
  /** The folder list for a window or one tab ("Fold this tab into", right-click › Choose a folder…). */
  | { kind: 'fold-into'; info?: WindowInfo; tab?: { id: number; title: string }; anchor: MenuAnchor; button: HTMLElement | null }
  | { kind: 'open-tab'; tab: Browser.tabs.Tab; anchor: MenuAnchor; button: HTMLElement | null }
  | { kind: 'folded-tab'; tab: TabRecord; anchor: MenuAnchor; button: HTMLElement | null }
  | { kind: 'folder'; folder: FolderRecord; anchor: MenuAnchor; button: HTMLElement | null };

const ICON = { size: 16, strokeWidth: 1.75 } as const;
/** The fold-back hint is the popup's (Fi-Popup); the panel's window heads stay one line. */
const NO_HINTS: ReadonlyMap<number, ReactNode> = new Map();

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function isFolding(fold: ReturnType<typeof useActiveFold>): boolean {
  return !!fold && (fold.phase === 'saving' || fold.phase === 'closing' || fold.phase === 'waiting') && Date.now() - fold.startedAt < 10 * 60_000;
}

export function PanelApp() {
  const [currentWindowId, setCurrentWindowId] = useState<number>();
  useEffect(() => {
    browser.windows
      .getCurrent()
      .then((w) => setCurrentWindowId(w.id))
      .catch(() => undefined);
  }, []);
  const [settings] = useSettings();
  const { allWindows, foldsIncognito } = useFoldWindows();
  const plan = useLoadedPlan();
  const free = !!plan && hasFreeLimits(plan);
  const folded = useFoldedTabs();
  const folders = useFolders();
  const siteKinds = useSiteKinds();
  const room = useListRoom();
  const teamStars = useStarredTeamFolders();
  const recentFolders = useRecentFolders();
  const tabGroups = useTabGroups();
  const activeFold = useActiveFold();
  const pendingInto = usePendingFoldInto();
  const pendingAsk = usePendingFoldAsk();
  const now = useNow(true, 60_000);

  const infos = useMemo(
    () => describeWindows(allWindows, { currentWindowId, keepPinnedOpen: settings.keepPinnedOpen, foldsIncognito, ownOrigin: extUrl('/') }),
    [allWindows, currentWindowId, settings.keepPinnedOpen, foldsIncognito],
  );
  const choice = foldChoice(infos);
  const thisWindow = choice.thisWindow;
  const tabs = folded?.tabs;
  const starred = useCallback((folder: FolderRecord) => isStarred(folder, teamStars), [teamStars]);
  const intoFolders = useMemo(() => foldIntoOrder(folders ?? [], teamStars, recentFolders), [folders, teamStars, recentFolders]);
  const counts = useMemo(() => folderCounts(tabs), [tabs]);
  const folderLimit = free && personalFolders(folders ?? []).length >= FREE_LIMITS.folders;
  const copies = useMemo(() => copiesIn(infos), [infos]);
  const [menu, setMenu] = useState<PanelMenu | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const folding = isFolding(activeFold);

  const foldWindow = (info: WindowInfo, into?: FoldTarget) =>
    void fold({
      windowId: info.id,
      keepWindowOpen: info.current,
      ...(into ? ('folderId' in into ? { intoFolderId: into.folderId } : { newFolderName: into.newName }) : {}),
    });
  const foldTabInto = (tabId: number, into: FoldTarget) =>
    void fold({ tabIds: [tabId], keepWindowOpen: true, ...('folderId' in into ? { intoFolderId: into.folderId } : { newFolderName: into.newName }) });

  // Right-click › "Fold this tab into › Choose a folder…": the folder list for that tab, once.
  const handledInto = useRef(0);
  useEffect(() => {
    if (!pendingInto || handledInto.current === pendingInto.at) return;
    handledInto.current = pendingInto.at;
    void pendingFoldInto.set(null).catch(() => undefined);
    if (Date.now() - pendingInto.at > PENDING_MAX_AGE_MS) return;
    void browser.tabs
      .get(pendingInto.tabId)
      .then((tab) =>
        setMenu({
          kind: 'fold-into',
          tab: { id: pendingInto.tabId, title: tab.title || tab.url || 'This tab' },
          anchor: { x: window.innerWidth - 8, y: 96, alignRight: true },
          button: null,
        }),
      )
      .catch(() => undefined);
  }, [pendingInto]);

  // The fold shortcut in side-panel mode: "Fold which windows?" until answered.
  const [asking, setAsking] = useState(false);
  const handledAsk = useRef(0);
  useEffect(() => {
    if (!pendingAsk || handledAsk.current === pendingAsk.at) return;
    handledAsk.current = pendingAsk.at;
    void pendingFoldAsk.set(null).catch(() => undefined);
    if (Date.now() - pendingAsk.at < PENDING_MAX_AGE_MS) setAsking(true);
  }, [pendingAsk]);

  // Search: "/" focuses it, Esc clears it.
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const docs = useMemo(() => openSearchDocs(infos, extUrl('/')), [infos]);
  const { result } = useTabSearch(query, docs, { limit: SEARCH_LIMIT, warm: folded !== undefined });
  const navRef = useRef<SearchNav | null>(null);
  const [activeId, setActiveId] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const toPlans = () => void openLibrary(PLANS_HASH);
  const totalTabs = tabs?.length ?? 0;
  const countText = room ? (
    <span className={room.near ? 'font-semibold text-amber' : undefined}>
      {room.tabs.toLocaleString()} of {room.limit.toLocaleString()}
    </span>
  ) : (
    totalTabs.toLocaleString()
  );

  const menuEntries = (m: PanelMenu): MenuEntry[] => {
    if (m.kind === 'open-tab') {
      const tab = m.tab;
      return [
        { key: 'fold', label: 'Fold this tab', icon: <Archive {...ICON} />, onSelect: () => void fold({ tabIds: [tab.id!], keepWindowOpen: true }) },
        {
          key: 'into',
          label: 'Fold into…',
          icon: <Folder {...ICON} />,
          keepOpen: true,
          onSelect: () => setMenu({ kind: 'fold-into', tab: { id: tab.id!, title: tab.title || tab.url || 'This tab' }, anchor: m.anchor, button: m.button }),
        },
        { type: 'separator', key: 's' },
        { key: 'close', label: 'Close tab', icon: <X {...ICON} />, onSelect: () => void browser.tabs.remove(tab.id!).catch(() => undefined) },
      ];
    }
    if (m.kind === 'folded-tab') {
      const tab = m.tab;
      const all = folders ?? [];
      const current = all.find((f) => f.id === tab.folderId) ?? null;
      const inTeam = !!current?.teamId;
      const move: MenuEntry[] = personalFolders(all).map((f) => ({
        key: `f:${f.id}`,
        label: f.name,
        icon: <FolderIcon color={f.color} />,
        checked: f.id === tab.folderId,
        onSelect: () => f.id !== tab.folderId && void moveTabs([tab], f, current),
      }));
      const team = tab.incognito ? [] : teamFolders(all);
      if (team.length) {
        move.push({ type: 'separator', key: 'st' }, { type: 'heading', key: 'team', label: 'Team' });
        move.push(...team.map((f) => ({ key: `f:${f.id}`, label: f.name, icon: <FolderIcon color={f.color} />, checked: f.id === tab.folderId, onSelect: () => f.id !== tab.folderId && void moveTabs([tab], f, current) })));
      }
      if (current) move.push({ type: 'separator', key: 'so' }, { key: 'out', label: 'Out of its folder', icon: <Undo2 {...ICON} />, onSelect: () => void moveTabs([tab], null, current) });
      return [
        { key: 'move', label: 'Move to', icon: <ArrowRight {...ICON} />, submenu: move.length ? move : [{ key: 'none', label: 'No folders yet', disabled: true }], submenuWidth: 220 },
        ...(inTeam
          ? []
          : [
              {
                key: 'snooze',
                label: 'Snooze',
                icon: <Clock {...ICON} />,
                submenuWidth: 252,
                submenu: snoozeChoices().map((c) => ({ key: c.id, label: c.label, hint: c.hint, icon: <Clock {...ICON} />, onSelect: () => void snoozeTabs([tab], c.at) })),
              } satisfies MenuEntry,
            ]),
        { key: 'bg', label: 'Open in background', icon: <ExternalLink {...ICON} />, onSelect: () => void openFolded(tab, false, currentWindowId) },
        { type: 'separator', key: 's' },
        { key: 'remove', label: 'Remove from list', icon: <Trash2 {...ICON} />, danger: true, onSelect: () => void removeTabs([tab]) },
      ];
    }
    if (m.kind === 'folder') {
      const folder = m.folder;
      const on = starred(folder);
      const items = (tabs ?? []).filter((t) => t.folderId === folder.id && !t.snoozeUntil);
      return [
        { key: 'star', label: on ? 'Unstar' : 'Star', icon: on ? <StarOff {...ICON} /> : <Star {...ICON} />, onSelect: () => void starFolder(folder, !on) },
        { key: 'note', label: folder.note ? 'Edit the note' : 'Add a note', icon: <StickyNote {...ICON} />, onSelect: () => setEditingNote(folder.id) },
        { type: 'separator', key: 's' },
        {
          key: 'open',
          label: 'Open all as a tab group',
          icon: <Layers {...ICON} />,
          disabled: items.length === 0,
          onSelect: () => void openAll(items, { name: folder.name, color: folder.color, folderId: folder.id }, currentWindowId),
        },
        { key: 'list', label: 'Show in the full list', icon: <ExternalLink {...ICON} />, onSelect: () => void openLibrary() },
      ];
    }
    return [];
  };

  const empty = !!tabs && tabs.length === 0 && (folders?.length ?? 0) === 0;
  const footerCount = room ? (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx('text-small tabular-nums', room.near ? 'font-semibold text-amber' : 'text-text-3')}>
        {room.tabs.toLocaleString()} of {room.limit.toLocaleString()} tabs
      </span>
      {room.near && (
        <>
          <span aria-hidden className="text-text-3">
            ·
          </span>
          <button type="button" onClick={toPlans} className="text-small font-semibold text-accent-text hover:underline">
            Upgrade
          </button>
        </>
      )}
    </span>
  ) : (
    tabs && (
      <span className="text-small text-text-3 tabular-nums">
        {plural(totalTabs, 'tab')} · {plural(folders?.length ?? 0, 'folder')}
      </span>
    )
  );

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex h-[52px] flex-none items-center gap-2 pr-2 pl-3.5">
        <Logo size={24} />
        <span className="text-[14px] font-semibold">Tabfold</span>
        {plan && <PlanChip plan={plan} />}
        <span className="flex-1" />
        {free && <UpgradeButton size="sm" onClick={toPlans} className="h-7" />}
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={() => void openLibrary('#/settings')}
          className="flex size-8 flex-none items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
        >
          <SettingsIcon size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </header>
      <div className="flex-none px-3.5 pb-2.5">
        <label
          className={cx(
            'flex h-[34px] items-center gap-2 rounded-control border border-border-strong bg-surface pl-2.5 text-text-3',
            'focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]',
            query ? 'pr-1' : 'pr-[7px]',
          )}
        >
          <Search size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={searching}
            aria-controls={searching ? RESULTS_ID : undefined}
            aria-activedescendant={searching ? activeId : undefined}
            aria-autocomplete="list"
            aria-keyshortcuts="/"
            value={query}
            placeholder="Search open and folded tabs"
            aria-label="Search open and folded tabs by title, address or keyword"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (!searching) return;
                e.preventDefault();
                navRef.current?.move(e.key === 'ArrowDown' ? 1 : -1);
              } else if (e.key === 'Enter' && searching) {
                e.preventDefault();
                navRef.current?.open(e.metaKey || e.ctrlKey);
              } else if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }}
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              className="flex size-6 flex-none items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
            >
              <X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          ) : (
            <kbd
              aria-hidden
              className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border-strong bg-surface px-[5px] text-meta text-text-2"
            >
              /
            </kbd>
          )}
        </label>
      </div>

      {searching ? (
        <QuickResults
          query={query}
          result={result}
          openCount={docs.length}
          folders={folders ?? []}
          counts={counts}
          tabs={tabs}
          siteKinds={siteKinds}
          currentWindowId={currentWindowId}
          navRef={navRef}
          onActiveChange={setActiveId}
          ago={(at) => longAgo(at)}
          onOpenFolder={(folder) =>
            void openAll(
              (tabs ?? []).filter((t) => t.folderId === folder.id && !t.snoozeUntil),
              { name: folder.name, color: folder.color, folderId: folder.id },
              currentWindowId,
            )
          }
          onClear={() => {
            setQuery('');
            inputRef.current?.focus();
          }}
        />
      ) : (
        <>
          <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {asking && choice.ask && (
              <div className="px-2 pt-1 pb-3">
                <FoldAsk
                  available
                  open
                  thisCount={thisWindow?.foldable.length ?? 0}
                  allCount={choice.allTabs}
                  windowCount={choice.withTabs.length}
                  allNamed={choice.withTabs.length === infos.filter((w) => w.folds).length}
                  onThis={() => {
                    setAsking(false);
                    if (thisWindow) foldWindow(thisWindow);
                  }}
                  onAll={() => {
                    setAsking(false);
                    void fold({});
                  }}
                  onCancel={() => setAsking(false)}
                  onFocusChange={() => undefined}
                />
              </div>
            )}
            <OpenNow
              windows={infos}
              groups={tabGroups}
              copies={copies}
              folding={folding}
              menuFor={menu?.kind === 'window' ? menu.info.id : undefined}
              renaming={renaming}
              hints={NO_HINTS}
              onRenaming={setRenaming}
              actions={{
                onFold: (info) => foldWindow(info),
                onMenu: (info, anchor, button) => setMenu({ kind: 'window', info, anchor, button }),
                onRename: (info, name) => void renameWindow(info.id, name),
                onCloseCopies: () => void closeCopies(),
                onTabMenu: (tab, anchor, button) => setMenu({ kind: 'open-tab', tab, anchor, button }),
              }}
            />
            {tabs && folders && (
              <div className="mt-1.5">
                <Folded
                  tabs={tabs}
                  folders={folders}
                  isStarred={starred}
                  siteKinds={siteKinds}
                  countText={countText}
                  now={now}
                  windowId={currentWindowId}
                  canFoldHere={!!thisWindow && thisWindow.foldable.length > 0 && !folding}
                  menuFolder={menu?.kind === 'folder' ? menu.folder.id : undefined}
                  editing={editingNote}
                  onEditing={setEditingNote}
                  actions={{
                    onFolderMenu: (folder, anchor, button) => setMenu({ kind: 'folder', folder, anchor, button }),
                    onTabMenu: (tab, anchor, button) => setMenu({ kind: 'folded-tab', tab, anchor, button }),
                    onFoldThisWindow: () => thisWindow && foldWindow(thisWindow),
                  }}
                />
              </div>
            )}
          </main>
          <footer className="flex h-11 flex-none items-center justify-between gap-3 border-t border-border bg-bg-subtle px-3.5">
            <button
              type="button"
              onClick={() => void openLibrary()}
              className="inline-flex flex-none items-center gap-1.5 rounded-control font-semibold text-accent-text hover:underline"
            >
              <Layers size={16} strokeWidth={1.75} aria-hidden />
              Open the full list
            </button>
            {empty && room ? <span className="text-small text-text-3 tabular-nums">0 of {room.limit.toLocaleString()} tabs</span> : footerCount}
          </footer>
        </>
      )}

      {menu && (menu.kind === 'window' || menu.kind === 'fold-into') && (
        <WindowMenu
          anchor={menu.anchor}
          returnFocus={menu.button}
          name={menu.kind === 'window' ? menu.info.name : (menu.info?.name ?? 'this tab')}
          folders={intoFolders}
          counts={counts}
          starred={starred}
          folderLimit={folderLimit}
          start={menu.kind === 'fold-into' ? 'into' : 'menu'}
          heading={
            menu.kind === 'fold-into'
              ? menu.tab
                ? { title: 'Fold this tab into', right: undefined }
                : { title: `Fold “${menu.info?.name ?? 'this window'}” into` }
              : undefined
          }
          copies={menu.kind === 'window' ? copiesIn(infos, menu.info.id).pages : 0}
          canFold={menu.kind === 'window' ? menu.info.folds && menu.info.foldable.length > 0 : true}
          onFoldInto={(target) => {
            if (menu.kind === 'fold-into' && menu.tab) foldTabInto(menu.tab.id, target);
            else if (menu.info) foldWindow(menu.info, target);
          }}
          onTidy={menu.kind === 'window' && !menu.info.incognito ? () => void tidyWindow(menu.info.id) : undefined}
          onRename={menu.kind === 'window' && !menu.info.incognito ? () => setRenaming(menu.info.id) : undefined}
          onCloseCopies={menu.kind === 'window' ? () => void closeCopies(menu.info.id) : undefined}
          onUpgrade={toPlans}
          onClose={() => setMenu(null)}
        />
      )}
      {menu && (menu.kind === 'open-tab' || menu.kind === 'folded-tab' || menu.kind === 'folder') && (
        <Menu
          key={`${menu.kind}`}
          anchor={menu.anchor}
          entries={menuEntries(menu)}
          label={menu.kind === 'folder' ? `More for ${menu.folder.name}` : `More for ${menu.tab.title || menu.tab.url}`}
          width={menu.kind === 'folder' ? 240 : 220}
          returnFocus={menu.button}
          onClose={() => setMenu((m) => (m === menu ? null : m))}
        />
      )}
      <ToastViewport className="bottom-14" />
    </div>
  );
}
