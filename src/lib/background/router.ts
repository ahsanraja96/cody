import { isQuotaError } from '../db';
import { CommandError, type Command, type CommandResponse, type CommandResults } from '../messages';
import { syncNow } from '../sync/engine';
import { handleFold } from './fold';
import {
  cancelRestore,
  handleOpenSavedTab,
  handleOpenTabs,
  handleRestore,
  handleRestoreSnapshot,
  handleSnapshotToSession,
} from './restore';
import { handleSave, handleUndo, preflightSave } from './save';
import { dismissRecovery, recoverFromMirror, takeSnapshot } from './snapshots';
import { suspendInactive, suspendTab } from './suspend';

async function dispatch(command: Command): Promise<CommandResults[Command['type']]> {
  switch (command.type) {
    case 'preflight-save':
      return preflightSave(command);
    case 'save':
      return handleSave(command);
    case 'undo':
      return handleUndo(command.actionId);
    case 'restore':
      return handleRestore(command);
    case 'restore-snapshot':
      return handleRestoreSnapshot(command);
    case 'snapshot-to-session':
      return handleSnapshotToSession(command.snapshotId);
    case 'cancel-restore':
      return { cancelled: cancelRestore(command.restoreId) };
    case 'open-saved-tab':
      return handleOpenSavedTab(command.tabRecordId, command.active, command.windowId);
    case 'suspend-inactive':
      return suspendInactive(command.windowId);
    case 'suspend-tab':
      return suspendTab(command.tabId);
    case 'take-snapshot':
      return { snapshotId: await takeSnapshot(command.reason ?? 'manual') };
    case 'dismiss-recovery':
      await dismissRecovery();
      return { ok: true };
    case 'fold':
      return handleFold();
    case 'open-tabs':
      return handleOpenTabs(command);
    case 'sync-now':
      return syncNow();
    case 'recover-from-mirror':
      return recoverFromMirror();
  }
}

/** Every handler is wrapped: one failure becomes a readable error for the page, never a dead worker. */
export async function route(command: Command): Promise<CommandResponse<unknown>> {
  try {
    return { ok: true, data: await dispatch(command) };
  } catch (error) {
    console.error('[tabfold] command failed', command.type, error);
    if (error instanceof CommandError) return { ok: false, error: error.message, code: error.code };
    if (isQuotaError(error)) {
      return { ok: false, error: 'Browser storage is full. Nothing was closed.', code: 'quota' };
    }
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
