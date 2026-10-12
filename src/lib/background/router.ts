import { isQuotaError } from '../db';
import { CommandError, type Command, type CommandResponse, type CommandResults } from '../messages';
import { syncNow } from '../sync/engine';
import { handleAutomationCommand } from './automation';
import { handleFold } from './fold';
import { handleFolderCommand } from './folders';
import { handleLiveCommand } from './live';
import { handleProCommand } from './pro';
import {
  cancelRestore,
  handleOpenSavedTab,
  handleOpenTabs,
  handleRestore,
  handleRestoreSnapshot,
  handleSnapshotToSession,
} from './restore';
import { handleSave, handleUndo, preflightSave } from './save';
import { handleShareCommand } from './share';
import { handleTeamCommand } from './teams';
import { dismissRecovery, recoverFromMirror, takeSnapshot } from './snapshots';
import { suspendInactive, suspendTab } from './suspend';
import { handleTidyCommand } from './tidy';
import { handleWindowsCommand } from './windows';

/** Where a command came from: the Tabfold tab that sent it (none for the popup). */
export interface CommandSource {
  tabId?: number;
}

async function dispatch(command: Command, source: CommandSource): Promise<CommandResults[Command['type']]> {
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
      // A fold started from a Tabfold page leaves that page open.
      return handleFold({
        keepTabId: source.tabId,
        windowId: command.windowId,
        keepWindowOpen: command.keepWindowOpen,
        tabIds: command.tabIds,
        intoFolderId: command.intoFolderId,
        source: command.source,
      });
    case 'open-tabs':
      return handleOpenTabs(command);
    case 'sync-now':
      return syncNow();
    case 'recover-from-mirror':
      return recoverFromMirror();
    case 'plan-refresh':
    case 'checkout-open':
    case 'checkout-focus':
    case 'billing-open':
    case 'signin-start':
    case 'signin-finish':
    case 'trial-start':
    case 'signout':
    case 'ai-organise':
    case 'ai-apply':
    case 'ai-context':
    case 'backups-list':
    case 'backup-restore':
    case 'cloud-sync-now':
    case 'milestone-dismiss':
    case 'reopen-everything':
      // Checkout and billing tabs open next to the Tabfold page that asked.
      return handleProCommand(command, source);
    case 'folder-create':
    case 'folder-update':
    case 'folder-reorder':
    case 'folder-delete':
    case 'tabs-move':
    case 'site-kind-set':
    case 'room-list':
    case 'room-free':
    case 'duplicates-list':
    case 'duplicates-remove':
      return handleFolderCommand(command);
    case 'snooze':
    case 'snooze-wake':
    case 'snooze-seen':
    case 'autofold-run':
      return handleAutomationCommand(command);
    case 'live-open':
    case 'live-fold':
    case 'live-focus':
      return handleLiveCommand(command);
    case 'share-create':
    case 'share-update':
    case 'share-stop':
    case 'share-info':
      return handleShareCommand(command);
    case 'ai-ask':
    case 'tidy-run':
    case 'tidy-apply':
    case 'tidy-dismiss':
      return handleTidyCommand(command);
    case 'team-get':
    case 'team-rename':
    case 'team-invite':
    case 'team-cancel-invite':
    case 'team-remove':
    case 'team-leave':
    case 'team-sync-now':
    case 'team-keep-copy':
    case 'team-gone-dismiss':
      return handleTeamCommand(command);
    case 'copies-close':
    case 'window-tidy':
    case 'window-rename':
    case 'weekly-summary-dismiss':
      return handleWindowsCommand(command);
  }
}

/** Every handler is wrapped: one failure becomes a readable error for the page, never a dead worker. */
export async function route(command: Command, source: CommandSource = {}): Promise<CommandResponse<unknown>> {
  try {
    return { ok: true, data: await dispatch(command, source) };
  } catch (error) {
    // The command's type and the error's name only: commands can carry emails and sign-in codes.
    console.error('[tabfold] command failed', command.type, error instanceof CommandError ? error.code : error);
    if (error instanceof CommandError) {
      return { ok: false, error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) };
    }
    if (isQuotaError(error)) {
      return { ok: false, error: 'Browser storage is full. Nothing was closed.', code: 'quota' };
    }
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
