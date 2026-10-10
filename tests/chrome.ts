import { vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';

/**
 * A small in-memory Chrome for worker tests: windows, tabs and groups with the behaviour the
 * worker relies on (closing a window's last tab closes the window, discarding, refusing to close,
 * windows.create opening a New Tab). It replaces the matching fakeBrowser methods with spies.
 */

export interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
  pendingUrl?: string;
  title: string;
  pinned: boolean;
  audible: boolean;
  active: boolean;
  discarded: boolean;
  incognito: boolean;
  groupId: number;
  status: 'loading' | 'complete';
  favIconUrl?: string;
  lastAccessed?: number;
}

export interface FakeWindow {
  id: number;
  focused: boolean;
  incognito: boolean;
  type: 'normal' | 'popup';
  state: 'normal' | 'maximized';
  left: number;
  top: number;
  width: number;
  height: number;
}

type TabInput = string | (Partial<FakeTab> & { url: string });

// Ids never repeat across tests, so identical-looking saves in two tests are never merged by singleFlight.
let nextWindowId = 100;
let nextTabId = 1000;
let nextGroupId = 1;

export class FakeChrome {
  windows: FakeWindow[] = [];
  tabs: FakeTab[] = [];
  /** Tabs that refuse to close ("Leave site?"). */
  refuseClose = new Set<number>();
  /** Tabs that stay "loading" (a slow or stuck page). */
  stuckLoading = new Set<number>();
  mutedLog: Array<{ id: number; muted: boolean; status: string; discarded: boolean }> = [];
  discardLog: Array<{ id: number; status: string }> = [];
  fileAccess = false;
  groupsBlocked = false;
  groups: Array<{ id: number; title: string; color: string; collapsed: boolean; windowId: number }> = [];
  /** Messages the worker broadcast to pages. */
  broadcasts: Array<{ type: string; [key: string]: unknown }> = [];
  createdWindows: Array<Browser.windows.CreateData | undefined> = [];
  focusCalls: number[] = [];
  /** Runs before every windows.getAll (to simulate a tab opening while a save runs). */
  beforeWindowsRead?: () => Promise<void> | void;
  /** Runs before every tabs.query (to simulate someone answering "Leave site?" while a fold waits). */
  beforeTabsQuery?: () => void;
  /** chrome.system.memory.getInfo; unset means the API isn't available. */
  memoryInfo?: () => { capacity: number; availableCapacity: number };
  /** tabs.group throws (for example an organisation policy). */
  groupFails = false;

  openWindow(inputs: TabInput[], extra: Partial<FakeWindow> = {}): { windowId: number; tabIds: number[] } {
    const window: FakeWindow = {
      id: nextWindowId++,
      focused: false,
      incognito: false,
      type: 'normal',
      state: 'normal',
      left: 0,
      top: 0,
      width: 1200,
      height: 800,
      ...extra,
    };
    if (window.focused) for (const w of this.windows) w.focused = false;
    this.windows.push(window);
    const tabIds = inputs.map((input) => this.addTab(window.id, typeof input === 'string' ? { url: input } : input).id);
    return { windowId: window.id, tabIds };
  }

  addTab(windowId: number, input: Partial<FakeTab> & { url: string }): FakeTab {
    const window = this.windows.find((w) => w.id === windowId)!;
    const tab: FakeTab = {
      id: nextTabId++,
      windowId,
      index: this.tabs.filter((t) => t.windowId === windowId).length,
      title: `Title of ${input.url}`,
      pinned: false,
      audible: false,
      active: false,
      discarded: false,
      incognito: window.incognito,
      groupId: -1,
      status: 'complete',
      ...input,
    };
    this.tabs.push(tab);
    return tab;
  }

  tab(id: number): FakeTab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  webTabs(): FakeTab[] {
    return this.tabs.filter((t) => t.url.startsWith('http'));
  }

  events(type: string) {
    return this.broadcasts.filter((b) => b.type === type);
  }

