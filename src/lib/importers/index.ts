import { capUrl, classifyUrl } from '../urls';
import type { CapturedTab, CapturedWindow } from '../types';

/**
 * Importers turn other tools' exports into sessions. They never throw on bad input: malformed
 * lines or entries are skipped and counted, so a huge or partly broken file still imports.
 */

export interface ImportedSession {
  name: string;
  createdAt: number | null;
  windows: CapturedWindow[];
}

export interface ImportResult {
  sessions: ImportedSession[];
  tabCount: number;
  skipped: number;
}

/**
 * Where an import comes from: OneTab's text, Session Buddy, a bookmarks HTML file, Toby's JSON,
 * Workona's export (JSON or bookmarks HTML), any JSON with links in it, or a plain list of links.
 */
export type ImportSource = 'onetab' | 'session-buddy' | 'bookmarks' | 'toby' | 'workona' | 'json' | 'links';

/** A tab from an import, or null when the address can't be one (blank, not an address, a bookmarklet). */
export function importedTab(url: string, title: string): CapturedTab | null {
  if (/^\s*javascript:/i.test(url)) return null;
  return makeTab(url, title);
}

function makeTab(url: string, title: string, extra: Partial<CapturedTab> = {}): CapturedTab | null {
  const trimmed = url.trim();
  if (!trimmed || classifyUrl(trimmed) === 'blank') return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const { url: capped, truncated } = capUrl(trimmed);
  return {
    url: capped,
    title: title.trim() || capped,
    favIconUrl: '',
    pinned: false,
    groupName: null,
    groupColor: null,
    groupCollapsed: false,
    keywords: [],
    urlTruncated: truncated,
    ...extra,
  };
}

function makeWindow(tabs: CapturedTab[], name = ''): CapturedWindow {
  return { name, focused: false, bounds: null, state: null, tabs };
}

function finish(sessions: ImportedSession[], skipped: number): ImportResult {
  const kept = sessions.filter((s) => s.windows.some((w) => w.tabs.length > 0));
  return {
    sessions: kept.map((s) => ({ ...s, windows: s.windows.filter((w) => w.tabs.length > 0) })),
    tabCount: kept.reduce((n, s) => n + s.windows.reduce((m, w) => m + w.tabs.length, 0), 0),
    skipped,
  };
}

/**
 * OneTab "Export URLs" text: one "url | title" per line, groups separated by blank lines.
 * Each OneTab group becomes one session.
 */
export function parseOneTab(text: string): ImportResult {
  const sessions: ImportedSession[] = [];
  let current: CapturedTab[] = [];
  let skipped = 0;
  const flush = () => {
    if (current.length) {
      sessions.push({ name: `OneTab group ${sessions.length + 1}`, createdAt: null, windows: [makeWindow(current)] });
    }
    current = [];
  };
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const separator = line.indexOf(' | ');
    const url = separator === -1 ? line : line.slice(0, separator);
    const title = separator === -1 ? '' : line.slice(separator + 3);
    const tab = makeTab(url, title);
    if (tab) current.push(tab);
    else skipped += 1;
  }
  flush();
  return finish(sessions, skipped);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function asObject(value: Json | undefined): Record<string, Json> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value: Json | undefined): string {
  return typeof value === 'string' ? value : '';
}

