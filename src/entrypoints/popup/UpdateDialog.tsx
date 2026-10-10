import { useEffect, useRef } from 'react';
import { browser } from 'wxt/browser';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/ui/components/Button';

/** Chrome downloaded a new version: dim the popup and ask to reload so the new one runs. */
export function UpdateDialog({ version }: { version: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="update-title"
      aria-describedby="update-desc"
      // Reloading is the only way on: the old popup code may not match the new worker.
      onCancel={(e) => e.preventDefault()}
      className="m-auto w-[calc(100%-48px)] max-w-[304px] rounded-card border border-border bg-surface p-0 text-text shadow-pop"
    >
      <div className="flex flex-col items-center gap-2 px-5 pt-6 pb-5 text-center">
        <span aria-hidden className="mb-1 inline-flex size-10 items-center justify-center rounded-card bg-accent-soft text-accent-text">
          <RefreshCw size={20} />
        </span>
        <h2 id="update-title" className="text-section font-semibold">
          Tabfold was updated
        </h2>
        <p id="update-desc" className="text-text-2">
          Reload to use version {version}.
          <br />
          Everything you saved is still here.
        </p>
        <Button variant="primary" className="mt-2 w-full" autoFocus onClick={() => browser.runtime.reload()}>
          Reload
        </Button>
      </div>
    </dialog>
  );
}