  private windowView(window: FakeWindow, populate?: boolean): Browser.windows.Window {
    return {
      ...window,
      alwaysOnTop: false,
      tabs: populate
        ? this.tabs
            .filter((t) => t.windowId === window.id)
            .sort((a, b) => a.index - b.index)
            .map((t) => this.tabView(t))
        : undefined,
    } as Browser.windows.Window;
  }

  private tabView(tab: FakeTab): Browser.tabs.Tab {
    return { ...tab, highlighted: tab.active, selected: tab.active, autoDiscardable: true, frozen: false } as Browser.tabs.Tab;
  }

  /** A tab that showed "Leave site?" closes after all (the person chose Leave). */
  closeNow(id: number): void {
    this.refuseClose.delete(id);
    this.removeTab(id);
  }

  private removeTab(id: number): void {
    const tab = this.tab(id);
    if (!tab || this.refuseClose.has(id)) return;
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.tabs.filter((t) => t.windowId === tab.windowId).sort((a, b) => a.index - b.index).forEach((t, i) => (t.index = i));
    if (!this.tabs.some((t) => t.windowId === tab.windowId)) this.windows = this.windows.filter((w) => w.id !== tab.windowId);
  }

  install(): this {
    const b = fakeBrowser;
    vi.spyOn(b.windows, 'getAll').mockImplementation((async (info?: { populate?: boolean }) => {
      await this.beforeWindowsRead?.();
      return this.windows.map((w) => this.windowView(w, info?.populate));
    }) as never);
    vi.spyOn(b.windows, 'get').mockImplementation((async (id: number, info?: { populate?: boolean }) => {
      const window = this.windows.find((w) => w.id === id);
      if (!window) throw new Error(`No window with id: ${id}.`);
      return this.windowView(window, info?.populate);
    }) as never);
    vi.spyOn(b.windows, 'getLastFocused').mockImplementation((async (info?: { populate?: boolean }) => {
      const window = this.windows.find((w) => w.focused) ?? this.windows[0];
      if (!window) throw new Error('No last-focused window');
      return this.windowView(window, info?.populate);
    }) as never);
    vi.spyOn(b.windows, 'create').mockImplementation((async (data?: Browser.windows.CreateData) => {
      this.createdWindows.push(data);
      const { windowId } = this.openWindow([{ url: 'chrome://newtab/', title: 'New Tab', active: true }], {
        focused: !!data?.focused,
        incognito: !!data?.incognito,
      });
      return this.windowView(this.windows.find((w) => w.id === windowId)!, true);
    }) as never);
    vi.spyOn(b.windows, 'update').mockImplementation((async (id: number, info: Browser.windows.UpdateInfo) => {
      const window = this.windows.find((w) => w.id === id);
      if (!window) throw new Error(`No window with id: ${id}.`);
      if (info.focused) {
        for (const w of this.windows) w.focused = w.id === id;
        this.focusCalls.push(id);
      }
      return this.windowView(window);
    }) as never);

    vi.spyOn(b.tabs, 'query').mockImplementation((async (q: Browser.tabs.QueryInfo = {}) => {
      this.beforeTabsQuery?.();
      return this.tabs
        .filter((t) => {
          const window = this.windows.find((w) => w.id === t.windowId);
          if (q.windowId !== undefined && t.windowId !== q.windowId) return false;
          if (q.windowType !== undefined && window?.type !== q.windowType) return false;
          if (q.discarded !== undefined && t.discarded !== q.discarded) return false;
          if (q.active !== undefined && t.active !== q.active) return false;
          if (q.lastFocusedWindow && !window?.focused) return false;
          return true;
        })
        .map((t) => this.tabView(t));
    }) as never);
    vi.spyOn(b.tabs, 'get').mockImplementation((async (id: number) => {
      const tab = this.tab(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      // Pages finish loading by the time anyone looks, unless a test holds them back.
      if (tab.status === 'loading' && !this.stuckLoading.has(id)) tab.status = 'complete';
      return this.tabView(tab);
    }) as never);
    vi.spyOn(b.tabs, 'update').mockImplementation((async (id: number, info: Browser.tabs.UpdateProperties) => {
      const tab = this.tab(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      if (info.muted !== undefined) this.mutedLog.push({ id, muted: info.muted, status: tab.status, discarded: !!tab.discarded });
      if (info.active) {
        for (const t of this.tabs) if (t.windowId === tab.windowId) t.active = false;
        tab.active = true;
      }
      return this.tabView(tab);
    }) as never);
    vi.spyOn(b.tabs, 'create').mockImplementation((async (data: Browser.tabs.CreateProperties) => {
      const windowId = data.windowId ?? (this.windows.find((w) => w.focused) ?? this.windows[0])!.id;
      if (!this.windows.some((w) => w.id === windowId)) throw new Error(`No window with id: ${windowId}.`);
      if (data.url?.startsWith('chrome://crash')) throw new Error('Cannot open');
      if (data.active) for (const t of this.tabs) if (t.windowId === windowId) t.active = false;
      const tab = this.addTab(windowId, {
        url: data.url ?? 'chrome://newtab/',
        title: '',
        status: 'loading',
        active: !!data.active,
        pinned: !!data.pinned,
      });
      return this.tabView(tab);
    }) as never);
    vi.spyOn(b.tabs, 'remove').mockImplementation((async (ids: number | number[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) this.removeTab(id);
    }) as never);
    vi.spyOn(b.tabs, 'discard').mockImplementation((async (id?: number) => {
      const tab = id !== undefined ? this.tab(id) : undefined;
      if (!tab || tab.active) throw new Error('Cannot discard');
      this.discardLog.push({ id: tab.id, status: tab.status });
      tab.discarded = true;
      return this.tabView(tab);
    }) as never);
    vi.spyOn(b.tabs, 'group').mockImplementation((async (options: { tabIds: number[]; createProperties?: { windowId?: number } }) => {
      if (this.groupFails) throw new Error('Tab groups are blocked by policy');
      const id = nextGroupId++;
      this.groups.push({ id, title: '', color: 'grey', collapsed: false, windowId: options.createProperties?.windowId ?? -1 });
      for (const tabId of options.tabIds) {
        const tab = this.tab(tabId);
        if (tab) tab.groupId = id;
      }
      return id;
    }) as never);
    vi.spyOn(b.tabGroups, 'query').mockImplementation((async () => {
      if (this.groupsBlocked) throw new Error('Tab groups are blocked by policy');
      return this.groups.map((g) => ({ ...g }));
    }) as never);
    vi.spyOn(b.tabGroups, 'update').mockImplementation((async (id: number, props: { title?: string; color?: string; collapsed?: boolean }) => {
      const group = this.groups.find((g) => g.id === id);
      if (group) Object.assign(group, props);
      return group;
    }) as never);
    vi.spyOn(b.extension, 'isAllowedFileSchemeAccess').mockImplementation((async () => this.fileAccess) as never);
    vi.spyOn(b.runtime, 'sendMessage').mockImplementation((async (message: { __tabfoldEvent?: boolean; event?: { type: string } }) => {
      if (message?.__tabfoldEvent && message.event) this.broadcasts.push(message.event as FakeChrome['broadcasts'][number]);
      return undefined;
    }) as never);
    vi.spyOn(b.system.memory, 'getInfo').mockImplementation((async () => {
      if (!this.memoryInfo) throw new Error('system.memory is not available');
      return this.memoryInfo();
    }) as never);
    vi.spyOn(b.action, 'setBadgeText').mockImplementation((async () => undefined) as never);
    vi.spyOn(b.action, 'setBadgeBackgroundColor').mockImplementation((async () => undefined) as never);
    return this;
  }
}
