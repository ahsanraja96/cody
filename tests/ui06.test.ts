import { describe, expect, it } from 'vitest';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { cleanFolderName, groupTabs, isSnoozed, nextFolderColor } from '@/ui/folders';
import { autoFoldText, listFullFrom } from '@/ui/limits';
import { looksLikeQuestion } from '@/entrypoints/library/ask';
import { foldedAgo } from '@/entrypoints/library/LimitBits';
import { freeRule } from '@/entrypoints/library/AutoFold';
import { importSummary } from '@/ui/ImportPanel';

/** UI-only helpers of the 0.6 screens (no worker, no DOM). */

let n = 0;
function tab(url: string, extra: Partial<TabRecord> = {}): TabRecord {
  n += 1;
  return {
    id: `t${n}`,
    sessionId: 's',
    windowId: 'w',
    url,
    title: url,
    favIconUrl: '',
    pinned: false,
    groupName: null,
    groupColor: null,
    groupCollapsed: false,
    order: n,
    savedAt: 1000 + n,
    keywords: [],
    urlTruncated: false,
    ...extra,
  };
}

function folder(id: string, name: string, order: number): FolderRecord {
  return { id, name, color: 'purple', order, createdAt: 1, updatedAt: 1, deletedAt: 0 };
}

describe('grouping folded tabs (Fo-List)', () => {
  it('puts snoozed tabs apart, then folders in their order (empty ones too), then kinds of site', () => {
    const folders = [folder('a', 'Truewidgets', 0), folder('b', 'Client sites', 1), folder('c', 'Holiday', 2)];
    const tabs = [
      tab('https://github.com/x', { folderId: 'b' }),
      tab('https://web.whatsapp.com/'),
      tab('https://claude.ai/new', { snoozeUntil: 5000 }),
      tab('https://truewidgets.com/', { folderId: 'a' }),
      tab('https://example.com/gone', { folderId: 'deleted' }),
      tab('https://stripe.com/pricing', { snoozeUntil: 3000 }),
    ];
    const grouped = groupTabs(tabs, folders);
    expect(grouped.snoozed.map((t) => t.url)).toEqual(['https://stripe.com/pricing', 'https://claude.ai/new']);
    expect(grouped.folders.map((g) => [g.name, g.items.length])).toEqual([
      ['Truewidgets', 1],
      ['Client sites', 1],
      ['Holiday', 0],
    ]);
    // A tab whose folder no longer exists goes back to its kind of site.
    expect(grouped.sites.map((g) => g.categoryId).sort()).toEqual(['mail', 'other']);
    expect(grouped.sites.find((g) => g.categoryId === 'other')!.items[0]!.url).toBe('https://example.com/gone');
  });

  it('follows the sites the person moved', () => {
    const grouped = groupTabs([tab('https://fiverr.com/orders')], [], { 'fiverr.com': { kind: 'dev', at: 1 } });
    expect(grouped.sites.map((g) => g.name)).toEqual(['Dev']);
  });

  it('knows a snoozed tab, names a folder, and picks the next colour', () => {
    expect(isSnoozed({ snoozeUntil: 10 })).toBe(true);
    expect(isSnoozed({})).toBe(false);
    expect(cleanFolderName('  Holiday    in  Lisbon ')).toBe('Holiday in Lisbon');
    expect(cleanFolderName('x'.repeat(80))).toHaveLength(60);
    expect(nextFolderColor([])).toBe('purple');
    expect(nextFolderColor([{ color: 'purple' }, { color: 'green' }])).toBe('cyan');
  });
});

describe('limits and notices', () => {
  it('reads a fold that did not fit from the worker’s words', () => {
    expect(listFullFrom('This fold needs room for 23 tabs; your free list has room for 18.')).toEqual({ needed: 23, room: 18 });
    expect(listFullFrom('Your free list is full (500 tabs). Make room or upgrade for unlimited.')).toEqual({ needed: undefined, room: 0 });
    expect(listFullFrom('Chrome is out of storage space.')).toBeNull();
  });

  it('says what an automatic fold did', () => {
    const at = new Date(2026, 9, 12, 18, 0).getTime();
    expect(autoFoldText({ ruleId: 'r', label: 'your weekday rule', folded: 23, freedBytes: 1.1 * 1024 ** 3, at, actionId: null })).toBe(
      'Folded 23 tabs at 18:00 (your weekday rule) · freed ~1.1 GB',
    );
  });

  it('words a fold’s age in Make room', () => {
    const now = new Date(2026, 9, 12).getTime();
    expect(foldedAgo(now - 70 * 24 * 3_600_000, now)).toBe('Folded 10 weeks ago');
    expect(foldedAgo(now - 3 * 24 * 3_600_000, now)).toBe('Folded 3 days ago');
  });

  it('lets Free run only the "not looked at" rule into the kind of site', () => {
    expect(freeRule({ when: { type: 'idle', days: 3 }, into: { type: 'site' } })).toBe(true);
    expect(freeRule({ when: { type: 'idle', days: 3 }, into: { type: 'folder', folderId: 'a' } })).toBe(false);
    expect(freeRule({ when: { type: 'time', hour: 18, minute: 0, weekdays: [1] }, into: { type: 'site' } })).toBe(false);
  });
});

describe('Ask your tabs and imports', () => {
  it('offers Ask for questions and longer queries only', () => {
    expect(looksLikeQuestion('pricing page I looked at last week')).toBe(true);
    expect(looksLikeQuestion('where is the invoice?')).toBe(true);
    expect(looksLikeQuestion('stripe')).toBe(false);
    expect(looksLikeQuestion('stripe docs')).toBe(false);
  });

  it('sums up an import as the board says', () => {
    expect(importSummary({ sessions: 6, intoUnsorted: 0, tabs: 312, folders: 4, skippedOverLimit: 40, withoutFolder: 2, duplicates: 0 })).toEqual({
      title: 'Imported 312 tabs into 4 folders',
      details: ['2 collections went by site (Free has 3 folders)', '40 left out (free list full)'],
    });
    expect(importSummary({ sessions: 1, intoUnsorted: 0, tabs: 1, folders: 0, skippedOverLimit: 0, withoutFolder: 0, duplicates: 0 }).title).toBe('Imported 1 tab');
  });
});
