import { formatDateTime } from './format';
import type { SessionGraph } from './types';

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

/**
 * A standalone UTF-8 HTML page listing every session, window and tab. Opens in any browser and
 * can be imported back as a bookmarks file. Emoji, non-Latin and right-to-left titles survive.
 */
export function exportHtml(graphs: SessionGraph[], exportedAt = Date.now()): string {
  const sessions = graphs
    .map((graph) => {
      const windows = graph.windows
        .map((window, index) => {
          const items = window.tabs
            .map((tab) => {
              const href = safeHref(tab.url);
              const title = escapeHtml(tab.title || tab.url);
              const keywords = tab.keywords.length
                ? ` <span class="kw">${tab.keywords.map((k) => escapeHtml(k)).join(', ')}</span>`
                : '';
              const link = href
                ? `<a href="${escapeHtml(href)}" dir="auto">${title}</a>`
                : `<span dir="auto">${title}</span> <code>${escapeHtml(tab.url)}</code>`;
              return `        <DT>${link}${keywords}`;
            })
            .join('\n');
          const name = escapeHtml(window.name || `Window ${index + 1}`);
          return `      <DT><H3>${name}</H3>\n      <DL><p>\n${items}\n      </DL><p>`;
        })
        .join('\n');
      const tags = graph.session.tags.length ? ` · ${graph.session.tags.map(escapeHtml).join(', ')}` : '';
      return [
        `  <DT><H3>${escapeHtml(graph.session.name)}</H3>`,
        `  <p class="meta">${graph.session.tabCount} tabs · ${formatDateTime(graph.session.updatedAt)}${tags}</p>`,
        '  <DL><p>',
        windows,
        '  </DL><p>',
      ].join('\n');
    })
    .join('\n');

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

export function exportFileName(exportedAt = Date.now()): string {
  return `tabfold-export-${new Date(exportedAt).toISOString().slice(0, 10)}.html`;
}
