import { browser, type Browser } from 'wxt/browser';
import * as bookmarksLib from '@/lib/bookmarks';
import { refreshDataGuard } from '@/lib/dataGuard';
import { detectImportSource, type ImportedSession, type ImportResult, type ImportSource } from '@/lib/importers';
import { FREE_LIMITS } from '@/lib/limits';
import { CommandError, send } from '@/lib/messages';
import { listLiveSessions, saveCapture } from '@/lib/repo';
import { getDeviceId } from '@/lib/state';
import type { CapturedTab, CapturedWindow, TabGroupColor } from '@/lib/types';

/**
 * Importing from other tab managers (Mx-Ask "Moving from another tab manager"), page side:
 * parse in a worker, then write. Collections and workspaces become folders while the Free folder
 * limit allows (the rest go by site), and Free stops at the 500-tab list limit.
 *
 * TODO(merge): CORE-A's `importSessions(sessions, …, { asFolders: true, unlimited })` does the
 * writing (with duplicates counted) and `listBookmarkFolders` / `readBookmarkFolder` read Chrome
 * bookmarks; this file uses them when they exist and falls back to doing it here with
 * `saveCapture` and the `folder-create` command.
 */

export interface ImportOutcome {
  tabs: number;
  /** Folders made from collections. */
  folders: number;
  /** Tabs left out because the free list was full. */
  skippedOverLimit: number;
  /** Collections imported by site because Free has 3 folders. */
  withoutFolder: number;
  /** Pages already in the list (not imported twice). */
  duplicates: number;
}

export function parseInWorker(text: string): Promise<{ source: ImportSource; result: ImportResult }> {
  const source = detectImportSource(text);
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../lib/importers/import.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ImportResult>) => {
      resolve({ source, result: event.data });
      worker.terminate();
    };
    worker.onerror = () => {
      resolve({ source, result: { sessions: [], tabCount: 0, skipped: 0 } });
      worker.terminate();
    };
    worker.postMessage({ source, text });
  });
}

// ---------------------------------------------------------------------------------------------
// Chrome bookmarks (the optional "bookmarks" permission, asked for from the click)

export interface BookmarkFolderInfo {
  id: string;
  /** "Bookmarks bar / Work". */
  path: string;
  /** Links in it and its subfolders. */
  count: number;
}

type CoreBookmarks = {
  listBookmarkFolders?: () => Promise<Array<{ id: string; path?: string; title?: string; count?: number; tabCount?: number }>>;
  readBookmarkFolder?: (id: string) => Promise<ImportedSession[]>;
};
const core = bookmarksLib as unknown as CoreBookmarks;

type Node = Browser.bookmarks.BookmarkTreeNode;

function countLinks(node: Node): number {
  return (node.children ?? []).reduce((n, c) => n + (c.url ? 1 : countLinks(c)), 0);
}

export async function listBookmarkFolders(): Promise<BookmarkFolderInfo[]> {
  if (core.listBookmarkFolders) {
    const list = await core.listBookmarkFolders();
    return list.map((f) => ({ id: f.id, path: f.path ?? f.title ?? '', count: f.count ?? f.tabCount ?? 0 }));
  }
  const tree = await browser.bookmarks.getTree();
  const out: BookmarkFolderInfo[] = [];
  const walk = (node: Node, path: string[]) => {
    for (const child of node.children ?? []) {
      if (child.url) continue;
      const here = [...path, child.title || 'Bookmarks'];
      const n = countLinks(child);
      if (n > 0) out.push({ id: child.id, path: here.join(' / '), count: n });
      walk(child, here);
    }
  };
  for (const root of tree) walk(root, []);
  return out;
}

function captured(url: string, title: string): CapturedTab {
  return { url, title: title || url, favIconUrl: '', pinned: false, groupName: null, groupColor: null, groupCollapsed: false, keywords: [], urlTruncated: false };
}

