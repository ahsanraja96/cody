import { useEffect, useRef } from 'react';
import { createElement } from 'react';
import { CircleStop } from 'lucide-react';
import { toast } from '@/ui/components/Toast';
import { useWorkerEvents } from '@/ui/hooks';
import { ImportDialog } from '@/ui/ImportPanel';
import { cancelRestore, reportRestoreOutcome, stoppedMessage } from '../actions';
import { RestoreProgressFloating } from '../RestoreProgress';
import { ClearDataDialog } from './ClearDataDialog';
import { ExportDialog } from './ExportDialog';
import { useRestoreProgress, type RestoreProgressInfo } from './progress';
import { AlreadyOpenDialog, FileAccessDialog, RestoreFailuresCard, RestoreOptionsDialog } from './RestoreDialogs';
import { ShortcutsDialog } from './ShortcutsDialog';
import { flows, useFlows } from './store';

/**
 * Mounted once by LibraryApp: the open flow dialog, restore progress for sessions not shown in the
 * detail panel, and the restore-done bookkeeping for restores this page cancelled.
 */
export function FlowsHost({
  detailSessionId,
  onOpenSession,
}: {
  /** The session open in the detail panel, which shows its own progress and failures. */
  detailSessionId?: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const dialog = useFlows((s) => s.dialog);
  const close = useFlows((s) => s.close);
  const failures = useFlows((s) => s.failures);
  const progress = useRestoreProgress();
  const last = useRef<RestoreProgressInfo | undefined>(undefined);

  useWorkerEvents((event) => {
    const state = flows();
    if (event.type === 'restore-progress') {
      if (!state.handled.has(event.restoreId)) state.setLive(event);
    } else if (event.type === 'restore-done') {
      if (state.live?.restoreId === event.restoreId) state.setLive(null);
      // Restores this page started report through their own answer; ones it only cancelled report here.
      if (state.owned.has(event.restoreId)) {
        const name = last.current?.restoreId === event.restoreId ? last.current.name : '';
        reportRestoreOutcome(event.outcome, { sessionId: last.current?.sessionId ?? null, sessionName: name });
      }
    }
  });

  // A restore cancelled here that finished without a restore-done event still gets its "Stopped" toast.
  useEffect(() => {
    if (progress) {
      last.current = progress;
      return;
    }
    const gone = last.current;
    if (!gone) return;
    const timer = setTimeout(() => {
      const state = flows();
      if (state.owned.has(gone.restoreId) && !state.handled.has(gone.restoreId)) {
        state.handled.add(gone.restoreId);
        toast(stoppedMessage(gone.done), { icon: createElement(CircleStop, { size: 16, strokeWidth: 2, 'aria-hidden': true }) });
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [progress]);

  const showFloatingProgress = progress && !(progress.sessionId && progress.sessionId === detailSessionId);
  const showFloatingFailures = failures && !(failures.sessionId && failures.sessionId === detailSessionId);

  return (
    <>
      {showFloatingProgress && <RestoreProgressFloating progress={progress} onCancel={() => cancelRestore(progress.restoreId)} />}
      {showFloatingFailures && !showFloatingProgress && (
        <div className="anim-in fixed right-6 bottom-6 z-40 w-[min(400px,calc(100vw-48px))] shadow-pop">
          <RestoreFailuresCard failures={failures} onDismiss={() => flows().setFailures(null)} />
        </div>
      )}
      {dialog?.kind === 'export' && <ExportDialog sessionIds={dialog.sessionIds} onClose={close} />}
      {dialog?.kind === 'restore' && <RestoreOptionsDialog sessionId={dialog.sessionId} onClose={close} />}
      {dialog?.kind === 'already-open' && <AlreadyOpenDialog {...dialog} onClose={close} />}
      {dialog?.kind === 'file-access' && (
        <FileAccessDialog sessionName={dialog.sessionName} files={dialog.files} opened={dialog.opened} onClose={close} />
      )}
      {dialog?.kind === 'shortcuts' && <ShortcutsDialog onClose={close} />}
      {dialog?.kind === 'clear-data' && <ClearDataDialog onClose={close} />}
      <ImportDialog open={dialog?.kind === 'import'} initialSource={dialog?.kind === 'import' ? dialog.source : undefined} onClose={close} onOpenSession={onOpenSession} />
    </>
  );
}
