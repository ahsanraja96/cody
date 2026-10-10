/// <reference lib="webworker" />
import { detectImportSource, parseImport, parseOneTab, type ImportResult, type ImportSource } from '@/lib/importers';

/**
 * Parses an import off the main thread (so a 50 MB export never freezes the page), detects the
 * format from the contents, and lists the lines that will be skipped so the results step can show
 * them and "Copy skipped lines" can copy them.
 */
declare const self: DedicatedWorkerGlobalScope;

export interface ParseRequest {
  text: string;
  source?: ImportSource;
}

export interface ParseResponse {
  source: ImportSource;
  result: ImportResult;
  skippedLines: string[];
}

const MAX_LINES = 5000;

/** The importers' own rule for a usable address, applied to one address. */
function usable(url: string): boolean {
  const clean = url.replace(/[\r\n]+/g, ' ').trim();
  return !!clean && parseOneTab(clean).tabCount > 0;
}

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function skippedOneTab(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (parseOneTab(line).tabCount === 0) out.push(line);
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

function skippedBookmarks(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] ?? '';
    const href = decode(/href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /href\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ?? '');
    if (usable(href)) continue;
    const title = decode((match[2] ?? '').replace(/<[^>]+>/g, '')).trim();
    out.push([href.trim(), title].filter(Boolean).join(' | ') || '(empty bookmark)');
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

function skippedSessionBuddy(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return [];
  }
  const out: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (out.length >= MAX_LINES || depth > 10 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.tabs)) {
      for (const item of obj.tabs) {
        const tab = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
        const url = tab ? String(tab.url ?? tab.href ?? '') : '';
        if (tab && usable(url)) continue;
        const title = tab ? String(tab.title ?? tab.name ?? '') : '';
        out.push([url, title].filter(Boolean).join(' | ') || JSON.stringify(item).slice(0, 200));
        if (out.length >= MAX_LINES) return;
      }
      return;
    }
    for (const value of Object.values(obj)) visit(value, depth + 1);
  };
  visit(data, 0);
  return out;
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { text } = event.data;
  const source = event.data.source ?? detectImportSource(text);
  let response: ParseResponse;
  try {
    const result = parseImport(source, text);
    const skippedLines =
      result.skipped === 0
        ? []
        : source === 'onetab'
          ? skippedOneTab(text)
          : source === 'bookmarks'
            ? skippedBookmarks(text)
            : skippedSessionBuddy(text);
    response = { source, result, skippedLines };
  } catch (error) {
    console.error('[tabfold] import parse failed', error);
    response = { source, result: { sessions: [], tabCount: 0, skipped: 0 }, skippedLines: [] };
  }
  self.postMessage(response);
};
