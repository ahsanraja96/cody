import linksMd from './fixtures/imports/links.md?raw';
import tobySpaces from './fixtures/imports/toby-spaces.json?raw';
import tobyV3 from './fixtures/imports/toby-v3.json?raw';
import workonaHtml from './fixtures/imports/workona.html?raw';
import workonaJson from './fixtures/imports/workona.json?raw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { listBookmarkFolders, readBookmarkFolder } from '@/lib/bookmarks';
import { db } from '@/lib/db';
import { exportJson, exportMarkdown } from '@/lib/exporters';
import {
  detectImportSource,
  parseImport,
  parseJsonLinks,
  parseLinks,
  parseToby,
  parseWorkona,
  type ImportResult,
} from '@/lib/importers';
import { CommandError } from '@/lib/messages';
import { exportGraphs, importSessions, saveCapture } from '@/lib/repo';
import { capturedWindow } from './fixtures';

/** Small exports written like the real ones (tests/fixtures/imports). */
const FIXTURES: Record<string, string> = {
  'toby-v3.json': tobyV3,
  'toby-spaces.json': tobySpaces,
  'workona.json': workonaJson,
  'workona.html': workonaHtml,
  'links.md': linksMd,
};
const fixture = (name: string) => FIXTURES[name]!;

/** Each collection's name and its tabs' titles. */
function outline(result: ImportResult): Array<[string, string[]]> {
  return result.sessions.map((s) => [s.name, s.windows.flatMap((w) => w.tabs.map((t) => t.title))]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Toby', () => {
  it('reads the lists-and-cards export: each list a collection, custom titles first, scripts skipped', () => {
    const text = fixture('toby-v3.json');
    expect(detectImportSource(text)).toBe('toby');
    const result = parseToby(text);
    expect(outline(result)).toEqual([
      ['Getting Started', ['Toby Guide', 'Shortcuts I keep forgetting']],
      ['Checkout app', ['Stripe Webhooks | Stripe Documentation', 'acme/checkout: Pull request #12']],
    ]);
    expect(result.tabCount).toBe(4);
    expect(result.skipped).toBe(1);
  });

  it('reads newer exports with spaces and collections of cards or tabs', () => {
    const result = parseImport('toby', fixture('toby-spaces.json'));
    expect(outline(result)).toEqual([
      ['Holiday in Lisbon', ['Time Out Lisbon', 'Flights']],
      ['Reading', ['The Verge']],
    ]);
    expect(result.sessions[0]!.createdAt).toBe(Date.parse('2025-03-02T10:00:00.000Z'));
    expect(parseToby('{oops')).toEqual({ sessions: [], tabCount: 0, skipped: 1 });
  });
});

describe('Workona', () => {
  it('reads its JSON: every link in a workspace (its sections too) goes into that workspace', () => {
    const text = fixture('workona.json');
    expect(detectImportSource(text)).toBe('workona');
    const result = parseWorkona(text);
    expect(outline(result)).toEqual([
      ['Marketing', ['Campaign brief - Google Docs', 'Figma - Landing page', 'Brand guidelines', 'Analytics']],
      ['Hiring', ['Greenhouse']],
    ]);
  });

  it('reads its bookmarks HTML export: a workspace per folder', () => {
    const text = fixture('workona.html');
    expect(detectImportSource(text)).toBe('workona');
    expect(outline(parseImport('workona', text))).toEqual([
      ['Marketing', ['Campaign brief - Google Docs', 'Figma – Landing page']],
      ['Hiring', ['Greenhouse']],
    ]);
  });
});

describe('any JSON', () => {
  it('takes objects with a web address and a title, grouped under the nearest named parent', () => {
    const text = JSON.stringify({
      data: {
        groups: [
          { name: 'Design', items: [{ title: 'Figma', url: 'https://figma.com' }, { label: 'x', href: 'https://dribbble.com' }] },
          { name: '', items: [{ name: 'Loose', link: 'https://loose.example' }] },
        ],
        bookmark: { title: 'At the top', url: 'https://top.example', meta: { tags: ['a'] } },
        broken: { title: 'Script', url: 'javascript:alert(1)' },
      },
    });
    expect(detectImportSource(text)).toBe('json');
    const result = parseJsonLinks(text);
    expect(outline(result)).toEqual([
      ['Design', ['Figma', 'x']],
      ['Imported links', ['Loose', 'At the top']],
    ]);
    expect(result.skipped).toBe(1);
  });

  it('reads Tabfold’s own JSON export back: as folds with windows, or as plain links', async () => {
    await saveCapture([capturedWindow(['https://a.com', 'https://b.com'], { name: 'Research' })], { name: 'Fold one', source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: false });
    const text = exportJson(await exportGraphs());
    // Folds with windows read like a Session Buddy backup.
    expect(detectImportSource(text)).toBe('session-buddy');
    expect(outline(parseImport('session-buddy', text))).toEqual([['Fold one', ['Title of https://a.com', 'Title of https://b.com']]]);
    expect(outline(parseImport('json', text))).toEqual([['Research', ['Title of https://a.com', 'Title of https://b.com']]]);
  });
});

