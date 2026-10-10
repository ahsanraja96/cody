import { describe, expect, it } from 'vitest';
import { exportHtml } from '@/lib/exporters';
import { detectImportSource, parseBookmarksHtml, parseOneTab, parseSessionBuddy } from '@/lib/importers';
import type { SessionGraph } from '@/lib/types';

describe('OneTab', () => {
  it('turns each blank-line-separated group into a session and skips bad lines', () => {
    const text = [
      'https://a.com | A title',
      'https://b.com | B | with pipe',
      'not a url at all',
      '',
      '',
      'https://c.com',
      'chrome://newtab/ | New Tab',
    ].join('\r\n');
    const result = parseOneTab(text);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]!.windows[0]!.tabs.map((t) => [t.url, t.title])).toEqual([
      ['https://a.com', 'A title'],
      ['https://b.com', 'B | with pipe'],
    ]);
    expect(result.sessions[1]!.windows[0]!.tabs[0]!.title).toBe('https://c.com');
    expect(result.tabCount).toBe(3);
    expect(result.skipped).toBe(2);
  });
});

describe('Session Buddy', () => {
  it('reads the collections format', () => {
    const json = JSON.stringify({
      collections: [
        {
          title: 'Research',
          created: 1700000000000,
          windows: [{ tabs: [{ url: 'https://a.com', title: 'A', pinned: true }, { title: 'missing url' }] }, { tabs: [{ url: 'https://b.com', title: 'B' }] }],
        },
      ],
    });
    const result = parseSessionBuddy(json);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ name: 'Research', createdAt: 1700000000000 });
    expect(result.sessions[0]!.windows).toHaveLength(2);
    expect(result.sessions[0]!.windows[0]!.tabs[0]!.pinned).toBe(true);
    expect(result.skipped).toBe(1);
  });

  it('reads an older sessions format and survives broken JSON', () => {
    const json = JSON.stringify({ sessions: [{ name: 'Old', windows: [{ tabs: [{ url: 'https://x.com', title: 'X' }] }] }] });
    expect(parseSessionBuddy(json).sessions[0]!.name).toBe('Old');
    expect(parseSessionBuddy('{not json')).toEqual({ sessions: [], tabCount: 0, skipped: 1 });
  });
});

describe('bookmarks HTML', () => {
  it('turns folders into sessions named by their path', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Work</H3>
  <DL><p>
    <DT><A HREF="https://a.com" ADD_DATE="1">A &amp; B</A>
    <DT><H3>Docs</H3>
    <DL><p>
      <DT><A HREF="https://docs.com">Docs</A>
    </DL><p>
  </DL><p>
  <DT><A HREF="javascript:void(0)">Bookmarklet</A>
</DL><p>`;
    const result = parseBookmarksHtml(html);
    expect(result.sessions.map((s) => [s.name, s.windows[0]!.tabs.map((t) => t.title)])).toEqual([
      ['Work', ['A & B']],
      ['Work / Docs', ['Docs']],
      ['Bookmarks', ['Bookmarklet']],
    ]);
  });

  it('detects formats from contents', () => {
    expect(detectImportSource('{"collections":[]}')).toBe('session-buddy');
    expect(detectImportSource('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe('bookmarks');
    expect(detectImportSource('https://a.com | A')).toBe('onetab');
  });
});

describe('HTML export', () => {
  const graph: SessionGraph = {
    session: {
      id: 's',
      name: 'Café <script>',
      tags: ['travel'],
      pinned: 0,
      color: null,
      kind: 'session',
      source: 'save-all',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: 0,
      deviceId: 'd',
      version: 1,
      tabCount: 3,
      windowCount: 1,
      preview: [],
    },
    windows: [
      {
        id: 'w',
        sessionId: 's',
        name: '',
        order: 0,
        wasFocused: true,
        bounds: null,
        state: null,
        tabs: [
          { id: 't1', sessionId: 's', windowId: 'w', url: 'https://a.com/?q="x"', title: 'שלום 🎉', favIconUrl: '', pinned: false, groupName: null, groupColor: null, groupCollapsed: false, order: 0, savedAt: 1, keywords: ['hebrew'], urlTruncated: false },
          { id: 't2', sessionId: 's', windowId: 'w', url: 'javascript:alert(1)', title: 'bad', favIconUrl: '', pinned: false, groupName: null, groupColor: null, groupCollapsed: false, order: 1, savedAt: 1, keywords: [], urlTruncated: false },
          { id: 't3', sessionId: 's', windowId: 'w', url: 'chrome://settings', title: 'Settings', favIconUrl: '', pinned: false, groupName: null, groupColor: null, groupCollapsed: false, order: 2, savedAt: 1, keywords: [], urlTruncated: false },
        ],
      },
    ],
  };

  it('escapes HTML, keeps UTF-8 and never makes script links clickable', () => {
    const html = exportHtml([graph], 0);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('Café &lt;script&gt;');
    expect(html).toContain('שלום 🎉');
    expect(html).toContain('href="https://a.com/?q=&quot;x&quot;"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('<code>chrome://settings</code>');
  });

  it('round-trips through the bookmarks importer', () => {
    const result = parseBookmarksHtml(exportHtml([graph], 0));
    const urls = result.sessions.flatMap((s) => s.windows.flatMap((w) => w.tabs.map((t) => t.url)));
    expect(urls).toContain('https://a.com/?q="x"');
  });
});
