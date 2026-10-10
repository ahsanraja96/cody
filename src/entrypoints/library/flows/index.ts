import type { ImportSource } from '@/lib/importers';
import { flows } from './store';

/**
 * Entry points to the library's dialogs and flows, so views can open them without owning them.
 * The dialogs render in FlowsHost, mounted once by LibraryApp.
 */

/** Export dialog: scope (all sessions or the given ones) and format (HTML on Free; others Pro). */
export function openExportDialog(sessionIds?: string[]): void {
  flows().open({ kind: 'export', sessionIds: sessionIds?.length ? [...sessionIds] : undefined });
}

/** Restore options dialog: as original windows, into this window, or one new window; remembers the choice. */
export function openRestoreDialog(sessionId: string): void {
  flows().open({ kind: 'restore', sessionId });
}

/** Import dialog (OneTab, Session Buddy, bookmarks). `source: 'onetab'` opens straight at the paste step. */
export function openImportDialog(source?: ImportSource): void {
  flows().open({ kind: 'import', source });
}

/** Keyboard shortcuts ("?"). */
export function openShortcutsDialog(): void {
  flows().open({ kind: 'shortcuts' });
}

/** Settings › Clear all data (typed confirmation). */
export function openClearDataDialog(): void {
  flows().open({ kind: 'clear-data' });
}
