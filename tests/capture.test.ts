import { describe, expect, it } from 'vitest';
import { aggregates, buildDraft, captureHash, isPlaceholderTitle, planCapture, wouldCloseEverything, type CaptureOptions } from '@/lib/capture';
import { capturedWindow, OWN, tab, win } from './fixtures';

const base: CaptureOptions = {
  scope: 'all',
  keepPinnedOpen: true,
  skipBlank: true,
  includeAllWindows: true,
  audible: 'keep',
  ownOrigin: OWN,
};

describe('planCapture', () => {
  it('saves every normal window as its own group and closes what it saved', () => {
    const a = tab('https://a.com');
    const b = tab('https://b.com');
    const c = tab('https://c.com');
    const plan = planCapture([win(1, [a, b]), win(2, [c])], new Map(), base);
    expect(plan.windows).toHaveLength(2);
    expect(plan.windows[0]!.tabs.map((t) => t.url)).toEqual(['https://a.com', 'https://b.com']);
    expect(plan.closeTabIds.sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('keeps pinned tabs open and out of the save when the setting is on', () => {
    const pinned = tab('https://mail.google.com', { pinned: true });
    const plan = planCapture([win(1, [pinned, tab('https://a.com')])], new Map(), base);
    expect(plan.kept.pinned).toBe(1);
    expect(plan.closeTabIds).not.toContain(pinned.id);
    expect(plan.windows[0]!.tabs).toHaveLength(1);

    const off = planCapture([win(1, [pinned])], new Map(), { ...base, keepPinnedOpen: false });
    expect(off.windows[0]!.tabs[0]!.pinned).toBe(true);
    expect(off.closeTabIds).toContain(pinned.id);
  });

  it('keeps audible tabs open unless told to close them', () => {
    const music = tab('https://music.example', { audible: true });
    expect(planCapture([win(1, [music])], new Map(), base).kept.audible).toBe(1);
    expect(planCapture([win(1, [music])], new Map(), { ...base, audible: 'close' }).closeTabIds).toContain(music.id);
  });

  it('skips blank pages (closing them) and never touches its own pages', () => {
    const blank = tab('chrome://newtab/');
    const own = tab(`${OWN}library.html`);
    const plan = planCapture([win(1, [blank, own, tab('https://a.com')])], new Map(), base);
    expect(plan.skipped).toEqual({ blank: 1, own: 1 });
    expect(plan.closeTabIds).toContain(blank.id);
    expect(plan.closeTabIds).not.toContain(own.id);
  });

  it('ignores incognito and non-normal windows', () => {
    const plan = planCapture(
      [
        win(1, [tab('https://secret.com', { incognito: true })], { incognito: true }),
        win(2, [tab('https://devtools.com')], { type: 'devtools' }),
        win(3, [tab('https://ok.com')]),
      ],
      new Map(),
      base,
    );
    expect(plan.windows.map((w) => w.tabs[0]!.url)).toEqual(['https://ok.com']);
  });

  it('saves only one window for scope "window" (or "all" with other windows excluded)', () => {
    const windows = [win(1, [tab('https://a.com')]), win(2, [tab('https://b.com')])];
    expect(planCapture(windows, new Map(), { ...base, scope: 'window', windowId: 2 }).windows[0]!.tabs[0]!.url).toBe('https://b.com');
    expect(planCapture(windows, new Map(), { ...base, includeAllWindows: false, windowId: 1 }).windows).toHaveLength(1);
  });

  it('saves exactly the chosen tabs, pinned or not, with their keywords', () => {
    const pinned = tab('https://pinned.com', { pinned: true });
    const other = tab('https://other.com');
    const plan = planCapture([win(1, [pinned, other])], new Map(), {
      ...base,
      scope: 'tabs',
      tabIds: [pinned.id!],
      keywordsByTabId: { [pinned.id!]: ['Inbox', 'inbox', 'mail'] },
    });
    expect(plan.windows[0]!.tabs).toHaveLength(1);
    expect(plan.windows[0]!.tabs[0]!.keywords).toEqual(['inbox', 'mail']);
    expect(plan.closeTabIds).toEqual([pinned.id]);
  });

  it('records tab groups, falls back to the host for loading tabs, and keeps bounds', () => {
    const grouped = tab('https://docs.com/a', { groupId: 7, title: '' });
    const plan = planCapture(
      [win(1, [grouped], { left: 10, top: 20, width: 900, height: 700 })],
      new Map([[7, { id: 7, title: 'Docs', color: 'blue', collapsed: true }]]),
      base,
    );
    const saved = plan.windows[0]!.tabs[0]!;
    expect(saved).toMatchObject({ groupName: 'Docs', groupColor: 'blue', groupCollapsed: true, title: 'docs.com' });
    expect(plan.windows[0]!.bounds).toEqual({ left: 10, top: 20, width: 900, height: 700 });
  });

  it('treats the address Chrome shows as a title while loading as no title', () => {
    const shown = tab('http://127.0.0.1:8080/slow', { title: '127.0.0.1:8080/slow' });
    const www = tab('https://www.example.com/a/b', { title: 'www.example.com/a/b' });
    const real = tab('https://example.com/', { title: 'Example Domain' });
    const plan = planCapture([win(1, [shown, www, real])], new Map(), base);
    expect(plan.windows[0]!.tabs.map((t) => t.title)).toEqual(['127.0.0.1', 'example.com', 'Example Domain']);
    expect(isPlaceholderTitle('', 'https://a.com')).toBe(true);
    expect(isPlaceholderTitle('a.com/x', 'https://a.com/x')).toBe(true);
    expect(isPlaceholderTitle('A page', 'https://a.com/x')).toBe(false);
  });

  it('saves an Incognito window only for scope "window" or "tabs" with includeIncognito', () => {
    const secret = tab('https://secret.com', { incognito: true });
    const windows = [win(1, [tab('https://ok.com')]), win(2, [secret], { incognito: true })];
    expect(planCapture(windows, new Map(), { ...base, scope: 'window', windowId: 2 }).windows).toHaveLength(0);
    expect(planCapture(windows, new Map(), { ...base, scope: 'window', windowId: 2, includeIncognito: true }).windows[0]!.tabs[0]!.url).toBe('https://secret.com');
    expect(planCapture(windows, new Map(), { ...base, scope: 'tabs', tabIds: [secret.id!], includeIncognito: true }).closeTabIds).toEqual([secret.id]);
    expect(planCapture(windows, new Map(), { ...base, includeIncognito: true }).windows).toHaveLength(1);
  });

  it('unknown group colours become grey', () => {
    const plan = planCapture([win(1, [tab('https://a.com', { groupId: 3 })])], new Map([[3, { id: 3, color: 'mauve', collapsed: false }]]), base);
    expect(plan.windows[0]!.tabs[0]!.groupColor).toBe('grey');
  });
});

describe('wouldCloseEverything', () => {
  it('is true only when no tab in any normal window would stay open', () => {
    const a = tab('https://a.com');
    const b = tab('https://b.com');
    const windows = [win(1, [a]), win(2, [b])];
    expect(wouldCloseEverything(windows, [a.id!, b.id!])).toBe(true);
    expect(wouldCloseEverything(windows, [a.id!])).toBe(false);
  });

  it('ignores Incognito windows unless they are the only ones open', () => {
    const a = tab('https://a.com');
    const p = tab('https://p.com', { incognito: true });
    const q = tab('https://q.com', { incognito: true });
    expect(wouldCloseEverything([win(1, [a]), win(2, [p], { incognito: true })], [a.id!])).toBe(true);
    expect(wouldCloseEverything([win(2, [p, q], { incognito: true })], [p.id!])).toBe(false);
    expect(wouldCloseEverything([win(2, [p, q], { incognito: true })], [p.id!, q.id!])).toBe(true);
  });
});

describe('buildDraft', () => {
  it('builds one row per session, window and tab with counts and a favicon strip', () => {
    const { draft } = buildDraft([capturedWindow(['https://a.com', 'https://b.com']), capturedWindow(['https://c.com'])], {
      source: 'save-all',
      deviceId: 'd1',
      now: Date.UTC(2026, 9, 10, 14, 32),
      dedupe: true,
    });
    expect(draft.session).toMatchObject({ tabCount: 3, windowCount: 2, deletedAt: 0, pinned: 0, kind: 'session' });
    expect(draft.session.preview.map((p) => p.url)).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    expect(draft.windows.map((w) => w.order)).toEqual([0, 1]);
    expect(new Set(draft.tabs.map((t) => t.sessionId))).toEqual(new Set([draft.session.id]));
  });

  it('skips duplicates within the save and against existing addresses', () => {
    const { draft, skippedDuplicates } = buildDraft([capturedWindow(['https://a.com', 'https://a.com/', 'https://b.com'])], {
      source: 'save-all',
      deviceId: 'd1',
      now: 1,
      dedupe: true,
      existingUrls: ['https://b.com'],
    });
    expect(draft.tabs.map((t) => t.url)).toEqual(['https://a.com']);
    expect(skippedDuplicates).toBe(2);
  });

  it('keeps duplicates when asked', () => {
    const { draft } = buildDraft([capturedWindow(['https://a.com', 'https://a.com'])], { source: 'save-all', deviceId: 'd', now: 1, dedupe: false });
    expect(draft.tabs).toHaveLength(2);
  });
});

describe('aggregates and hashes', () => {
  it('prefers one favicon per host in the preview', () => {
    const tabs = ['https://a.com/1', 'https://a.com/2', 'https://b.com'].map((url, order) => ({ url, title: url, order, windowId: 'w' }));
    expect(aggregates([{ id: 'w', order: 0 }], tabs).preview.map((p) => p.url)).toEqual(['https://a.com/1', 'https://b.com', 'https://a.com/2']);
  });

  it('gives the same hash for the same open tabs', () => {
    expect(captureHash([capturedWindow(['https://a.com'])])).toBe(captureHash([capturedWindow(['https://a.com'])]));
    expect(captureHash([capturedWindow(['https://a.com'])])).not.toBe(captureHash([capturedWindow(['https://b.com'])]));
  });
});
