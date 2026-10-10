import { browser } from 'wxt/browser';
import { Check, CircleAlert, CloudOff, RefreshCw } from 'lucide-react';
import { send } from '@/lib/messages';
import type { SyncStatus } from '@/lib/state';
import { cx } from '@/ui/cx';

/** Chrome's sync settings (pages can't link to chrome:// directly, so it opens through the tabs API). */
function openChromeSync(): void {
  void browser.tabs.create({ url: 'chrome://settings/syncSetup' }).catch(() => undefined);
}

/**
 * The quiet sync line (Min-States "Sync line"): "Synced with Chrome", "Syncing with Chrome…",
 * "Latest 500 synced · 120 older stay on this computer", or "Chrome sync is off · How to turn it on".
 * Nothing while sync is turned off in Settings or before the first sync.
 */
export function SyncLine({
  status,
  enabled,
  compact = false,
  className,
  onSyncAll,
}: {
  status: SyncStatus | undefined;
  enabled: boolean;
  /** In the top bar: below 1180px wide the "older stay on this computer" part moves into the tooltip. */
  compact?: boolean;
  className?: string;
  /**
   * Free with more folded tabs than Chrome sync holds: the line ends with "Sync all" (top bar) or
   * "Sync all with Pro" (Settings), which opens the plans page (Pro-States "Sync is full").
   */
  onSyncAll?: () => void;
}) {
  if (!enabled || !status) return null;
  const base = cx('inline-flex min-w-0 items-center gap-1.5 text-small whitespace-nowrap text-text-3', className);
  switch (status.state) {
    case 'syncing':
      return (
        <span role="status" className={base}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden className="tf-spin shrink-0" />
          <span className="truncate">Syncing with Chrome…</span>
        </span>
      );
    case 'off':
      return (
        <span role="status" className={base}>
          <CloudOff size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="truncate">Chrome sync is off</span>
          <span aria-hidden>·</span>
          <button type="button" onClick={openChromeSync} className="shrink-0 font-semibold text-accent-text hover:underline">
            How to turn it on
          </button>
        </span>
      );
    case 'error':
      return (
        <span role="status" className={base} title={status.error}>
          <CircleAlert size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-amber" />
          <span className="truncate">Couldn’t sync with Chrome</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => void send({ type: 'sync-now' }).catch(() => undefined)}
            className="shrink-0 font-semibold text-accent-text hover:underline"
          >
            Try again
          </button>
        </span>
      );
    default:
      return (
        <span role="status" className={cx(base, onSyncAll && !compact && status.localOnly > 0 && 'flex-wrap whitespace-normal')}>
          <Check size={14} strokeWidth={2.2} aria-hidden className="shrink-0 text-green" />
          {status.localOnly > 0 ? (
            onSyncAll ? (
              <>
                <span
                  className="truncate"
                  title={`Latest ${status.syncedTabs.toLocaleString()} synced · ${status.localOnly.toLocaleString()} older stay on this computer`}
                >
                  Latest {status.syncedTabs.toLocaleString()} synced
                </span>
                {!compact && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{status.localOnly.toLocaleString()} older stay on this computer</span>
                  </>
                )}
                <span aria-hidden>·</span>
                <a
                  href="#/pro"
                  onClick={(e) => {
                    e.preventDefault();
                    onSyncAll();
                  }}
                  className="shrink-0 font-semibold text-accent-text no-underline hover:underline"
                >
                  {compact ? 'Sync all' : 'Sync all with Pro'}
                </a>
              </>
            ) : (
              <span className="truncate" title={`Latest ${status.syncedTabs.toLocaleString()} synced · ${status.localOnly.toLocaleString()} older stay on this computer`}>
                Latest {status.syncedTabs.toLocaleString()} synced
                <span className={compact ? 'max-[1180px]:hidden' : undefined}> · {status.localOnly.toLocaleString()} older stay on this computer</span>
              </span>
            )
          ) : (
            <span className="truncate">Synced with Chrome</span>
          )}
        </span>
      );
  }
}

/**
 * Sync with the Tabfold account (Pro, Pro-List-Projects top bar and Settings): "Synced with Tabfold ·
 * 1,240 tabs", "Syncing with Tabfold…", or what went wrong with "Try again". Nothing before the
 * first sync.
 */
export function CloudSyncLine({ status, className, withCount = true }: { status: SyncStatus | undefined; className?: string; withCount?: boolean }) {
  if (!status) return null;
  const base = cx('inline-flex min-w-0 items-center gap-1.5 text-small whitespace-nowrap text-text-3', className);
  switch (status.state) {
    case 'syncing':
      return (
        <span role="status" className={base}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden className="tf-spin shrink-0" />
          <span className="truncate">Syncing with Tabfold…</span>
        </span>
      );
    case 'off':
      return (
        <span role="status" className={base}>
          <CloudOff size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="truncate">Not synced with Tabfold yet</span>
        </span>
      );
    case 'error':
      return (
        <span role="status" className={base} title={status.error}>
          <CircleAlert size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-amber" />
          <span className="truncate">Couldn’t sync with Tabfold</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => void send({ type: 'cloud-sync-now' }).catch(() => undefined)}
            className="shrink-0 font-semibold text-accent-text hover:underline"
          >
            Try again
          </button>
        </span>
      );
    default:
      return (
        <span role="status" className={base}>
          <Check size={14} strokeWidth={2.2} aria-hidden className="shrink-0 text-green" />
          <span className="truncate">
            Synced with Tabfold{withCount && status.syncedTabs > 0 ? ` · ${status.syncedTabs.toLocaleString()} ${status.syncedTabs === 1 ? 'tab' : 'tabs'}` : ''}
          </span>
        </span>
      );
  }
}
