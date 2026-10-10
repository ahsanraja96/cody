import { useLiveQuery } from 'dexie-react-hooks';
import { Clock, Info, Trash2, Undo2 } from 'lucide-react';
import { plural } from '@/lib/format';
import { deleteSessionsForever, listTrash, restoreFromTrash, TRASH_RETENTION_MS } from '@/lib/repo';
import { emptyTrash } from './actions';
import type { SessionRecord } from '@/lib/types';
import { Button } from '@/ui/components/Button';
import { confirmAction } from '@/ui/components/Dialog';
import { Favicon } from '@/ui/components/Favicon';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';

const DAY = 24 * 60 * 60 * 1000;

function deletedLabel(deletedAt: number, now: number): string {
  const days = Math.floor((now - deletedAt) / DAY);
  if (days <= 0) return 'Deleted today';
  if (days === 1) return 'Deleted yesterday';
  return `Deleted ${days} days ago`;
}

/** Trash (Library-Trash): 30 days to change your mind; Delete forever only here, always confirmed. */
export function TrashView({ selectedId, onSelect }: { selectedId?: string; onSelect: (id: string | undefined) => void }) {
  const trash = useLiveQuery(() => listTrash(), []);
  const now = Date.now();
  const tabs = (trash ?? []).reduce((n, s) => n + s.tabCount, 0);

  const emptyAll = async () => {
    if (await emptyTrash()) onSelect(undefined);
  };

  const deleteOne = async (session: SessionRecord) => {
    const ok = await confirmAction({
      title: `Delete ${session.name} forever?`,
      body: `Its ${plural(session.tabCount, 'tab')} can't be recovered.`,
      confirmLabel: 'Delete forever',
      danger: true,
    });
    if (!ok) return;
    await deleteSessionsForever([session.id]);
    if (selectedId === session.id) onSelect(undefined);
  };

  const restore = async (session: SessionRecord) => {
    await restoreFromTrash([session.id]);
    if (selectedId === session.id) onSelect(undefined);
    toast(`Restored ${session.name}.`);
  };

  return (
    <section aria-label="Trash" className="scroll-thin h-full overflow-y-auto bg-bg-subtle px-6 pt-5 pb-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[240px] flex-1">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-page font-semibold">Trash</h1>
            {trash && trash.length > 0 && (
              <span className="text-text-3">
                {plural(trash.length, 'session')} · {plural(tabs, 'tab')}
              </span>
            )}
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-text-2">
            <Info size={14} aria-hidden className="shrink-0" />
            Sessions in Trash are deleted for good after 30 days.
          </p>
        </div>
        {trash && trash.length > 0 && (
          <Button variant="danger-soft" icon={<Trash2 size={16} aria-hidden />} onClick={() => void emptyAll()}>
            Empty Trash
          </Button>
        )}
      </div>

      {trash?.length === 0 && (
        <p className="mt-5 rounded-card border border-dashed border-border-strong px-4 py-10 text-center text-text-2">
          Trash is empty. Sessions you delete stay here for 30 days.
        </p>
      )}

      {trash && trash.length > 0 && (
        <div role="grid" aria-label="Sessions in Trash" className="@container mt-5 rounded-card border border-border bg-surface">
          {trash.map((session, index) => {
            const daysLeft = Math.max(0, Math.ceil((session.deletedAt + TRASH_RETENTION_MS - now) / DAY));
            const soon = daysLeft < 3;
            return (
              <div
                key={session.id}
                role="row"
                aria-current={selectedId === session.id || undefined}
                onClick={() => onSelect(session.id)}
                className={cx(
                  'group flex h-14 cursor-pointer items-center gap-4 pr-3 pl-4 hover:bg-hover has-[:focus-visible]:bg-hover',
                  index < trash.length - 1 && 'border-b border-border',
                  index === 0 && 'rounded-t-card',
                  index === trash.length - 1 && 'rounded-b-card',
                  selectedId === session.id && 'shadow-[inset_3px_0_0_var(--tf-accent)]',
                )}
              >
                <span role="gridcell" aria-hidden className="flex w-16 shrink-0 gap-1">
                  {session.preview.slice(0, 3).map((p, i) => (
                    <Favicon key={`${p.url}-${i}`} url={p.url} />
                  ))}
                </span>
                <span role="gridcell" className="flex min-w-0 flex-1 flex-col">
                  <button
                    type="button"
                    dir="auto"
                    title={session.name}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(session.id);
                    }}
                    className="truncate text-left font-semibold"
                  >
                    {session.name}
                  </button>
                  <span className="text-meta text-text-3">
                    {plural(session.tabCount, 'tab')} · {plural(session.windowCount, 'window')}
                  </span>
                </span>
                <span role="gridcell" className="w-40 shrink-0 text-small text-text-2 @max-[640px]:hidden">
                  {deletedLabel(session.deletedAt, now)}
                </span>
                <span role="gridcell" className="flex w-[140px] shrink-0">
                  {soon ? (
                    <span className="inline-flex h-[22px] items-center gap-[5px] rounded-full border border-amber-line bg-amber-soft px-2 text-meta font-semibold text-amber">
                      <Clock size={12} aria-hidden />
                      {daysLeft === 0 ? 'Less than a day left' : `${plural(daysLeft, 'day')} left`}
                    </span>
                  ) : (
                    <span className="text-small text-text-2">{plural(daysLeft, 'day')} left</span>
                  )}
                </span>
                <span className="invisible flex w-[260px] shrink-0 items-center justify-end gap-1 group-hover:visible group-has-[:focus-visible]:visible @max-[760px]:w-auto">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void restore(session);
                    }}
                    className="inline-flex h-7 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover"
                  >
                    <Undo2 size={14} aria-hidden />
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteOne(session);
                    }}
                    className="inline-flex h-7 items-center rounded-control px-2 text-small font-semibold whitespace-nowrap text-red hover:bg-red-soft"
                  >
                    Delete forever
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {trash && trash.length > 0 && (
        <p className="mx-1 mt-3 text-small text-text-3">
          Looking for one tab? Search can look in Trash too: switch the search scope to <span className="font-semibold text-text-2">Trash</span>.
        </p>
      )}
    </section>
  );
}
