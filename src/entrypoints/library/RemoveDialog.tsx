import { useEffect, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { Bookmark, Check, CircleAlert, Download, Layers, LoaderCircle, Sparkles, Trash2, X, type LucideIcon } from 'lucide-react';
import { saveListToBookmarks } from '@/lib/bookmarks';
import { send } from '@/lib/messages';
import { Modal } from '@/ui/components/Modal';
import { cx } from '@/ui/cx';
import { proErrorText } from '@/ui/pro';
import { errorText, exportAll } from './actions';
import { count } from './format';

type Step = 'reopen' | 'bookmarks' | 'download';
type StepState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; text: string } | { kind: 'failed'; text: string };

const SECONDARY_32 =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3.5 text-small font-semibold text-text hover:bg-hover disabled:cursor-default disabled:opacity-60';

function Option({
  icon: Icon,
  title,
  description,
  label,
  state,
  onRun,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  label: string;
  state: StepState;
  onRun: () => void;
}) {
  return (
    <div className="flex items-center gap-3.5 rounded-card border border-border bg-surface py-3.5 pr-3.5 pl-4">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-control bg-bg-subtle text-text-2">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="text-small text-text-3">{description}</div>
        {state.kind === 'failed' && (
          <div role="alert" className="mt-1 flex items-start gap-1.5 text-small text-red">
            <CircleAlert size={13} strokeWidth={1.75} aria-hidden className="mt-[2px] shrink-0" />
            {state.text}
          </div>
        )}
      </div>
      <div className="shrink-0">
        {state.kind === 'done' ? (
          <span role="status" className="inline-flex items-center gap-1.5 text-small font-semibold text-green">
            <Check size={14} strokeWidth={2.2} aria-hidden />
            {state.text}
          </span>
        ) : (
          <button type="button" disabled={state.kind === 'busy'} onClick={onRun} className={SECONDARY_32}>
            {state.kind === 'busy' && <LoaderCircle size={14} aria-hidden className="tf-spin" />}
            {label}
          </button>
        )}
      </div>
    </div>
  );
}

function bookmarksFolderName(now = Date.now()): string {
  return `Tabfold · ${new Date(now).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/**
 * Settings › Remove Tabfold… (Min-Remove): before removing Tabfold, take the folded tabs along:
 * reopen them, save them to Chrome bookmarks (which stay), or download a file. Each works on its
 * own; "Remove Tabfold" asks Chrome to uninstall it, and Chrome confirms.
 */
export function RemoveDialog({ open, onClose, foldedCount, pro }: { open: boolean; onClose: () => void; foldedCount: number; pro: boolean }) {
  const [steps, setSteps] = useState<Record<Step, StepState>>({ reopen: { kind: 'idle' }, bookmarks: { kind: 'idle' }, download: { kind: 'idle' } });
  const [removeProblem, setRemoveProblem] = useState<string | null>(null);
  const set = (step: Step, state: StepState) => setSteps((s) => ({ ...s, [step]: state }));

  useEffect(() => {
    if (!open) return;
    setSteps({ reopen: { kind: 'idle' }, bookmarks: { kind: 'idle' }, download: { kind: 'idle' } });
    setRemoveProblem(null);
  }, [open]);

  const reopen = async () => {
    set('reopen', { kind: 'busy' });
    try {
      const { opened, failed } = await send({ type: 'reopen-everything' });
      set('reopen', { kind: 'done', text: failed > 0 ? `Reopened ${opened} of ${opened + failed}` : `Reopened ${count(opened, 'tab')}` });
    } catch (error) {
      set('reopen', { kind: 'failed', text: proErrorText(error) });
    }
  };

  const bookmarks = async () => {
    // Chrome only shows its permission prompt from a click, so ask before anything else awaits.
    let granted = false;
    try {
      granted = await browser.permissions.request({ permissions: ['bookmarks'] });
    } catch {
      granted = false;
    }
    if (!granted) {
      set('bookmarks', { kind: 'failed', text: 'Chrome didn’t allow Tabfold to add bookmarks.' });
      return;
    }
    set('bookmarks', { kind: 'busy' });
    try {
      const { saved } = await saveListToBookmarks();
      set('bookmarks', { kind: 'done', text: `Saved ${count(saved, 'tab')}` });
    } catch (error) {
      set('bookmarks', { kind: 'failed', text: errorText(error) });
    }
  };

  const download = async () => {
    set('download', { kind: 'busy' });
    const exported = await exportAll('html');
    set('download', exported > 0 ? { kind: 'done', text: 'Downloaded' } : { kind: 'idle' });
  };

  const remove = async () => {
    setRemoveProblem(null);
    try {
      await browser.management.uninstallSelf({ showConfirmDialog: true });
    } catch (error) {
      // Cancelled in Chrome's own confirm: nothing to say.
      const message = error instanceof Error ? error.message : '';
      if (message && !/cancel/i.test(message)) setRemoveProblem(message);
    }
  };

  const n = foldedCount.toLocaleString();
  return (
    <Modal open={open} onClose={onClose} labelledBy="rm-h" width={600}>
      <div className="flex max-h-[min(760px,calc(100vh-32px))] flex-col">
        <header className="flex items-start gap-3 pt-[22px] pr-5 pb-1.5 pl-6">
          <div className="min-w-0 flex-1">
            <h1 id="rm-h" className="m-0 text-page font-semibold">
              Before you remove Tabfold
            </h1>
            <p className="mt-1.5 mb-0 text-text-2">
              Removing Tabfold deletes everything it keeps on this computer.{' '}
              {foldedCount > 0 ? `Take your ${count(foldedCount, 'folded tab')} with you first:` : 'There are no folded tabs to take with you.'}
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
        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-6 py-4">
          {foldedCount > 0 && (
            <>
              <Option
                icon={Layers}
                title="Reopen them as tabs"
                description={`Opens all ${n} in their windows, asleep until you click them.`}
                label="Reopen all"
                state={steps.reopen}
                onRun={() => void reopen()}
              />
              <Option
                icon={Bookmark}
                title="Save them to Chrome bookmarks"
                description={`A “${bookmarksFolderName()}” folder, sorted by kind of site. Chrome asks to let Tabfold add bookmarks.`}
                label="Save to bookmarks"
                state={steps.bookmarks}
                onRun={() => void bookmarks()}
              />
              <Option
                icon={Download}
                title="Download a file"
                description="A web page with every link that any browser opens. OneTab and others can import it."
                label="Download"
                state={steps.download}
                onRun={() => void download()}
              />
            </>
          )}
          {pro && (
            <div className="flex items-start gap-2 rounded-control bg-accent-soft px-3 py-2.5 text-small text-text-2">
              <Sparkles size={14} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-accent-text" />
              <span>Your backups stay in your Tabfold account for 30 days. Install Tabfold again and sign in to bring them back.</span>
            </div>
          )}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-6 pt-4 pb-5">
          <span className={cx('min-w-0 flex-1 text-small', removeProblem ? 'text-red' : 'text-text-3')} role={removeProblem ? 'alert' : undefined}>
            {removeProblem ?? 'Chrome asks you to confirm.'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 shrink-0 items-center rounded-control border border-border-strong bg-surface px-3.5 text-text hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-control bg-red-solid px-4 font-semibold text-white hover:brightness-95"
          >
            <Trash2 size={16} strokeWidth={1.75} aria-hidden />
            Remove Tabfold
          </button>
        </footer>
      </div>
    </Modal>
  );
}
