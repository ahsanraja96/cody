import { useEffect, useId, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { send, type DuplicateGroup } from '@/lib/messages';
import { Favicon } from '@/ui/components/Favicon';
import { Modal } from '@/ui/components/Modal';
import { proErrorText } from '@/ui/pro';
import { handleCommandError, undoToast } from './folderActions';
import { count } from './format';

/**
 * "Same page twice" (Mx-Ask, Free): pages folded more than once, with how many copies, and
 * "Remove N copies" (the newest copy stays, with its folder). Undo in the toast.
 */
export function DuplicatesDialog({ onClose }: { onClose: () => void }) {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  useEffect(() => {
    let alive = true;
    send({ type: 'duplicates-list' })
      .then((result) => alive && setGroups(result.groups))
      .catch((error) => alive && setProblem(proErrorText(error)));
    return () => {
      alive = false;
    };
  }, []);

  const extra = (groups ?? []).reduce((n, g) => n + Math.max(0, g.tabRecordIds.length - 1), 0);

  const remove = async () => {
    setBusy(true);
    try {
      const { removed, actionId } = await send({ type: 'duplicates-remove' });
      onClose();
      undoToast(`Removed ${count(removed, 'copy', 'copies')}. The newest of each stays.`, [actionId]);
    } catch (error) {
      setBusy(false);
      handleCommandError(error);
    }
  };

  return (
    <Modal open onClose={onClose} labelledBy={titleId} width={420}>
      <div className="flex max-h-[min(640px,calc(100vh-32px))] flex-col px-[22px] pt-5 pb-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="m-0 text-[17px] font-semibold">
              Same page twice
            </h2>
            <p className="mt-1.5 mb-0 text-text-2">Pages you folded more than once. The newest copy stays, with its folder.</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="-mt-1 -mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
          >
            <X size={18} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="scroll-thin mt-3.5 min-h-0 flex-1 overflow-y-auto">
          {problem && (
            <p role="alert" className="m-0 border-t border-border py-3 text-small text-red">
              {problem}
            </p>
          )}
          {!groups && !problem && (
            <p role="status" className="m-0 flex items-center gap-2 border-t border-border py-3 text-small text-text-3">
              <LoaderCircle size={14} aria-hidden className="tf-spin" />
              Looking for pages saved twice…
            </p>
          )}
          {groups?.length === 0 && (
            <p role="status" className="m-0 border-t border-border py-3 text-text-2">
              No page is saved twice. Nothing to remove.
            </p>
          )}
          {groups?.map((group) => (
            <div key={group.url} className="flex h-9 items-center gap-2.5 border-t border-border">
              <Favicon url={group.url} size={16} />
              <span dir="auto" className="min-w-0 flex-1 truncate" title={group.url}>
                {group.title || group.url}
              </span>
              <span className="shrink-0 text-small text-text-3 tabular-nums">{count(group.tabRecordIds.length, 'copy', 'copies')}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-[34px] items-center rounded-control border border-border-strong bg-surface px-3.5 text-text hover:bg-hover"
          >
            {groups?.length === 0 ? 'Close' : 'Cancel'}
          </button>
          {extra > 0 && (
            <button
              type="button"
              data-autofocus
              disabled={busy}
              onClick={() => void remove()}
              className="inline-flex h-[34px] items-center gap-1.5 rounded-control bg-accent px-3.5 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
            >
              {busy && <LoaderCircle size={14} aria-hidden className="tf-spin" />}
              Remove {count(extra, 'copy', 'copies')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