describe('a list of links', () => {
  it('reads an address per line with an optional title, Markdown links, and headings as groups', () => {
    const text = fixture('links.md');
    expect(detectImportSource(text)).toBe('links');
    const result = parseLinks(text);
    expect(result.sessions.map((s) => [s.name, s.windows[0]!.tabs.map((t) => [t.url, t.title])])).toEqual([
      [
        'Imported links',
        [
          ['https://example.com', 'https://example.com'],
          ['https://news.ycombinator.com/item?id=1', 'Show HN: Tabfold'],
          ['https://www.wikipedia.org/', 'Wikipedia'],
          ['https://bsky.app/profile/ada', 'Ada on Bluesky'],
        ],
      ],
      [
        'Work',
        [
          ['https://github.com/acme/checkout/pull/12', 'Fix [webhooks] retries'],
          ['https://en.wikipedia.org/wiki/Foo_(bar)', 'Foo (bar)'],
          ['https://stripe.com/pricing', 'Pricing page'],
        ],
      ],
    ]);
    // "Some links I collected", "not a link at all", "ftp-ish: …"
    expect(result.skipped).toBe(3);
  });

  it('reads Tabfold’s own Markdown export back, a group per fold', async () => {
    await saveCapture([capturedWindow(['https://a.com/x (1)'])], { name: 'Fold', source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: false });
    const text = exportMarkdown(await exportGraphs());
    const result = parseImport(detectImportSource(text), text);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.windows[0]!.tabs[0]!.url).toBe('https://a.com/x%20%281%29');
  });

  it('tells OneTab’s export from a plain list', () => {
    expect(detectImportSource('https://a.com | A\nhttps://b.com | B')).toBe('onetab');
    expect(detectImportSource('https://a.com\nhttps://b.com')).toBe('links');
    expect(detectImportSource('[A](https://a.com)')).toBe('links');
    expect(detectImportSource('nothing to see')).toBe('onetab');
    expect(detectImportSource('{"collections":[]}')).toBe('session-buddy');
  });
});

describe('importing collections as folders', () => {
  it('a Toby export becomes folders', async () => {
    const result = await importSessions(parseToby(fixture('toby-v3.json')).sessions, { deviceId: 'd', asFolders: true });
    expect(result).toMatchObject({ tabs: 4, folders: 2, withoutFolder: 0 });
    expect((await db.folders.toArray()).map((f) => f.name).sort()).toEqual(['Checkout app', 'Getting Started']);
  });
});

// ---------------------------------------------------------------------------------------------

type Node = Browser.bookmarks.BookmarkTreeNode;

function bookmarksTree(): Node {
  const link = (id: string, title: string, url: string): Node => ({ id, title, url, syncing: false });
  const folder = (id: string, title: string, children: Node[]): Node => ({ id, title, children, syncing: false });
  return folder('0', '', [
    folder('1', 'Bookmarks bar', [
      folder('10', 'Work', [
        link('11', 'Linear', 'https://linear.app'),
        folder('12', 'Clients', [link('13', 'Acme', 'https://acme.example'), folder('14', '2026', [link('15', 'Brief', 'https://brief.example')])]),
        link('16', 'Bookmarklet', 'javascript:void(0)'),
      ]),
      folder('20', 'Empty', []),
      link('21', 'Loose', 'https://loose.example'),
    ]),
    folder('2', 'Other bookmarks', []),
  ]);
}

describe('a Chrome bookmarks folder', () => {
  it('lists folders with links, with their path and how many links are inside', async () => {
    const tree = bookmarksTree();
    vi.spyOn(fakeBrowser.bookmarks, 'getTree').mockImplementation((async () => [tree]) as never);
    expect(await listBookmarkFolders()).toEqual([
      { id: '1', path: 'Bookmarks bar', count: 4 },
      { id: '10', path: 'Bookmarks bar / Work', count: 3 },
      { id: '12', path: 'Bookmarks bar / Work / Clients', count: 2 },
      { id: '14', path: 'Bookmarks bar / Work / Clients / 2026', count: 1 },
    ]);
  });

  it('reads a folder as collections: its own links, then each subfolder by its path', async () => {
    const tree = bookmarksTree();
    const find = (node: Node, id: string): Node | undefined => (node.id === id ? node : node.children?.map((c) => find(c, id)).find(Boolean));
    vi.spyOn(fakeBrowser.bookmarks, 'getSubTree').mockImplementation((async (id: string) => [find(tree, id)!]) as never);
    const sessions = await readBookmarkFolder('10');
    expect(sessions.map((s) => [s.name, s.windows[0]!.tabs.map((t) => t.url)])).toEqual([
      ['Work', ['https://linear.app']],
      ['Clients', ['https://acme.example']],
      ['Clients / 2026', ['https://brief.example']],
    ]);
  });

  it('without the bookmarks permission, says so', async () => {
    const api = fakeBrowser.bookmarks;
    (fakeBrowser as { bookmarks?: unknown }).bookmarks = undefined;
    try {
      await expect(listBookmarkFolders()).rejects.toBeInstanceOf(CommandError);
      await expect(readBookmarkFolder('1')).rejects.toMatchObject({ code: 'bookmarks-permission' });
    } finally {
      (fakeBrowser as { bookmarks?: unknown }).bookmarks = api;
    }
  });
});
