import { useId, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { countAll } from '@/lib/dataGuard';
import { plural } from '@/lib/format';
import { Button } from '@/ui/components/Button';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { clearEverything, exportSessions } from '../actions';
import { FlowDialog } from './FlowDialog';

const WORD = 'DELETE';

/**
 * Settings › Clear all data (Library-Dialogs card h). The only typed confirmation in Tabfold:
 * "Clear all data" stays disabled until DELETE is typed. "Export first" downloads a backup and
 * keeps the dialog open.
 */
export function ClearDataDialog({ onClose }: { onClose: () => void }) {
  const counts = useLiveQuery(() => countAll(), []);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const ready = text.trim() === WORD;

  const clear = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await clearEverything();
      toast('All data cleared.');
      onClose();
    } catch {
      toast("Couldn't clear the data. Nothing was deleted; try again.", { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlowDialog open onClose={onClose} title="Clear all Tabfold data?" showClose={false} bodyClassName="gap-2.5 px-5 pt-[18px] pb-5">
      <p className="text-text-2">
        {counts ? `${plural(counts.sessions, 'session')}, ${plural(counts.tabs, 'tab')}` : 'Every session and tab'}, tags, keywords and snapshots will be
        deleted from this device. Export first if you might need them.
      </p>
      <div className="mt-0.5 flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-small text-text-2">
          Type {WORD} to confirm
        </label>
        <input
          id={inputId}
          value={text}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void clear();
          }}
          className={cx(
            'h-9 rounded-control border bg-surface px-2.5 font-mono text-body text-text outline-none',
            'border-border-strong focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-soft)]',
          )}
        />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <span className="flex-1" />
        <Button onClick={() => exportSessions()}>Export first</Button>
        <Button variant="danger" disabled={!ready || busy} aria-disabled={!ready || busy} className="disabled:opacity-40" onClick={clear}>
          Clear all data
        </Button>
      </div>
    </FlowDialog>
  );
}
