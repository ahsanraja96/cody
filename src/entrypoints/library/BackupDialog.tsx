import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, History, LoaderCircle, X } from 'lucide-react';
import { send } from '@/lib/messages';
import type { BackupInfo } from '@/lib/pro/types';
import { Modal } from '@/ui/components/Modal';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { proErrorText, shortDate } from '@/ui/pro';
import { count } from './format';

const DAY_MS = 24 * 60 * 60 * 1000;

function clock(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function startOfDay(timestamp: number): number {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A backup's day (YYYY-MM-DD, UTC) as a time stamp at its middle, for formatting. */
export function backupDay(day: string): number {
  return Date.parse(`${day}T12:00:00Z`);
}

/** "Today 09:12", "Yesterday 09:05", "8 Oct" (Pro-States "Restore a backup"). */
export function backupLabel(backup: BackupInfo, now = Date.now()): string {
  const at = backup.createdAt || backupDay(backup.day);
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return `Today ${clock(at)}`;
  if (days === 1) return `Yesterday ${clock(at)}`;
  return shortDate(at);
}

type Load = { kind: 'loading' } | { kind: 'ready'; backups: BackupInfo[] } | { kind: 'error'; message: string };

/**
 * Restore a backup (Pro): one a day, kept 30 days. Restoring brings back the tabs from that day
 * that aren't in the list now, as a fold of their own; nothing is deleted.
 */
export function BackupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      setLoad({ kind: 'ready', backups: await send({ type: 'backups-list' }) });
    } catch (error) {
      setLoad({ kind: 'error', message: proErrorText(error) });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setProblem(null);
    void fetchList();
  }, [open, fetchList]);

  const restore = async (backup: BackupInfo) => {
    setBusy(backup.day);
    setProblem(null);
    try {
      const { restored } = await send({ type: 'backup-restore', day: backup.day });
      onClose();
      toast(
        restored > 0
          ? `Brought back ${count(restored, 'tab')} into “Restored · ${shortDate(backupDay(backup.day))}”`
          : 'Nothing to bring back: every tab is already in your list.',
        { tone: restored > 0 ? 'success' : 'default' },
      );
    } catch (error) {
      setProblem(proErrorText(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="backup-h" width={460}>
      <div className="flex max-h-[min(640px,calc(100vh-32px))] flex-col">
        <header className="flex items-start gap-3 pt-5 pr-4 pb-2 pl-5">
          <div className="min-w-0 flex-1">
            <h1 id="backup-h" className="m-0 text-section font-semibold">
              Restore a backup
            </h1>
            <p className="mt-1 mb-0 text-small text-text-3">
              One backup a day, kept 30 days. Restoring brings back tabs removed since then; nothing you have now is deleted.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
          >
            <X size={18} strokeWidth={1.75} aria-hidden />
          </button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-4">
          {load.kind === 'loading' && (
            <p role="status" className="m-0 flex h-10 items-center gap-2.5 px-2 text-text-2">
              <LoaderCircle size={16} aria-hidden className="tf-spin shrink-0 text-text-3" />
              Loading backups…
            </p>
          )}
          {load.kind === 'error' && (
            <div role="alert" className="mx-2 flex items-start gap-2.5 rounded-card border border-border bg-bg-subtle px-3.5 py-3">
              <CircleAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-red" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Couldn’t load your backups</div>
                <div className="text-small text-text-2">{load.message}</div>
              </div>
              <button
                type="button"
                onClick={() => void fetchList()}
                className="inline-flex h-7 shrink-0 items-center rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold hover:bg-hover"
              >
                Try again
              </button>
            </div>
          )}
          {load.kind === 'ready' && load.backups.length === 0 && (
            <p role="status" className="m-0 px-2 py-2 text-text-2">
              No backups yet. Tabfold makes one each day your tabs sync with your Tabfold account.
            </p>
          )}
          {load.kind === 'ready' && load.backups.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {load.backups.map((backup) => {
                const label = backupLabel(backup);
                const working = busy === backup.day;
                return (
                  <li
                    key={backup.day}
                    className={cx('group flex h-10 items-center gap-2.5 rounded-control px-2 hover:bg-hover focus-within:bg-hover', working && 'bg-hover')}
                  >
                    <History size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="shrink-0 text-small text-text-3 tabular-nums">{count(backup.tabCount, 'tab')}</span>
                    <button
                      type="button"
                      disabled={busy !== null}
                      aria-label={`Restore the backup from ${label}, ${count(backup.tabCount, 'tab')}`}
                      onClick={() => void restore(backup)}
                      className={cx(
                        'ml-2 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover',
                        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-default',
                        working && 'opacity-100',
                      )}
                    >
                      {working && <LoaderCircle size={12} aria-hidden className="tf-spin" />}
                      Restore
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {problem && (
            <p role="alert" className="mx-2 mt-2 mb-0 flex items-start gap-2 text-small text-red">
              <CircleAlert size={14} strokeWidth={1.75} aria-hidden className="mt-[2px] shrink-0" />
              {problem}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
