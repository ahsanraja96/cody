import { detectImportSource, type ImportedSession, type ImportResult, type ImportSource } from '@/lib/importers';
import { send } from '@/lib/messages';
import { importSessions, type ImportOutcome } from '@/lib/repo';

/**
 * Importing from other tab managers (Mx-Ask "Moving from another tab manager"), page side: parse
 * in a worker, then write with `importSessions`, where collections and workspaces become folders
 * while the Free folder limit allows (the rest go by site) and Free stops at the 500-tab limit.
 * Chrome bookmarks come from `listBookmarkFolders` / `readBookmarkFolder` (src/lib/bookmarks.ts).
 */

export type { ImportOutcome };
export { listBookmarkFolders, readBookmarkFolder, type BookmarkFolder as BookmarkFolderInfo } from '@/lib/bookmarks';

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

export async function importCollections(
  sessions: ImportedSession[],
  options: { asFolders: boolean; unlimited: boolean; onProgress: (done: number) => void },
): Promise<ImportOutcome> {
  await send({ type: 'take-snapshot', reason: 'before-import' }).catch(() => undefined);
  return importSessions(sessions, { asFolders: options.asFolders, unlimited: options.unlimited, onProgress: options.onProgress });
}