function asTime(value: Json | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Session Buddy JSON backups. The format has changed across versions, so this walks the JSON and
 * treats any object holding a `windows` array of objects with `tabs` arrays as a session.
 */
export function parseSessionBuddy(text: string): ImportResult {
  let data: Json;
  try {
    data = JSON.parse(text.replace(/^﻿/, '')) as Json;
  } catch {
    return { sessions: [], tabCount: 0, skipped: 1 };
  }
  const sessions: ImportedSession[] = [];
  let skipped = 0;

  const readTabs = (list: Json | undefined): CapturedTab[] => {
    if (!Array.isArray(list)) return [];
    const tabs: CapturedTab[] = [];
    for (const item of list) {
      const obj = asObject(item);
      const tab = obj
        ? makeTab(asString(obj.url) || asString(obj.href), asString(obj.title) || asString(obj.name), {
            pinned: obj.pinned === true,
          })
        : null;
      if (tab) tabs.push(tab);
      else skipped += 1;
    }
    return tabs;
  };

  const visit = (node: Json, depth: number) => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (Array.isArray(node.windows)) {
      const windows: CapturedWindow[] = [];
      for (const win of node.windows) {
        const obj = asObject(win);
        if (!obj) {
          skipped += 1;
          continue;
        }
        windows.push(makeWindow(readTabs(obj.tabs), asString(obj.title) || asString(obj.name)));
      }
      const name = asString(node.title) || asString(node.name) || `Session Buddy ${sessions.length + 1}`;
      const createdAt = asTime(node.created) ?? asTime(node.createdAt) ?? asTime(node.generated) ?? asTime(node.modified);
      sessions.push({ name, createdAt, windows });
      return;
    }
    if (Array.isArray(node.tabs) && !Array.isArray(node.windows)) {
      // A loose window at the top level.
      sessions.push({
        name: asString(node.title) || `Session Buddy ${sessions.length + 1}`,
        createdAt: null,
        windows: [makeWindow(readTabs(node.tabs))],
      });
      return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };

  visit(data, 0);
  return finish(sessions, skipped);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&[lr]squo;/g, (m) => (m[1] === 'l' ? '‘' : '’'))
    .replace(/&[lr]dquo;/g, (m) => (m[1] === 'l' ? '“' : '”'))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * A browser's exported bookmarks file (Netscape HTML). Each folder that directly contains links
 * becomes a session named after the folder path. No bookmarks permission is needed.
 */
export function parseBookmarksHtml(html: string): ImportResult {
  const folderStack: string[] = [];
  let pendingFolder: string | null = null;
  const byFolder = new Map<string, CapturedTab[]>();
  let skipped = 0;
  const token = /<h3[^>]*>([\s\S]*?)<\/h3>|<dl[^>]*>|<\/dl>|<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(token)) {
    const [whole, folderTitle, attrs, linkText] = match;
    const lower = whole.slice(0, 4).toLowerCase();
    if (folderTitle !== undefined) {
      pendingFolder = decodeEntities(folderTitle.replace(/<[^>]+>/g, '')).trim();
    } else if (lower.startsWith('<dl')) {
      folderStack.push(pendingFolder ?? '');
      pendingFolder = null;
    } else if (lower.startsWith('</dl')) {
      folderStack.pop();
    } else if (attrs !== undefined) {
      const href = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /href\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ?? '';
      const tab = makeTab(decodeEntities(href), decodeEntities((linkText ?? '').replace(/<[^>]+>/g, '')));
      if (!tab) {
        skipped += 1;
        continue;
      }
      const path = folderStack.filter(Boolean).join(' / ') || 'Bookmarks';
      const list = byFolder.get(path) ?? [];
      list.push(tab);
      byFolder.set(path, list);
    }
  }
  const sessions: ImportedSession[] = [...byFolder.entries()].map(([name, tabs]) => ({
    name,
    createdAt: null,
    windows: [makeWindow(tabs)],
  }));
  return finish(sessions, skipped);
}

// ---------------------------------------------------------------------------------------------
// JSON exports (Toby, Workona, anything with links in it)

const WEB = /^https?:\/\//i;
const MAX_DEPTH = 24;

function parseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as Json;
  } catch {
    return undefined;
  }
}

/** A link object: an http(s) `url` (or `href`, `link`). */
function linkUrl(obj: Record<string, Json>): string {
  for (const key of ['url', 'href', 'link', 'uri']) {
    const value = asString(obj[key]).trim();
    if (WEB.test(value)) return value;
  }
  return '';
}

function nameOf(obj: Record<string, Json>): string {
  return (asString(obj.title) || asString(obj.name) || asString(obj.label)).replace(/\s+/g, ' ').trim();
}

function createdOf(obj: Record<string, Json>): number | null {
  return asTime(obj.created) ?? asTime(obj.createdAt) ?? asTime(obj.created_at) ?? asTime(obj.dateCreated) ?? null;
}

/** Collections in the order they were first seen, merged by name. */
class Collections {
  private byName = new Map<string, ImportedSession>();
  private order: ImportedSession[] = [];
  add(name: string, createdAt: number | null, tab: CapturedTab): void {
    let session = this.byName.get(name);
    if (!session) {
      session = { name, createdAt, windows: [makeWindow([])] };
      this.byName.set(name, session);
      this.order.push(session);
    }
    session.windows[0]!.tabs.push(tab);
  }
  get sessions(): ImportedSession[] {
    return this.order;
  }
}

