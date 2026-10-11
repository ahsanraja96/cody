import { formatDateTime } from './format';
import type { FolderRecord, SessionGraph } from './types';
import { displayHost } from './urls';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "10 Oct 2026" (or "10 Oct"), the same in every language setting. Local time unless `utc`. */
export function formatDay(timestamp: number, options: { year?: boolean; utc?: boolean } = {}): string {
  const d = new Date(timestamp);
  const day = options.utc ? d.getUTCDate() : d.getDate();
  const month = MONTHS[options.utc ? d.getUTCMonth() : d.getMonth()]!;
  const year = options.utc ? d.getUTCFullYear() : d.getFullYear();
  return options.year === false ? `${day} ${month}` : `${day} ${month} ${year}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only web and file links are clickable in the export; anything else is shown as text. */
function safeHref(url: string): string | null {
  return /^(https?|file|ftp):/i.test(url) ? url : null;
}

/** What an export can include besides the folds. */
export interface ExportOptions {
  /**
   * The folders (live ones, in the left column's order). Tabs in one are listed under it, first,
   * and not again under their fold; Markdown, CSV and JSON name each tab's folder.
   */
  folders?: FolderRecord[];
}

type ExportTab = SessionGraph['windows'][number]['tabs'][number];

interface FolderSection {
  folder: FolderRecord;
  tabs: ExportTab[];
}

/** Live folders that hold any of these tabs, in order, with their tabs (in the folds' order). */
function folderSections(graphs: SessionGraph[], folders: FolderRecord[] | undefined): { sections: FolderSection[]; inFolder: (tab: ExportTab) => boolean } {
  const live = new Map((folders ?? []).filter((f) => !f.deletedAt).map((f) => [f.id, f]));
  const byFolder = new Map<string, ExportTab[]>();
  for (const graph of graphs) {
    for (const window of graph.windows) {
      for (const tab of window.tabs) {
        if (!tab.folderId || !live.has(tab.folderId)) continue;
        const list = byFolder.get(tab.folderId);
        if (list) list.push(tab);
        else byFolder.set(tab.folderId, [tab]);
      }
    }
  }
  const sections = [...live.values()]
    .filter((f) => byFolder.has(f.id))
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    .map((folder) => ({ folder, tabs: byFolder.get(folder.id)! }));
  return { sections, inFolder: (tab) => !!tab.folderId && live.has(tab.folderId) };
}

/** The same folds without the tabs listed under a folder (windows and folds left empty go). */
function withoutFolderTabs(graphs: SessionGraph[], inFolder: (tab: ExportTab) => boolean): SessionGraph[] {
  return graphs
    .map((graph) => ({
      ...graph,
      windows: graph.windows.map((w) => ({ ...w, tabs: w.tabs.filter((t) => !inFolder(t)) })).filter((w) => w.tabs.length > 0),
    }))
    .filter((graph) => graph.windows.length > 0);
}

function folderNameOf(folders: FolderRecord[] | undefined): (tab: ExportTab) => string {
  const names = new Map((folders ?? []).filter((f) => !f.deletedAt).map((f) => [f.id, f.name]));
  return (tab) => (tab.folderId ? (names.get(tab.folderId) ?? '') : '');
}

function htmlTab(tab: ExportTab, indent: string): string {
  const href = safeHref(tab.url);
  const title = escapeHtml(tab.title || tab.url);
  const keywords = tab.keywords.length ? ` <span class="kw">${tab.keywords.map((k) => escapeHtml(k)).join(', ')}</span>` : '';
  const link = href
    ? `<a href="${escapeHtml(href)}" dir="auto">${title}</a>`
    : `<span dir="auto">${title}</span> <code>${escapeHtml(tab.url)}</code>`;
  return `${indent}<DT>${link}${keywords}`;
}

/**
 * A standalone UTF-8 HTML page listing every session, window and tab (folders first, when given).
 * Opens in any browser and can be imported back as a bookmarks file, a folder per Tabfold folder.
 * Emoji, non-Latin and right-to-left titles survive.
 */
export function exportHtml(graphs: SessionGraph[], exportedAt = Date.now(), options: ExportOptions = {}): string {
  const { sections, inFolder } = folderSections(graphs, options.folders);
  const folderHtml = sections.map(({ folder, tabs }) =>
    [
      `  <DT><H3>${escapeHtml(folder.name)}</H3>`,
      `  <p class="meta">Folder · ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}</p>`,
      '  <DL><p>',
      tabs.map((tab) => htmlTab(tab, '    ')).join('\n'),
      '  </DL><p>',
    ].join('\n'),
  );
  const sessionHtml = withoutFolderTabs(graphs, inFolder).map((graph) => {
    const windows = graph.windows
      .map((window, index) => {
        const items = window.tabs.map((tab) => htmlTab(tab, '        ')).join('\n');
        const name = escapeHtml(window.name || `Window ${index + 1}`);
        return `      <DT><H3>${name}</H3>\n      <DL><p>\n${items}\n      </DL><p>`;
      })
      .join('\n');
    const tags = graph.session.tags.length ? ` · ${graph.session.tags.map(escapeHtml).join(', ')}` : '';
    const shown = graph.windows.reduce((n, w) => n + w.tabs.length, 0);
    return [
      `  <DT><H3>${escapeHtml(graph.session.name)}</H3>`,
      `  <p class="meta">${shown} tabs · ${formatDateTime(graph.session.updatedAt)}${tags}</p>`,
      '  <DL><p>',
      windows,
      '  </DL><p>',
    ].join('\n');
  });
  const sessions = [...folderHtml, ...sessionHtml].join('\n');

  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tabfold export · ${escapeHtml(new Date(exportedAt).toISOString().slice(0, 10))}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#17171a}
h1{font-size:20px}h3{font-size:15px;margin:20px 0 4px}dl{margin:0 0 0 16px}dt{margin:2px 0}
.meta,.kw{color:#6b6b75;font-size:12px}code{font-size:12px;color:#6b6b75}
@media (prefers-color-scheme:dark){body{background:#111113;color:#ededf0}a{color:#a3aaf7}.meta,.kw,code{color:#8e8e98}}
</style>
</head>
<body>
<h1>Tabfold export</h1>
<p class="meta">${graphs.length} sessions · exported ${escapeHtml(formatDateTime(exportedAt))}</p>
<DL><p>
${sessions}
</DL><p>
</body>
</html>
`;
}

