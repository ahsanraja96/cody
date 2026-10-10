import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { chunk, findOpenCopy, fitBounds, refuseToOpen, safeGroupColor } from '@/lib/background/restorePlan';
import { singleFlight } from '@/lib/background/singleFlight';
import { suspendDecision } from '@/lib/background/suspend';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { OWN, tab } from './fixtures';

describe('restore planning', () => {
  const screen = { left: 0, top: 0, width: 1440, height: 900 };

  it('keeps bounds that fit the current screen and drops ones on a missing monitor', () => {
    expect(fitBounds({ left: 100, top: 50, width: 1000, height: 700 }, screen)).toEqual({ left: 100, top: 50, width: 1000, height: 700 });
    expect(fitBounds({ left: 2600, top: 0, width: 1200, height: 800 }, screen)).toBeNull();
    expect(fitBounds({ left: 0, top: 0, width: 1000, height: 700 }, undefined)).toBeNull();
  });

  it('shrinks windows larger than the screen', () => {
    expect(fitBounds({ left: 0, top: 0, width: 1600, height: 1000 }, screen)).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  });

  it('opens in batches of ten', () => {
    expect(chunk(Array.from({ length: 23 }, (_, i) => i), 10).map((c) => c.length)).toEqual([10, 10, 3]);
  });

  it('notices a session that is already open', () => {
    const open = [
      { id: 1, tabs: [{ url: 'https://x.com' }] },
      { id: 2, tabs: [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'https://c.com' }, { url: 'https://d.com' }] },
    ];
    expect(findOpenCopy(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com', 'https://e.com'], open)).toBe(2);
    expect(findOpenCopy(['https://a.com', 'https://z.com', 'https://y.com'], open)).toBeUndefined();
    // A two-window session restored into two windows still counts, as do lazily restored tabs.
    const split = [
      { id: 7, tabs: [{ url: 'https://a.com' }, { url: '', pendingUrl: 'https://b.com' }, { url: 'https://c.com' }] },
      { id: 8, tabs: [{ url: 'https://d.com' }] },
    ];
    expect(findOpenCopy(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'], split)).toBe(7);
  });

  it('falls back to grey for unknown group colours and refuses scripts and own pages', () => {
    expect(safeGroupColor('teal')).toBe('grey');
    expect(safeGroupColor('cyan')).toBe('cyan');
    expect(refuseToOpen('javascript:alert(1)', OWN)).toBe(true);
    expect(refuseToOpen(`${OWN}library.html`, OWN)).toBe(true);
    expect(refuseToOpen('https://a.com', OWN)).toBe(false);
  });
});

describe('suspendDecision', () => {
  const settings = DEFAULT_SETTINGS;
  it.each([
    [{ active: true }, 'active'],
    [{ discarded: true }, 'already'],
    [{ pinned: true }, 'pinned'],
    [{ audible: true }, 'audible'],
    [{ url: 'https://meet.google.com/abc' }, 'protectedSite'],
    [{ url: 'https://us02web.zoom.us/j/1' }, 'protectedSite'],
    [{ url: 'chrome://settings' }, 'not-web'],
    [{}, 'suspend'],
  ])('%o -> %s', (extra, expected) => {
    expect(suspendDecision(tab('https://news.example', extra), settings)).toBe(expected);
  });

  it('only auto-suspends tabs idle longer than the timer', () => {
    const now = 10_000_000;
    const idleBefore = now - 30 * 60_000;
    expect(suspendDecision(tab('https://a.com', { lastAccessed: now - 60_000 }), settings, idleBefore)).toBe('recent');
    expect(suspendDecision(tab('https://a.com', { lastAccessed: now - 31 * 60_000 }), settings, idleBefore)).toBe('suspend');
    expect(suspendDecision(tab('https://a.com'), settings, idleBefore)).toBe('recent');
  });
});

describe('singleFlight', () => {
  it('runs a double-click once', async () => {
    const once = singleFlight<number>(500);
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
    const [a, b] = await Promise.all([once('save-all', run), once('save-all', run)]);
    expect([a, b]).toEqual([42, 42]);
    expect(await once('save-all', run)).toBe(42);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs different requests one after another, never sharing a result', async () => {
    const once = singleFlight<string>(500);
    const order: string[] = [];
    const job = (name: string, ms: number) => async () => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([once('window-1', job('a', 20)), once('window-2', job('b', 1))]);
    expect(results).toEqual(['a', 'b']);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('forgets a failed run so a retry works', async () => {
    const once = singleFlight<number>(500);
    await expect(once('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await once('k', async () => 7)).toBe(7);
  });
});

describe('save never closes before the write is confirmed', () => {
  async function openTabs(urls: string[]) {
    const window = (await fakeBrowser.windows.create({}))!;
    const ids: number[] = [];
    for (const url of urls) {
      const created = await fakeBrowser.tabs.create({ windowId: window.id, url });
      ids.push(created.id!);
    }
    return { windowId: window.id!, ids };
  }

  it('closes saved tabs only after they are in the database', async () => {
    const { db } = await import('@/lib/db');
    const { handleSave } = await import('@/lib/background/save');
    const { windowId } = await openTabs(['https://a.com', 'https://b.com']);
    let savedWhenClosing = -1;
    const remove = vi.spyOn(fakeBrowser.tabs, 'remove').mockImplementation(async () => {
      savedWhenClosing = await db.tabs.count();
    });
    const outcome = await handleSave({ type: 'save', scope: 'window', windowId, close: true });
    expect(outcome.savedTabs).toBe(2);
    expect(remove).toHaveBeenCalled();
    expect(savedWhenClosing).toBe(2);
  });

  it('closes nothing when the write fails', async () => {
    const { db } = await import('@/lib/db');
    const { handleSave } = await import('@/lib/background/save');
    const { windowId } = await openTabs(['https://c.com']);
    const remove = vi.spyOn(fakeBrowser.tabs, 'remove');
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    // scope 'all' so this request isn't merged with the previous test's identical one (window ids repeat after reset).
    await expect(handleSave({ type: 'save', scope: 'all', windowId, close: true })).rejects.toThrow(/storage is full/);
    expect(remove).not.toHaveBeenCalled();
  });
});