/**
 * Any JSON: every object with an http(s) `url` and a `title` or `name` is a tab, grouped under the
 * nearest named object around it (a list, a collection, a folder). Links with no named parent go
 * into `fallbackName`. `titleOf` picks a link's title (Toby's custom titles, for example).
 */
function walkLinks(
  data: Json,
  fallbackName: string,
  titleOf: (obj: Record<string, Json>) => string = nameOf,
): { collections: Collections; skipped: number } {
  const collections = new Collections();
  let skipped = 0;
  const visit = (node: Json, group: { name: string; createdAt: number | null } | null, depth: number) => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, group, depth + 1);
      return;
    }
    // A link is a leaf: an object holding lists of objects is a collection, even with an address of its own.
    const holdsItems = Object.values(node).some((value) => Array.isArray(value) && value.some((v) => v !== null && typeof v === 'object'));
    const url = holdsItems ? '' : linkUrl(node);
    if (url) {
      const tab = makeTab(url, titleOf(node));
      if (tab) collections.add(group?.name || fallbackName, group?.createdAt ?? null, tab);
      else skipped += 1;
      return;
    }
    const hasChildren = Object.values(node).some((value) => value !== null && typeof value === 'object');
    if (!hasChildren) {
      // An entry that looks like a link but has no web address (a note, a bookmarklet).
      if ('url' in node || 'href' in node) skipped += 1;
      return;
    }
    const name = nameOf(node);
    const next = name ? { name, createdAt: createdOf(node) } : group;
    for (const value of Object.values(node)) visit(value, next, depth + 1);
  };
  visit(data, null, 0);
  return { collections, skipped };
}

/** Any JSON with links in it (Mx-Ask "A list of links" covers text; this covers other tools' JSON). */
export function parseJsonLinks(text: string, fallbackName = 'Imported links'): ImportResult {
  const data = parseJson(text);
  if (data === undefined) return { sessions: [], tabCount: 0, skipped: 1 };
  const { collections, skipped } = walkLinks(data, fallbackName);
  return finish(collections.sessions, skipped);
}

/**
 * Toby's JSON export. Older versions: `{ version: 3, lists: [{ title, cards: [{ title, url,
 * customTitle }] }] }`; newer ones nest collections in spaces or groups, with `cards` or `tabs`.
 * Each list or collection becomes a session; a card's custom title wins.
 */
export function parseToby(text: string): ImportResult {
  const data = parseJson(text);
  if (data === undefined) return { sessions: [], tabCount: 0, skipped: 1 };
  const title = (obj: Record<string, Json>) =>
    (asString(obj.customTitle) || asString(obj.title) || asString(obj.name)).replace(/\s+/g, ' ').trim();
  const { collections, skipped } = walkLinks(data, 'Imported from Toby', title);
  return finish(collections.sessions, skipped);
}

/**
 * Workona's export. A bookmarks HTML file (a folder per workspace) reads like any bookmarks file;
 * its JSON lists `workspaces`, each with tabs and resources (in sections): every link in a
 * workspace goes into that workspace's session.
 */
export function parseWorkona(text: string): ImportResult {
  if (text.trimStart().startsWith('<')) return parseBookmarksHtml(text);
  const data = parseJson(text);
  if (data === undefined) return { sessions: [], tabCount: 0, skipped: 1 };
  const workspaces: Array<Record<string, Json>> = [];
  const find = (node: Json, depth: number) => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) find(child, depth + 1);
      return;
    }
    if (Array.isArray(node.workspaces)) {
      for (const workspace of node.workspaces) {
        const obj = asObject(workspace);
        if (obj) workspaces.push(obj);
      }
      return;
    }
    for (const value of Object.values(node)) find(value, depth + 1);
  };
  find(data, 0);
  if (workspaces.length === 0) {
    const { collections, skipped } = walkLinks(data, 'Imported from Workona');
    return finish(collections.sessions, skipped);
  }
  const collections = new Collections();
  let skipped = 0;
  workspaces.forEach((workspace, index) => {
    const name = nameOf(workspace) || `Workona workspace ${index + 1}`;
    // Every link in the workspace, whatever section it's in.
    const inner = walkLinks(workspace, name);
    skipped += inner.skipped;
    for (const session of inner.collections.sessions) {
      for (const tab of session.windows.flatMap((w) => w.tabs)) collections.add(name, createdOf(workspace), tab);
    }
  });
  return finish(collections.sessions, skipped);
}

