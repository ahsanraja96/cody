import { describe, expect, it } from 'vitest';
import { findOpenCopies } from '@/lib/openCopies';
import { folderForGroup } from '@/lib/foldBack';
import { addToWeek, lastWeekKey, summaryToShow, weekKey } from '@/lib/weekly';
import type { FolderRecord } from '@/lib/types';

describe('findOpenCopies', () => {
  it('keeps the copy looked at last and closes the rest', () => {
    const copies = findOpenCopies([
      { id: 1, url: 'https://a.com/x', lastAccessed: 10 },
      { id: 2, url: 'https://a.com/x/', lastAccessed: 30 },
      { id: 3, url: 'https://a.com/x', lastAccessed: 20 },
      { id: 4, url: 'https://b.com/', lastAccessed: 5 },
    ]);
    expect(copies).toMatchObject({ pages: 1, extra: 2 });
    expect(copies.groups[0]).toMatchObject({ keepTabId: 2, closeTabIds: [3, 1] });
  });

  it('prefers the active tab, never closes pinned or playing tabs, and skips non-web pages', () => {
    const copies = findOpenCopies([
      { id: 1, url: 'https://a.com/', active: true, lastAccessed: 1 },
      { id: 2, url: 'https://a.com/', pinned: true, lastAccessed: 9 },
      { id: 3, url: 'https://a.com/', audible: true, lastAccessed: 8 },
      { id: 4, url: 'chrome://newtab/' },
      { id: 5, url: 'chrome://newtab/' },
    ]);
    expect(copies).toEqual({ pages: 0, extra: 0, groups: [] });
  });

  it('keeps the copy the person looked at last, not one that only opened in the background since', () => {
    const tabs = [
      { id: 1, url: 'https://a.com/x', lastAccessed: 100 },
      { id: 2, url: 'https://a.com/x', lastAccessed: 200 },
      { id: 3, url: 'https://a.com/x', lastAccessed: 300 },
    ];
    // Copy 2 was looked at; copy 3 just opened in the background (Chrome stamps it newest).
    expect(findOpenCopies(tabs, { 2: 150 }).groups[0]).toMatchObject({ keepTabId: 2, closeTabIds: [3, 1] });
    // Without anything looked at, Chrome's lastAccessed decides.
    expect(findOpenCopies(tabs).groups[0]?.keepTabId).toBe(3);
  });

  it('never counts an Incognito tab as a copy of a normal one', () => {
    expect(findOpenCopies([{ id: 1, url: 'https://a.com/' }, { id: 2, url: 'https://a.com/', incognito: true }]).pages).toBe(0);
  });
});

describe('folderForGroup', () => {
  const folder = (id: string, name: string, updatedAt = 1, deletedAt = 0): FolderRecord => ({
    id, name, color: 'blue', order: 0, createdAt: 1, updatedAt, deletedAt,
  });
  const folders = [folder('aaaaaaaaaaaa', 'Client sites'), folder('bbbbbbbbbbbb', 'Recipes', 5), folder('cccccccccccc', 'recipes', 9), folder('dddddddddddd', 'Old', 1, 7)];

  it('follows the link made when the folder was opened', () => {
    expect(folderForGroup({ id: 4, title: 'Anything' }, { 4: 'aaaaaaaaaaaa' }, folders)?.id).toBe('aaaaaaaaaaaa');
  });
  it('matches the group title after a restart, the newest folder of that name', () => {
    expect(folderForGroup({ id: 9, title: ' RECIPES ' }, {}, folders)?.id).toBe('cccccccccccc');
  });
  it('ignores deleted folders and untitled groups', () => {
    expect(folderForGroup({ id: 1, title: 'Old' }, {}, folders)).toBeNull();
    expect(folderForGroup({ id: 1, title: '' }, {}, folders)).toBeNull();
    expect(folderForGroup({ id: 1 }, { 1: 'dddddddddddd' }, folders)).toBeNull();
  });
});

describe('weekly summary', () => {
  const sunday = new Date(2026, 9, 11, 22).getTime();
  const monday = new Date(2026, 9, 12, 9).getTime();

  it('weeks start on Monday', () => {
    expect(weekKey(sunday)).toBe('2026-10-05');
    expect(weekKey(monday)).toBe('2026-10-12');
    expect(lastWeekKey(monday)).toBe('2026-10-05');
  });

  it('adds up a week and keeps the last 8', () => {
    let stats = {};
    for (let i = 0; i < 10; i += 1) stats = addToWeek(stats, monday + i * 7 * 86_400_000, { folded: 1 });
    stats = addToWeek(stats, monday + 9 * 7 * 86_400_000, { folded: 2, freedBytes: 5, cameBack: 1 });
    expect(Object.keys(stats)).toHaveLength(8);
    expect(Object.values(stats).at(-1)).toEqual({ folded: 3, freedBytes: 5, cameBack: 1 });
  });

  it('shows last week once folded, until put away this week or turned off', () => {
    const stats = addToWeek({}, sunday, { folded: 340, freedBytes: 12e9, cameBack: 28 });
    expect(summaryToShow(stats, monday, undefined, true)).toEqual({ folded: 340, freedBytes: 12e9, cameBack: 28, week: '2026-10-05' });
    expect(summaryToShow(stats, monday, '2026-10-12', true)).toBeNull();
    expect(summaryToShow(stats, monday, undefined, false)).toBeNull();
    expect(summaryToShow({}, monday, undefined, true)).toBeNull();
  });
});
