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

export type ImportSource = 'onetab' | 'session-buddy' | 'bookmarks';

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

export function parseImport(source: ImportSource, text: string): ImportResult {
  switch (source) {
    case 'onetab':
      return parseOneTab(text);
    case 'session-buddy':
      return parseSessionBuddy(text);
    case 'bookmarks':
      return parseBookmarksHtml(text);
  }
}

/** Guess the format from file contents, for drag-and-drop. */
export function detectImportSource(text: string): ImportSource {
  const head = text.trimStart().slice(0, 400).toLowerCase();
  if (head.startsWith('{') || head.startsWith('[')) return 'session-buddy';
  if (head.includes('<!doctype netscape-bookmark-file') || head.includes('<dl')) return 'bookmarks';
  return 'onetab';
}
