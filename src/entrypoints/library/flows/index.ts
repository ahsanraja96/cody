import { exportSessions, restoreSession } from '../actions';

/**
 * Entry points to the library's dialogs and flows, so views can open them without owning them.
 * Contract stubs: the flows work replaces these bodies with the real dialogs.
 */

/** Export dialog: scope (all sessions or the given ones) and format (HTML on Free; others Pro). */
export function openExportDialog(sessionIds?: string[]): void {
  void exportSessions(sessionIds);
}

/** Restore options dialog: as original windows, into this window, or one new window; remembers the choice. */
export function openRestoreDialog(sessionId: string): void {
  void restoreSession(sessionId, 'original');
}
