/**
 * "Save them to Chrome bookmarks" before removing Tabfold (Min-Remove board): a bookmarks folder
 * "Tabfold · 10 Oct 2026" with a subfolder per kind of site, which stays after Tabfold is gone.
 * Needs the optional "bookmarks" permission: the page asks for it (from the click) before calling.
 * Placeholder until the build lands.
 */
export async function saveListToBookmarks(): Promise<{ folderTitle: string; saved: number }> {
  throw new Error('Not built yet');
}
