import { describe, expect, it } from 'vitest';
import type { Browser } from 'wxt/browser';
import type { FoldOutcome } from '@/lib/messages';
import type { FolderRecord } from '@/lib/types';
import { aboutBytes, weeklyText } from '@/ui/components/Weekly';
import { cleanNote } from '@/ui/components/NoteField';
import { autoFoldText } from '@/ui/limits';
import { folderCounts, starredFirst } from '@/ui/folders';
import {
  closedText,
  copiesIn,
  copiesText,
  foldBackFolders,
  foldBackText,
  foldOutcomeText,
  groupedText,
  matchingFolders,
  openHitsFirstHere,
  openSearchDocs,
} from '@/ui/openTabs';
import { describeWindows, type WindowInfo } from '@/ui/windows';

const GB = 1024 ** 3;

const folder = (id: string, name: string, extra: Partial<FolderRecord> = {}): FolderRecord => ({
  id,
  name,
  color: 'green',
  order: 0,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: 0,
  ...extra,
});

const tab = (id: number, windowId: number, url: string, extra: Partial<Browser.tabs.Tab> = {}) =>
  ({ id, windowId, url, title: url, index: id, active: false, pinned: false, highlighted: false, incognito: false, groupId: -1, ...extra }) as Browser.tabs.Tab;

function windows(): WindowInfo[] {
  return describeWindows(
    [
      { id: 1, name: '', focused: true, incognito: false, tabs: [tab(1, 1, 'https://a.com/', { active: true }), tab(2, 1, 'https://b.com/')] },
      { id: 2, name: 'Client work', focused: false, incognito: false, tabs: [tab(3, 2, 'https://b.com/', { lastAccessed: 5 }), tab(4, 2, 'https://c.com/')] },
      { id: 3, name: '', focused: false, incognito: false, tabs: [tab(5, 3, 'https://c.com/', { lastAccessed: 9 })] },
    ],
    { currentWindowId: 1, keepPinnedOpen: true, foldsIncognito: false, ownOrigin: 'chrome-extension://x/' },
  );
}

describe('1.0 screens: wording', () => {
  it('words the weekly summary with plurals and rounded sizes', () => {
    expect(weeklyText({ folded: 340, freedBytes: 12 * GB, cameBack: 28 })).toBe(
      'Last week you folded 340 tabs and freed about 12 GB. 28 came back when you needed them.',
    );
    expect(weeklyText({ folded: 1, freedBytes: 0, cameBack: 1 })).toBe('Last week you folded 1 tab. 1 came back when you needed it.');
    expect(weeklyText({ folded: 9, freedBytes: 1.6 * GB, cameBack: 0 })).toBe('Last week you folded 9 tabs and freed about 1.6 GB.');
    expect(aboutBytes(480 * 1024 * 1024)).toBe('about 480 MB');
  });

  it('says what a fold did with folders', () => {
    const base = { savedTabs: 12, skippedDuplicates: 0 } as FoldOutcome;
    expect(foldOutcomeText({ ...base, intoFolder: { folderId: 'f', name: 'Client sites' } })).toBe('Folded 12 tabs into Client sites');
    expect(foldOutcomeText({ ...base, backIntoFolders: [{ folderId: 'f', name: 'Client sites', tabs: 5 }] })).toBe('Folded 12 tabs · 5 went back into Client sites');
    expect(foldOutcomeText({ ...base, savedTabs: 1 }, ' · freed ~50 MB')).toBe('Folded 1 tab · freed ~50 MB');
    expect(closedText(3)).toBe('Closed 3 copies');
    expect(closedText(1)).toBe('Closed 1 copy');
    expect(groupedText(18, 4)).toBe('Grouped 18 tabs into 4 groups');
  });

  it('names the window a cap rule folded in', () => {
    const notice = { ruleId: 'r', label: 'your 25-tab rule', folded: 6, freedBytes: 0, at: Date.now(), actionId: null };
    expect(autoFoldText({ ...notice, windowName: 'Client work' })).toBe('Folded 6 tabs in Client work (your 25-tab rule)');
    expect(autoFoldText(notice)).toMatch(/^Folded 6 tabs at \d\d:\d\d \(your 25-tab rule\)$/);
  });

  it('keeps a note to one line of 140 characters', () => {
    expect(cleanNote('  Waiting on\nthe   client  ')).toBe('Waiting on the client');
    expect([...cleanNote('é'.repeat(200))].length).toBe(140);
  });
});

describe('1.0 screens: windows', () => {
  it('numbers windows by their place, named or not', () => {
    expect(windows().map((w) => w.name)).toEqual(['This window', 'Client work', 'Window 3']);
    expect(windows()[1]!.given).toBe('Client work');
  });

  it('counts pages open twice, everywhere and in one window', () => {
    const all = copiesIn(windows());
    expect(all.pages).toBe(2);
    expect(copiesText(all)).toBe('2 pages are open twice');
    // Each page's extra copy is in exactly one window, so the windows' own counts add up.
    expect(copiesIn(windows(), 3).pages + copiesIn(windows(), 2).pages + copiesIn(windows(), 1).pages).toBe(2);
  });

  it('lists open tabs for search: this window first, copies once, with window names', () => {
    const docs = openSearchDocs(windows(), 'chrome-extension://x/');
    expect(docs[0]!.windowLabel).toBe('This window');
    expect(new Set(docs.map((d) => d.url)).size).toBe(docs.length);
    const hits = docs.map((doc) => ({ doc })).reverse();
    expect(openHitsFirstHere(hits, 1)[0]!.doc.windowId).toBe(1);
  });

  it('finds the folder a window’s tab group folds back into', () => {
    const cs = folder('cs', 'Client sites');
    const group = { id: 7, title: 'Client sites' } as Browser.tabGroups.TabGroup;
    const tabs = [tab(1, 1, 'https://a.com/', { groupId: 7 })];
    expect(foldBackFolders(tabs, new Map([[7, group]]), {}, [cs])).toEqual([cs]);
    expect(foldBackFolders(tabs, new Map(), { 7: 'cs' }, [cs])).toEqual([cs]);
    expect(foldBackText([cs])).toBe('Its “Client sites” group folds back into the folder');
  });
});

describe('1.0 screens: folders', () => {
  it('puts starred folders first and keeps each part in order', () => {
    const list = [folder('a', 'A'), folder('b', 'B', { starredAt: 5 }), folder('c', 'C', { teamId: 't' }), folder('d', 'D')];
    expect(starredFirst(list, { c: 9 }).map((f) => f.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('matches folders by every typed word and counts their tabs', () => {
    const list = [folder('h', 'Holiday in Lisbon'), folder('c', 'Client sites')];
    expect(matchingFolders(list, 'lisbon').map((f) => f.id)).toEqual(['h']);
    expect(matchingFolders(list, 'holiday porto')).toEqual([]);
    expect(matchingFolders(list, '#lisbon')).toEqual([]);
    const counts = folderCounts([
      { folderId: 'h' } as never,
      { folderId: 'h', snoozeUntil: 5 } as never,
      { folderId: 'c' } as never,
    ]);
    expect([counts.get('h'), counts.get('c')]).toEqual([1, 1]);
  });
});
