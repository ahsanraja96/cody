import { useState, type ReactNode } from 'react';
import { Check, Info, Layers, RefreshCw, RotateCcw, X } from 'lucide-react';
import { send } from '@/lib/messages';
import { openLibrary } from '@/lib/openLibrary';
import type { RecoveryOffer, SyncStatus } from '@/lib/state';
import { cx } from '@/ui/cx';
import { currentScreen } from '@/ui/hooks';

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border-strong bg-surface px-[5px] text-meta text-text-2">
      {children}
    </kbd>
  );
}

export function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex h-9 items-center gap-1.5 px-2">
      <h2 className="text-meta font-semibold tracking-[.04em] text-text-3 uppercase">{children}</h2>
      {count !== undefined && <span className="text-meta text-text-3 tabular-nums">· {count.toLocaleString()}</span>}
    </div>
  );
}

/** "Chrome closed unexpectedly. Reopen your 52 tabs?" (Min-States, top of the popup). */
export function CrashLine({ offer, windowId }: { offer: RecoveryOffer; windowId?: number }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex-none px-4 pb-3">
      <div role="alert" className="flex items-center gap-2.5 rounded-card border border-border bg-bg-subtle py-2 pr-1.5 pl-3">
        <RotateCcw size={16} strokeWidth={1.75} aria-hidden className="flex-none text-text-2" />
        <span className="min-w-0 flex-1">
          Chrome closed unexpectedly. Reopen your {offer.tabCount.toLocaleString()} {offer.tabCount === 1 ? 'tab' : 'tabs'}?
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            send({
              type: 'restore-snapshot',
              snapshotId: offer.snapshotId,
              mode: 'original',
              currentWindowId: windowId,
              screen: currentScreen(),
            })
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
          className="inline-flex h-7 flex-none items-center rounded-control bg-accent px-3 text-small font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
        >
          Reopen
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => send({ type: 'dismiss-recovery' }).catch(() => undefined)}
          className="flex size-7 flex-none items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** One quiet line about Chrome sync; nothing when it is off or before the first sync. */
export function SyncLine({ status }: { status: SyncStatus | undefined }) {
  if (!status || status.state === 'off' || status.state === 'error') return null;
  const base = 'inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-small text-text-3';
  const check = <Check size={14} strokeWidth={2.2} aria-hidden className="flex-none text-green" />;
  if (status.state === 'syncing') {
    return (
      <span role="status" className={base}>
        <RefreshCw size={14} strokeWidth={1.75} aria-hidden className="flex-none animate-spin [animation-duration:1.2s]" />
        Syncing with Chrome…
      </span>
    );
  }
  if (status.localOnly > 0) {
    const tip = `${status.localOnly.toLocaleString()} older folded tabs stay on this computer`;
    return (
      <span role="status" className={base}>
        {check}
        Latest {status.syncedTabs.toLocaleString()} synced
        <span title={tip} aria-label={tip} role="img" tabIndex={0} className="inline-flex rounded-full">
          <Info size={14} strokeWidth={1.75} aria-hidden className="flex-none" />
        </span>
      </span>
    );
  }
  return (
    <span role="status" className={base}>
      {check}
      Synced with Chrome
    </span>
  );
}

export function PopupFooter({ sync, className }: { sync: SyncStatus | undefined; className?: string }) {
  return (
    <footer
      className={cx(
        'flex h-11 flex-none items-center justify-between gap-3 border-t border-border bg-bg-subtle px-4',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => {
          void openLibrary().finally(() => window.close());
        }}
        className="inline-flex flex-none items-center gap-1.5 rounded-control font-semibold text-accent-text hover:underline"
      >
        <Layers size={16} strokeWidth={1.75} aria-hidden />
        Open full list
      </button>
      <SyncLine status={sync} />
    </footer>
  );
}