// ---------------------------------------------------------------------------------------------
// A list of links

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\[\]()])/g, '$1');
}

const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
const MARKDOWN_LINK = /\[((?:\\.|[^\]\\])*)\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/gi;
const BARE_URL = /<?(https?:\/\/[^\s<>"]+)>?/i;

/**
 * Plain text, one link per line: an address, optionally followed by a title (after a space or a
 * tab), or Markdown `[title](address)`. A Markdown heading (`## Work`) starts a new group; links
 * before any heading are "Imported links". Lines without an address are skipped and counted.
 */
export function parseLinks(text: string, fallbackName = 'Imported links'): ImportResult {
  const collections = new Collections();
  let group = fallbackName;
  let skipped = 0;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const name = heading[1]!.replace(/\s+#+\s*$/, '').trim();
      if (name) group = name;
      continue;
    }
    const markdown = [...line.matchAll(MARKDOWN_LINK)];
    if (markdown.length) {
      for (const match of markdown) {
        const tab = makeTab(match[2]!, unescapeMarkdown(match[1]!).trim());
        if (tab) collections.add(group, null, tab);
        else skipped += 1;
      }
      continue;
    }
    const body = line.replace(LIST_MARKER, '');
    const found = BARE_URL.exec(body);
    if (!found) {
      skipped += 1;
      continue;
    }
    // The title is the rest of the line, before or after the address, without separators.
    const rest = (body.slice(0, found.index) + ' ' + body.slice(found.index + found[0].length))
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[|:–—-]\s*/, '')
      .replace(/\s*[|:–—-]$/, '')
      .trim();
    const tab = makeTab(found[1]!.replace(/[.,;]+$/, ''), rest);
    if (tab) collections.add(group, null, tab);
    else skipped += 1;
  }
  return finish(collections.sessions, skipped);
}

// ---------------------------------------------------------------------------------------------

export function parseImport(source: ImportSource, text: string): ImportResult {
  switch (source) {
    case 'onetab':
      return parseOneTab(text);
    case 'session-buddy':
      return parseSessionBuddy(text);
    case 'bookmarks':
      return parseBookmarksHtml(text);
    case 'toby':
      return parseToby(text);
    case 'workona':
      return parseWorkona(text);
    case 'json':
      return parseJsonLinks(text);
    case 'links':
      return parseLinks(text);
  }
}

/** Guess the format from file contents, for drag-and-drop and pasting. */
export function detectImportSource(text: string): ImportSource {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  const head = trimmed.slice(0, 400).toLowerCase();
  // JSON, unless it's a Markdown link at the very start ("[Title](https://…)").
  if (head.startsWith('{') || (head.startsWith('[') && !/^\[[^\]\n]*\]\(/.test(trimmed))) {
    const sample = trimmed.slice(0, 200_000);
    if (/"cards"\s*:/.test(sample)) return 'toby';
    if (/"workspaces"\s*:/.test(sample)) return 'workona';
    if (/"(?:collections|sessions|windows)"\s*:/.test(sample)) return 'session-buddy';
    return 'json';
  }
  if (head.startsWith('<')) {
    return /workona/i.test(trimmed.slice(0, 4000)) ? 'workona' : 'bookmarks';
  }
  if (head.includes('<!doctype netscape-bookmark-file') || head.includes('<dl')) return 'bookmarks';
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 300);
  if (lines.some((l) => /\[[^\]]*\]\(https?:\/\//i.test(l))) return 'links';
  // OneTab's "Export URLs": every line is "address | title".
  if (lines.some((l) => /^[a-z][a-z0-9+.-]*:\/\/\S* \| /i.test(l))) return 'onetab';
  if (lines.some((l) => /https?:\/\//i.test(l))) return 'links';
  return 'onetab';
}