/** A bookmarks folder as collections: the folder's own links, then one per subfolder. */
export async function readBookmarkFolder(id: string): Promise<ImportedSession[]> {
  if (core.readBookmarkFolder) return core.readBookmarkFolder(id);
  const [root] = await browser.bookmarks.getSubTree(id);
  if (!root) return [];
  const sessions: ImportedSession[] = [];
  const walk = (node: Node, name: string) => {
    const tabs = (node.children ?? []).filter((c) => c.url && /^(https?|file|ftp):/i.test(c.url)).map((c) => captured(c.url!, c.title));
    const window: CapturedWindow = { name: '', focused: false, bounds: null, state: null, tabs };
    if (tabs.length) sessions.push({ name, createdAt: node.dateAdded ?? null, windows: [window] });
    for (const child of node.children ?? []) if (!child.url) walk(child, child.title || name);
  };
  walk(root, root.title || 'Bookmarks');
  return sessions;
}

// ---------------------------------------------------------------------------------------------
// Writing

const COLORS: TabGroupColor[] = ['blue', 'purple', 'green', 'cyan', 'orange', 'pink', 'yellow', 'red'];
/** Tabs written per transaction, so a huge import shows progress and never holds one giant write. */
const CHUNK = 2000;

async function foldedTabCount(): Promise<number> {
  return (await listLiveSessions()).reduce((n, s) => n + (s.tabCount || 0), 0);
}

export async function importCollections(
  sessions: ImportedSession[],
  options: { name: string; asFolders: boolean; unlimited: boolean; onProgress: (done: number) => void },
): Promise<ImportOutcome> {
  await send({ type: 'take-snapshot', reason: 'before-import' }).catch(() => undefined);
  const deviceId = await getDeviceId();
  let room = options.unlimited ? Number.POSITIVE_INFINITY : Math.max(0, FREE_LIMITS.tabs - (await foldedTabCount()));
  const outcome: ImportOutcome = { tabs: 0, folders: 0, skippedOverLimit: 0, withoutFolder: 0, duplicates: 0 };
  let sessionId: string | null = null;
  let foldersFull = false;

  for (const [index, session] of sessions.entries()) {
    const tabsHere = session.windows.reduce((n, w) => n + w.tabs.length, 0);
    // Free: what fits in the list; the rest is left out (and counted), never half a collection silently.
    let windows = session.windows;
    if (tabsHere > room) {
      let left = room;
      windows = session.windows
        .map((w) => {
          const tabs = w.tabs.slice(0, Math.max(0, left));
          left -= tabs.length;
          return { ...w, tabs };
        })
        .filter((w) => w.tabs.length > 0);
      outcome.skippedOverLimit += tabsHere - Math.max(0, room);
    }
    if (windows.length === 0) continue;
    const ids: string[] = [];
    let batch: CapturedWindow[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const saved = await saveCapture(
        batch.map((w) => ({ ...w, name: w.name || (sessions.length > 1 && !options.asFolders ? session.name : '') })),
        { name: options.name, source: 'import', deviceId, now: Date.now() },
        { dedupe: false, targetSessionId: sessionId },
      );
      sessionId = saved.sessionId;
      ids.push(...saved.savedTabIds);
      outcome.tabs += saved.savedTabIds.length;
      batch = [];
      options.onProgress(outcome.tabs);
      await new Promise((r) => setTimeout(r, 0));
    };
    for (const window of windows) {
      batch.push(window);
      if (batch.reduce((n, w) => n + w.tabs.length, 0) >= CHUNK) await flush();
    }
    await flush();
    room -= ids.length;
    if (!options.asFolders || ids.length === 0) continue;
    if (foldersFull) {
      outcome.withoutFolder += 1;
      continue;
    }
    try {
      await send({ type: 'folder-create', name: session.name.slice(0, 60) || 'Imported', color: COLORS[index % COLORS.length], tabRecordIds: ids });
      outcome.folders += 1;
    } catch (error) {
      if (error instanceof CommandError && error.code === 'folder-limit') foldersFull = true;
      outcome.withoutFolder += 1;
    }
  }
  await refreshDataGuard().catch(() => undefined);
  return outcome;
}
