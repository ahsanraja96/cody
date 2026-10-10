import { useLiveQuery } from 'dexie-react-hooks';
import { History } from 'lucide-react';
import { formatDateTime, plural } from '@/lib/format';
import { send } from '@/lib/messages';
import { listSnapshots } from '@/lib/repo';
import { db } from '@/lib/db';
import type { SnapshotReason } from '@/lib/types';
import { Button } from '@/ui/components/Button';
import { Favicon } from '@/ui/components/Favicon';
import { toast } from '@/ui/components/Toast';
import { currentScreen, useRecoveryOffer } from '@/ui/hooks';

const REASONS: Record<SnapshotReason, string> = {
  shutdown: 'Last session before the browser restarted',
  timer: 'Latest',
  'before-restore': 'Before a restore',
  'before-bulk-close': 'Before saving and closing tabs',
  'before-import': 'Before an import',
  manual: 'Taken by you',
};

export function SnapshotsView() {
  const snapshots = useLiveQuery(() => listSnapshots(), []);
  const offer = useRecoveryOffer();

  const restore = async (snapshotId: number) => {
    try {
      const outcome = await send({ type: 'restore-snapshot', snapshotId, mode: 'original', screen: currentScreen() });
      if (outcome.failed.length) toast(`Restored ${outcome.opened} tabs. ${outcome.failed.length} could not be reopened.`, { tone: 'error' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Restore failed.', { tone: 'error' });
    }
  };

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-bg-subtle">
      <div className="flex flex-wrap items-center gap-3 px-6 pt-5">
        <div className="min-w-[240px] flex-1">
          <h1 className="text-page font-semibold">Snapshots</h1>
          <p className="mt-1 text-text-2">
            Tabfold keeps a copy of your open windows in the background, and before any bulk close, restore or import. Free keeps
            the last session; safety copies are kept for 7 days.
          </p>
        </div>
        <Button
          icon={<History size={16} aria-hidden />}
          onClick={async () => {
            const { snapshotId } = await send({ type: 'take-snapshot' });
            toast(snapshotId ? 'Snapshot taken.' : 'Nothing open to snapshot.');
          }}
        >
          Take snapshot now
        </Button>
      </div>

      <div className="flex flex-col gap-3 px-6 pt-5 pb-8">
        {snapshots?.length === 0 && (
          <p className="rounded-card border border-dashed border-border-strong px-4 py-8 text-center text-text-2">
            No snapshots yet. They appear after your first browser restart or bulk action.
          </p>
        )}
        {snapshots?.map((snap) => (
          <article key={snap.id} className="flex flex-wrap items-center gap-4 rounded-card border border-border bg-surface p-4">
            <div className="min-w-[240px] flex-1">
              <div className="flex items-center gap-2 font-semibold">
                {REASONS[snap.reason]}
                {offer?.snapshotId === snap.id && (
                  <span className="rounded bg-accent-soft px-1.5 text-meta font-semibold text-accent-text">Not restored yet</span>
                )}
              </div>
              <div className="mt-0.5 text-meta text-text-3">
                {formatDateTime(snap.createdAt)} · {plural(snap.tabCount, 'tab')} · {plural(snap.windowCount, 'window')}
              </div>
              <div aria-hidden className="mt-2 flex gap-1">
                {snap.windows
                  .flatMap((w) => w.tabs)
                  .slice(0, 10)
                  .map((t, i) => (
                    <Favicon key={`${t.url}-${i}`} url={t.url} size={16} />
                  ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => snap.id !== undefined && restore(snap.id)}>
                Restore windows
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  if (snap.id === undefined) return;
                  const { sessionId } = await send({ type: 'snapshot-to-session', snapshotId: snap.id });
                  if (sessionId) toast('Saved as a session.');
                }}
              >
                Save as session
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (snap.id === undefined) return;
                  await db.snapshots.delete(snap.id);
                  if (offer?.snapshotId === snap.id) await send({ type: 'dismiss-recovery' });
                }}
              >
                Delete
              </Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
