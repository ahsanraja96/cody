import { useId, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download } from 'lucide-react';
import { db } from '@/lib/db';
import { listLiveSessions } from '@/lib/repo';
import { Button } from '@/ui/components/Button';
import { ProLock } from '@/ui/components/Chips';
import { showProInfo } from '@/ui/components/ProDialog';
import { exportSessions } from '../actions';
import { FlowDialog, GroupLabel, RadioRow } from './FlowDialog';

const LOCKED_FORMATS = ['JSON', 'Markdown', 'CSV'];
export const PRO_EXPORT_FEATURE = 'Exporting as JSON, Markdown and CSV';

/**
 * Export (Library-Dialogs card d): all sessions or the given ones, as HTML. JSON, Markdown and CSV
 * stay visible with a lock and explain Pro.
 */
export function ExportDialog({ sessionIds, onClose }: { sessionIds?: string[]; onClose: () => void }) {
  const live = useLiveQuery(() => listLiveSessions(), []) ?? [];
  const given = useLiveQuery(async () => (sessionIds?.length ? (await db.sessions.bulkGet(sessionIds)).filter((s) => !!s) : []), [sessionIds?.join('|')]) ?? [];
  const [scope, setScope] = useState<'all' | 'given'>(sessionIds?.length ? 'given' : 'all');
  const [busy, setBusy] = useState(false);
  const scopeName = useId();
  const formatName = useId();
  const scopeLabel = useId();
  const formatLabel = useId();

  const run = async () => {
    setBusy(true);
    const ok = await exportSessions(scope === 'given' && sessionIds?.length ? sessionIds : undefined);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <FlowDialog
      open
      onClose={onClose}
      title="Export"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Download size={16} aria-hidden />} disabled={busy} onClick={run}>
            Export HTML
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-labelledby={scopeLabel} className="flex flex-col">
        <GroupLabel id={scopeLabel}>Sessions</GroupLabel>
        <RadioRow name={scopeName} checked={scope === 'all'} onChange={() => setScope('all')}>
          All sessions ({live.length.toLocaleString()})
        </RadioRow>
        {sessionIds && sessionIds.length > 0 && (
          <RadioRow name={scopeName} checked={scope === 'given'} onChange={() => setScope('given')}>
            {sessionIds.length === 1 ? (
              <>
                This session
                <span className="text-text-3" dir="auto">
                  {' '}
                  · {given[0]?.name ?? ''}
                </span>
              </>
            ) : (
              <>Selected sessions ({sessionIds.length.toLocaleString()})</>
            )}
          </RadioRow>
        )}
      </div>
      <div role="radiogroup" aria-labelledby={formatLabel} className="flex flex-col">
        <GroupLabel id={formatLabel}>Format</GroupLabel>
        <RadioRow name={formatName} checked onChange={() => undefined}>
          HTML<span className="text-text-3"> (opens in any browser)</span>
        </RadioRow>
        {LOCKED_FORMATS.map((format) => (
          <button
            key={format}
            type="button"
            aria-label={`${format}, comes with Pro`}
            onClick={() => showProInfo(PRO_EXPORT_FEATURE)}
            className="flex h-8 items-center gap-2.5 rounded-md px-0.5 text-left text-text-3 hover:bg-hover"
          >
            <span aria-hidden className="size-4 shrink-0 rounded-full border border-border bg-hover" />
            <span className="min-w-0 flex-1 truncate">{format}</span>
            <ProLock className="mr-1" />
          </button>
        ))}
      </div>
      <p className="text-meta text-text-3">UTF-8, works with emoji and any language</p>
    </FlowDialog>
  );
}
