import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { saveListToBookmarks } from '@/lib/bookmarks';
import { exportCsv, exportFileName, exportJson, exportMarkdown, formatDay, type TabfoldJsonExport } from '@/lib/exporters';
import { CommandError } from '@/lib/messages';
import { saveCapture } from '@/lib/repo';
import type { SessionGraph, TabRecord } from '@/lib/types';
import { capturedWindow } from './fixtures';

afterEach(() => {
  vi.restoreAllMocks();
});

const AT = new Date(2026, 9, 10, 14, 32).getTime();

let nextId = 1;

function tab(url: string, title: string, extra: Partial<TabRecord> = {}): TabRecord {
  return {
    id: `t${nextId++}`,
    sessionId: 's',
    windowId: 'w',
    url,
    title,
    favIconUrl: '',
    pinned: false,
    groupName: null,
    groupColor: null,
    groupCollapsed: false,
    order: 0,
    savedAt: Date.UTC(2026, 9, 10, 12, 0, 5),
    keywords: [],
    urlTruncated: false,
    ...extra,
  };
}

function graph(name: string, windows: Array<{ name?: string; tabs: TabRecord[] }>, extra: { smartName?: string; createdAt?: number } = {}): SessionGraph {
  const id = `s${nextId++}`;
  return {
    session: {
      id,
      name,
      tags: [],
      pinned: 0,
      color: null,
      kind: 'session',
      source: 'save-all',
      createdAt: extra.createdAt ?? AT,
      updatedAt: extra.createdAt ?? AT,
      deletedAt: 0,
      deviceId: 'd',
      version: 1,
      tabCount: windows.reduce((n, w) => n + w.tabs.length, 0),
      windowCount: windows.length,
      preview: [],
      ...(extra.smartName ? { smartName: extra.smartName } : {}),
    },
    windows: windows.map((w, i) => ({
      id: `${id}-w${i}`,
      sessionId: id,
      name: w.name ?? '',
      order: i,
      wasFocused: false,
      bounds: null,
      state: null,
      tabs: w.tabs,
    })),
  };
}

describe('exports', () => {
  const graphs = () => [
    graph('Oct 10 · 14:32', [{ tabs: [tab('https://github.com/acme/pull/1', 'Fix [retries], again'), tab('https://a.com/x (1)', '')] }], {
      smartName: 'Checkout app',
    }),
    graph(
      'Reading',
      [
        { name: 'Research', tabs: [tab('https://en.wikipedia.org/wiki/Foo', 'Foo')] },
        { tabs: [tab('https://b.com', 'B')] },
      ],
      { createdAt: new Date(2026, 8, 3, 9, 0).getTime() },
    ),
  ];

  it('names files by day, with the format’s extension', () => {
    expect(exportFileName(AT)).toBe('tabfold-export-2026-10-10.html');
    expect(exportFileName(AT, 'md')).toBe('tabfold-export-2026-10-10.md');
    expect(exportFileName(AT, '.csv')).toBe('tabfold-export-2026-10-10.csv');
    expect(formatDay(AT)).toBe('10 Oct 2026');
    expect(formatDay(Date.UTC(2026, 9, 8), { year: false, utc: true })).toBe('8 Oct');
  });

  it('Markdown: a heading per fold with its date, a link per tab, a heading per window when there are several', () => {
    expect(exportMarkdown(graphs(), AT)).toBe(
      [
        '# Tabfold export',
        '',
        '2 folds · 4 tabs · exported 10 Oct 2026',
        '',
        '## Checkout app · 10 Oct 2026',
        '',
        '- [Fix \\[retries\\], again](https://github.com/acme/pull/1)',
        '- [a.com](https://a.com/x%20%281%29)',
        '',
        '## Reading · 3 Sep 2026',
        '',
        '### Research',
        '',
        '- [Foo](https://en.wikipedia.org/wiki/Foo)',
        '',
        '### Window 2',
        '',
        '- [B](https://b.com)',
        '',
      ].join('\n'),
    );
  });

  it('CSV: a header, one row per tab, RFC 4180 quoting, ISO times', () => {
    const tricky = graph('Mixed, "quoted"', [
      {
        name: 'Main',
        tabs: [
          tab('https://a.com/?q=1,2', 'Says "hi"', { keywords: ['work', 'later'] }),
          tab('https://b.com', 'Two\nlines'),
          tab('https://c.com', '=HYPERLINK("https://evil.example")'),
          tab('https://d.com', 'Plain'),
        ],
      },
    ]);
    const csv = exportCsv([tricky]);
    expect(csv.split('\r\n')).toEqual([
      'fold,window,title,url,saved_at,keywords,folder',
      '"Mixed, ""quoted""",Main,"Says ""hi""","https://a.com/?q=1,2",2026-10-10T12:00:05.000Z,work later,',
      '"Mixed, ""quoted""",Main,"Two\nlines",https://b.com,2026-10-10T12:00:05.000Z,,',
      `"Mixed, ""quoted""",Main,"'=HYPERLINK(""https://evil.example"")",https://c.com,2026-10-10T12:00:05.000Z,,`,
      '"Mixed, ""quoted""",Main,Plain,https://d.com,2026-10-10T12:00:05.000Z,,',
      '',
    ]);
    expect(exportCsv([])).toBe('fold,window,title,url,saved_at,keywords,folder\r\n');
  });

  it('JSON: Tabfold’s own format, version 1', () => {
    const data = JSON.parse(exportJson(graphs(), AT)) as TabfoldJsonExport;
    expect(data).toMatchObject({ format: 'tabfold', version: 1, exportedAt: new Date(AT).toISOString() });
    expect(data.folds).toHaveLength(2);
    expect(data.folds[0]).toEqual({
      name: 'Oct 10 · 14:32',
      smartName: 'Checkout app',
      createdAt: new Date(AT).toISOString(),
      windows: [
        {
          name: '',
          tabs: [
            { url: 'https://github.com/acme/pull/1', title: 'Fix [retries], again', savedAt: '2026-10-10T12:00:05.000Z', keywords: [] },
            { url: 'https://a.com/x (1)', title: '', savedAt: '2026-10-10T12:00:05.000Z', keywords: [] },
          ],
        },
      ],
    });
    expect(data.folds[1]!.windows.map((w) => w.name)).toEqual(['Research', '']);
    expect(data.folds[1]).not.toHaveProperty('smartName');
  });
});