/** `tabfold-export-2026-10-10.html` (or `.md`, `.csv`, `.json` with `ext`). */
export function exportFileName(exportedAt = Date.now(), ext = 'html'): string {
  return `tabfold-export-${new Date(exportedAt).toISOString().slice(0, 10)}.${ext.replace(/^\./, '')}`;
}

// ---- Pro export formats (Pro-Plans: "Export to Markdown, CSV and JSON") ----

/** A fold's name as the list shows it: the AI's name when it has one. */
function foldName(graph: SessionGraph): string {
  return (graph.session.smartName || graph.session.name).replace(/\s+/g, ' ').trim() || 'Fold';
}

function windowName(window: SessionGraph['windows'][number], index: number): string {
  return window.name.replace(/\s+/g, ' ').trim() || `Window ${index + 1}`;
}

/** Text inside a Markdown heading or link: brackets and backslashes escaped, on one line. */
function markdownText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Spaces and parentheses would end a Markdown link early. */
function markdownUrl(url: string): string {
  return url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** `- [Title](url)`, the title falling back to the site. */
export function markdownLink(tab: { title: string; url: string }): string {
  const title = markdownText(tab.title) || displayHost(tab.url) || tab.url;
  return `- [${title}](${markdownUrl(tab.url)})`;
}

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Every fold as Markdown: a heading per fold with its date, a link per tab (`- [title](url)`). A
 * fold of several windows has a smaller heading per window. Folders come first, a heading each
 * ("Folder · 12 tabs" under it); their tabs aren't repeated under their folds.
 */
export function exportMarkdown(graphs: SessionGraph[], exportedAt = Date.now(), options: ExportOptions = {}): string {
  const tabs = graphs.reduce((n, g) => n + g.windows.reduce((m, w) => m + w.tabs.length, 0), 0);
  const { sections, inFolder } = folderSections(graphs, options.folders);
  const folders = sections.length ? ` · ${count(sections.length, 'folder')}` : '';
  const lines = ['# Tabfold export', '', `${count(graphs.length, 'fold')} · ${count(tabs, 'tab')}${folders} · exported ${formatDay(exportedAt)}`];
  for (const section of sections) {
    lines.push('', `## ${markdownText(section.folder.name)}`, '', `Folder · ${count(section.tabs.length, 'tab')}`, '');
    for (const tab of section.tabs) lines.push(markdownLink(tab));
  }
  for (const graph of withoutFolderTabs(graphs, inFolder)) {
    lines.push('', `## ${markdownText(foldName(graph))} · ${formatDay(graph.session.createdAt)}`);
    const several = graph.windows.length > 1;
    graph.windows.forEach((window, index) => {
      if (several) lines.push('', `### ${markdownText(windowName(window, index))}`);
      lines.push('');
      for (const tab of window.tabs) lines.push(markdownLink(tab));
    });
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A CSV field (RFC 4180): quoted when it holds a comma, a quote or a line break, with quotes
 * doubled. A field a spreadsheet would run as a formula (starting =, +, -, @) gets an apostrophe.
 */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * One row per tab: fold, window, title, address, saved at (ISO 8601), keywords (space separated),
 * folder (its name; empty when it's by site). CRLF lines.
 */
export function exportCsv(graphs: SessionGraph[], options: ExportOptions = {}): string {
  const folderOf = folderNameOf(options.folders);
  const rows: string[][] = [['fold', 'window', 'title', 'url', 'saved_at', 'keywords', 'folder']];
  for (const graph of graphs) {
    graph.windows.forEach((window, index) => {
      for (const tab of window.tabs) {
        rows.push([
          foldName(graph),
          windowName(window, index),
          tab.title,
          tab.url,
          new Date(tab.savedAt).toISOString(),
          tab.keywords.join(' '),
          folderOf(tab),
        ]);
      }
    });
  }
  return `${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/** Tabfold's own JSON format, version 1 (0.6 added `folders` and each tab's `folder`). */
export interface TabfoldJsonExport {
  format: 'tabfold';
  version: 1;
  exportedAt: string;
  /** The folders that hold any of the tabs, in order. */
  folders?: Array<{ name: string; color: string }>;
  folds: Array<{
    name: string;
    /** The AI's name for the fold, when it has one. */
    smartName?: string;
    createdAt: string;
    windows: Array<{
      name: string;
      tabs: Array<{ url: string; title: string; savedAt: string; keywords: string[]; folder?: string }>;
    }>;
  }>;
}

/** Folds, windows and tabs as JSON (Tabfold's own format, importable later). Times are ISO 8601. */
export function exportJson(graphs: SessionGraph[], exportedAt = Date.now(), options: ExportOptions = {}): string {
  const { sections } = folderSections(graphs, options.folders);
  const folderOf = folderNameOf(options.folders);
  const data: TabfoldJsonExport = {
    format: 'tabfold',
    version: 1,
    exportedAt: new Date(exportedAt).toISOString(),
    ...(sections.length ? { folders: sections.map(({ folder }) => ({ name: folder.name, color: folder.color })) } : {}),
    folds: graphs.map((graph) => ({
      name: graph.session.name,
      ...(graph.session.smartName ? { smartName: graph.session.smartName } : {}),
      createdAt: new Date(graph.session.createdAt).toISOString(),
      windows: graph.windows.map((window) => ({
        name: window.name,
        tabs: window.tabs.map((tab) => {
          const folder = folderOf(tab);
          return {
            url: tab.url,
            title: tab.title,
            savedAt: new Date(tab.savedAt).toISOString(),
            keywords: [...tab.keywords],
            ...(folder ? { folder } : {}),
          };
        }),
      })),
    })),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}
