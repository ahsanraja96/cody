import { browser, type Browser } from 'wxt/browser';
import { groupByCategory } from './categories';
import { db, type TabfoldDB } from './db';
import { formatDay } from './exporters';
import { CommandError } from './messages';
import { listFoldedTabs } from './repo';

/**
 * "Save them to Chrome bookmarks" before removing Tabfold (Min-Remove board): a bookmarks folder
 * "Tabfold · 10 Oct 2026" under "Other bookmarks", with a subfolder per kind of site (newest
 * first), which stays after Tabfold is gone. Tabs folded from Incognito are left out: bookmarks go
 * to Chrome sync, which those tabs never do.
 * Needs the optional "bookmarks" permission: the page asks for it (from the click) before calling.
 */

type BookmarkNode = Browser.bookmarks.BookmarkTreeNode;

/** "Other bookmarks" (by its folder type, Chrome's usual id, then its name), or the first folder. */
function otherBookmarks(tree: BookmarkNode[]): BookmarkNode | undefined {
  const top = tree[0]?.children ?? [];
  const folders = top.filter((node) => !node.url);
  return (
    folders.find((node) => (node as { folderType?: string }).folderType === 'other') ??
    folders.find((node) => node.id === '2') ??
    folders.find((node) => /other bookmarks/i.test(node.title)) ??
    folders[0]
  );
}

export async function saveListToBookmarks(
  options: { now?: number; database?: TabfoldDB } = {},
): Promise<{ folderTitle: string; saved: number; skippedIncognito: number }> {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const database = options.database ?? db;
  const api = (browser as { bookmarks?: typeof browser.bookmarks }).bookmarks;
  if (!api?.create) {
    throw new CommandError('Tabfold needs permission to add bookmarks. Allow it, then try again.', 'bookmarks-permission');
  }
  const all = await listFoldedTabs(database);
  const tabs = all.filter((tab) => !tab.incognito);
  const parent = otherBookmarks(await api.getTree());
  if (!parent) throw new CommandError('Chrome’s bookmarks couldn’t be found.', 'bookmarks-missing');

  const folderTitle = `Tabfold · ${formatDay(now)}`;
  const folder = await api.create({ parentId: parent.id, title: folderTitle });
  let saved = 0;
  for (const group of groupByCategory(tabs, (t) => t.url, (t) => t.savedAt)) {
    const sub = await api.create({ parentId: folder.id, title: group.category.name });
    for (const tab of group.items) {
      try {
        await api.create({ parentId: sub.id, title: tab.title || tab.url, url: tab.url });
        saved += 1;
      } catch {
        // Chrome refuses some addresses as bookmarks; the rest still go in.
      }
    }
  }
  return { folderTitle, saved, skippedIncognito: all.length - tabs.length };
}
