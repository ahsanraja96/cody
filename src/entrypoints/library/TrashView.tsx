import { useLiveQuery } from 'dexie-react-hooks';
import { formatDateTime, plural } from '@/lib/format';
import { listTrash, restoreFromTrash, TRASH_RETENTION_MS } from '@/lib/repo';
import { Button } from '@/ui/components/Button';
import { Favicon } from '@/ui/components/Favicon';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { deleteForever } from './actions';

const DAY = 24 * 60 * 60 * 1000;

export function TrashView({ selectedId, onSelect }: { selectedId?: string; onSelect: (id: string | undefined) => void }) {
  const trash = useLiveQuery(() => listTrash(), []);

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-bg-subtle">
      <div className="flex flex-wrap items-center gap-3 px-6 pt-5">
        <div className="min-w-[240px] flex-1">
          <h1 className="text-page font-semibold">Trash</h1>
          <p className="mt-1 text-text-2">Deleted sessions stay here for 30 days, then they are removed for good.</p>
        </div>
        {trash && trash.length > 0 && (
          <Button
            variant="danger-soft"
            onClick={async () => {
              if (await deleteForever(trash.map((s) => s.id), `${plural(trash.length, 'session')} in Trash`)) {
                onSelect(undefined);
                toast('Trash emptied.');
              }
            }}
          >
            Empty Trash
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2 px-6 pt-5 pb-8">
        {trash?.length === 0 && (
          <p className="rounded-card border border-dashed border-border-strong px-4 py-8 text-center text-text-2">Trash is empty.</p>
        )}
        {trash?.map((session) => {
          const daysLeft = Math.max(0, Math.ceil((session.deletedAt + TRASH_RETENTION_MS - Date.now()) / DAY));
          return (
            <div
              key={session.id}
              onClick={() => onSelect(session.id)}
              className={cx(
                'flex cursor-pointer flex-wrap items-center gap-3 rounded-card border bg-surface px-4 py-3',
                selectedId === session.id ? 'border-accent' : 'border-border hover:border-border-strong',
              )}
            >
              <span aria-hidden className="flex gap-1">
                {session.preview.slice(0, 3).map((p) => (
                  <Favicon key={p.url} url={p.url} />
                ))}
              </span>
              <div className="min-w-[200px] flex-1">
                <div className="truncate font-semibold">{session.name}</div>
                <div className="text-meta text-text-3">
                  {plural(session.tabCount, 'tab')} · deleted {formatDateTime(session.deletedAt)} · removed in {plural(daysLeft, 'day')}
                </div>
              </div>
              <Button
                size="sm"
                onClick={async (e) => {
                  e.stopPropagation();
                  await restoreFromTrash([session.id]);
                  toast(`Restored “${session.name}”.`);
                }}
              >
                Put back
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (await deleteForever([session.id], `“${session.name}”`) && selectedId === session.id) onSelect(undefined);
                }}
              >
                Delete forever
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