// ---------------------------------------------------------------------------------------------

type Node = Browser.bookmarks.BookmarkTreeNode;

/** chrome.bookmarks with a Bookmarks bar and (optionally) Other bookmarks. Refuses javascript: addresses. */
function fakeBookmarks(options: { other?: boolean } = {}) {
  let id = 10;
  const bar: Node = { id: '1', parentId: '0', title: 'Bookmarks bar', children: [], syncing: false };
  const other: Node = { id: '2', parentId: '0', title: 'Other bookmarks', children: [], syncing: false };
  const root: Node = { id: '0', title: '', children: options.other === false ? [bar] : [bar, other], syncing: false };
  const byId = new Map<string, Node>([['0', root], ['1', bar], ['2', other]]);
  vi.spyOn(fakeBrowser.bookmarks, 'getTree').mockImplementation((async () => [root]) as never);
  vi.spyOn(fakeBrowser.bookmarks, 'create').mockImplementation((async (data: Browser.bookmarks.CreateDetails) => {
    if (data.url?.startsWith('javascript:')) throw new Error('Invalid URL.');
    const parent = byId.get(data.parentId ?? '2')!;
    const node: Node = { id: String(id++), parentId: parent.id, title: data.title ?? '', syncing: false, ...(data.url ? { url: data.url } : { children: [] }) };
    parent.children!.push(node);
    byId.set(node.id, node);
    return node;
  }) as never);
  return { bar, other };
}

describe('save the list to bookmarks', () => {
  async function seed() {
    await saveCapture(
      [capturedWindow(['https://github.com/acme', 'https://www.youtube.com/watch?v=1', 'javascript:void(0)'])],
      { source: 'save-all', deviceId: 'd', now: AT - 60_000 },
      { dedupe: false },
    );
    await saveCapture([capturedWindow(['https://stackoverflow.com/q/1', 'https://example.org/'])], { source: 'save-all', deviceId: 'd', now: AT }, { dedupe: false });
    await saveCapture(
      [{ ...capturedWindow(['https://secret.com']), incognito: true }],
      { source: 'save-all', deviceId: 'd', now: AT },
      { dedupe: false },
    );
  }

  it('makes "Tabfold · 10 Oct 2026" in Other bookmarks, a folder per kind of site, newest first', async () => {
    const { other, bar } = fakeBookmarks();
    await seed();
    const result = await saveListToBookmarks({ now: AT });
    expect(result).toEqual({ folderTitle: 'Tabfold · 10 Oct 2026', saved: 4, skippedIncognito: 1 });
    expect(bar.children).toEqual([]);
    const folder = other.children![0]!;
    expect(folder.title).toBe('Tabfold · 10 Oct 2026');
    const outline = folder.children!.map((sub) => [sub.title, sub.children!.map((n) => n.url)]);
    expect(outline).toEqual([
      ['Dev', ['https://stackoverflow.com/q/1', 'https://github.com/acme']],
      // The javascript: address was refused by Chrome; the rest still went in.
      ['Other', ['https://example.org/']],
      ['Video', ['https://www.youtube.com/watch?v=1']],
    ]);
    expect(JSON.stringify(folder)).not.toContain('secret.com');
  });

  it('uses the first folder when there is no "Other bookmarks"', async () => {
    const { bar } = fakeBookmarks({ other: false });
    await saveCapture([capturedWindow(['https://a.com'])], { source: 'save-all', deviceId: 'd', now: AT }, { dedupe: false });
    expect(await saveListToBookmarks({ now: AT })).toMatchObject({ saved: 1 });
    expect(bar.children![0]!.title).toBe('Tabfold · 10 Oct 2026');
  });

  it('without the bookmarks permission, says so', async () => {
    const api = fakeBrowser.bookmarks;
    (fakeBrowser as { bookmarks?: unknown }).bookmarks = undefined;
    try {
      await expect(saveListToBookmarks()).rejects.toBeInstanceOf(CommandError);
      await expect(saveListToBookmarks()).rejects.toMatchObject({ code: 'bookmarks-permission' });
    } finally {
      (fakeBrowser as { bookmarks?: unknown }).bookmarks = api;
    }
  });
});
