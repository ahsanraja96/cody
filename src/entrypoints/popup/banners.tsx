import { useId, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Eye,
  HatGlasses,
  MemoryStick,
  Pause,
  Pin,
  RotateCcw,
  Shield,
  Volume2,
  X,
} from 'lucide-react';
import { formatBytes, plural } from '@/lib/format';
import type { KeptAwakeReason, RestoreFailure, SuspendOutcome, TabRef } from '@/lib/messages';
import { openLibrary } from '@/lib/openLibrary';
import type { RecoveryOffer } from '@/lib/state';
import { displayHost } from '@/lib/urls';
import { Banner } from '@/ui/components/Banner';
import { Button, IconButton } from '@/ui/components/Button';
import { Favicon } from '@/ui/components/Favicon';
import { cx } from '@/ui/cx';

const NARROW_HIDE = 'max-[360px]:hidden';

/** "47 tabs open · ~2.1 GB in use" (or, with a selection, what saving it frees). Wraps when narrow. */
export function MemoryBanner({ lead, detail, aside }: { lead: string; detail: string; aside: string }) {
  return (
    <div
      role="status"
      className="grid shrink-0 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-card border border-border bg-bg-subtle px-3 py-[9px] max-[360px]:items-start max-[360px]:py-1.5"
    >
      <MemoryStick size={16} aria-hidden className="text-text-2 max-[360px]:row-span-2 max-[360px]:mt-0.5" />
      <p className="truncate">
        <span className="font-semibold">{lead}</span>
        <span className={cx('text-text-2', NARROW_HIDE)}> {detail}</span>
      </p>
      <span className="text-meta text-text-3 max-[360px]:self-center">{aside}</span>
      <span className="col-span-2 col-start-2 hidden truncate text-small text-text-2 max-[360px]:block">
        {detail.replace(/^· /, '')}
      </span>
    </div>
  );
}

/** Green "Freed ~1.8 GB · 45 tabs saved" with Undo and the seconds left. */
export function SavedBanner({
  lead,
  detail,
  note,
  secondsLeft,
  onUndo,
  undoing,
}: {
  lead: string;
  detail: string;
  note?: string;
  secondsLeft: number | null;
  onUndo: () => void;
  undoing: boolean;
}) {
  return (
    <div
      role="status"
      className="flex min-h-10 shrink-0 items-center gap-2.5 rounded-card border border-green-line bg-green-soft py-[5px] pr-1.5 pl-3 text-green"
    >
      <Check size={16} aria-hidden className="shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{lead}</span>
        <span> · {detail}</span>
        {note && <span className="block text-meta">{note}</span>}
      </p>
      {secondsLeft !== null && (
        <button
          type="button"
          disabled={undoing}
          onClick={onUndo}
          aria-label={`Undo, ${secondsLeft} seconds left`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-semibold text-green hover:bg-green-line/40 disabled:opacity-60"
        >
          <RotateCcw size={14} aria-hidden />
          Undo <span className="font-normal">{secondsLeft}s</span>
        </button>
      )}
    </div>
  );
}

const KEPT_AWAKE: Record<KeptAwakeReason, { label: string; icon: ReactNode }> = {
  audible: { label: 'Playing audio', icon: <Volume2 size={14} aria-hidden /> },
  protectedSite: { label: 'Protected site', icon: <Shield size={14} aria-hidden /> },
  active: { label: 'Active tab', icon: <Eye size={14} aria-hidden /> },
  pinned: { label: 'Pinned', icon: <Pin size={14} aria-hidden /> },
  failed: { label: "Chrome kept it loaded", icon: <CircleAlert size={14} aria-hidden /> },
};

const REASON_ORDER: KeptAwakeReason[] = ['audible', 'protectedSite', 'active', 'pinned', 'failed'];

/** Green "Suspended 14 tabs · freed ~670 MB" with the tabs that stayed awake, one row per reason. */
export function SuspendedBanner({ outcome }: { outcome: SuspendOutcome }) {
  const listId = useId();
  const kept = outcome.keptAwake;
  const [open, setOpen] = useState(kept.length > 0 && kept.length <= 6);
  const groups = REASON_ORDER.map((reason) => ({ reason, tabs: kept.filter((t) => t.reason === reason) })).filter(
    (g) => g.tabs.length > 0,
  );
  const none = outcome.suspended === 0;
  return (
    <div
      className={cx(
        'shrink-0 overflow-hidden rounded-card border',
        none ? 'border-border bg-bg-subtle' : 'border-green-line bg-green-soft',
      )}
    >
      <div role="status" className={cx('flex min-h-[38px] items-center gap-2.5 px-3 py-1.5', none ? 'text-text' : 'text-green')}>
        <Pause size={16} aria-hidden className="shrink-0" />
        <p className="min-w-0 flex-1">
          {none ? (
            <span className="font-semibold">No inactive tabs to suspend</span>
          ) : (
            <>
              <span className="font-semibold">Suspended {plural(outcome.suspended, 'tab')}</span>
              <span> · freed ~{formatBytes(outcome.freedBytes)}</span>
            </>
          )}
        </p>
      </div>
      {kept.length > 0 && (
        <div className={cx('border-t bg-surface', none ? 'border-border' : 'border-green-line')}>
          <div className="flex min-h-8 flex-wrap items-center gap-x-2 pr-3 pl-1.5">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((o) => !o)}
              className="inline-flex h-6 items-center gap-1.5 rounded-md pr-1.5 pl-1 text-small font-semibold hover:bg-hover"
            >
              {open ? (
                <ChevronDown size={14} strokeWidth={2} aria-hidden className="text-text-3" />
              ) : (
                <ChevronRight size={14} strokeWidth={2} aria-hidden className="text-text-3" />
              )}
              {plural(kept.length, 'tab')} kept awake
            </button>
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Change what's protected, opens Settings, Memory"
              className="text-small font-semibold text-accent-text hover:underline"
              onClick={() => {
                openLibrary('#/settings/memory');
                window.close();
              }}
            >
              Change what's protected
            </button>
          </div>
          {open && (
            <ul id={listId} className="pr-3 pb-1.5 pl-[30px] text-small">
              {groups.map(({ reason, tabs }) => (
                <li key={reason} className="flex h-7 items-center gap-2">
                  <span className="shrink-0 text-text-3">{KEPT_AWAKE[reason].icon}</span>
                  <span className="min-w-0 truncate">
                    <span className="font-semibold">{KEPT_AWAKE[reason].label}</span>
                    <span className="text-text-2"> · {tabs.map((t) => displayHost(t.url) || t.title).join(', ')}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Amber "2 tabs are still open": pages that refused to close (a "Leave site?" prompt). */
export function RefusedCard({ tabs, onDismiss }: { tabs: TabRef[]; onDismiss: () => void }) {
  const showTab = async (tab: TabRef) => {
    try {
      await browser.tabs.update(tab.tabId, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
    } catch {
      // The tab closed in the meantime.
    }
  };
  return (
    <div role="alert" className="shrink-0 overflow-hidden rounded-card border border-amber-line bg-amber-soft">
      <div className="flex items-start gap-2.5 py-2.5 pr-1.5 pl-3">
        <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-amber">
            {tabs.length === 1 ? '1 tab is still open' : `${tabs.length} tabs are still open`}
          </div>
          <div className="text-small text-text-2">
            {tabs.length === 1
              ? 'This page asked “Leave site?”, so Chrome kept it open. It’s saved.'
              : 'These pages asked “Leave site?”, so Chrome kept them open. They’re saved.'}
          </div>
        </div>
        <IconButton label="Dismiss" size="sm" onClick={onDismiss}>
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      <ul className="max-h-[108px] overflow-y-auto border-t border-amber-line bg-surface">
        {tabs.map((tab) => (
          <li key={tab.tabId} className="flex h-9 items-center gap-2.5 border-t border-border pr-1 pl-3 first:border-t-0">
            <Favicon url={tab.url} />
            <span dir="auto" className="min-w-0 flex-1 truncate">
              {tab.title || displayHost(tab.url)}
            </span>
            <span className="shrink-0 text-meta text-text-3 max-[360px]:hidden">{displayHost(tab.url)}</span>
            <Button size="xs" onClick={() => showTab(tab)} aria-label={`Show tab: ${tab.title || displayHost(tab.url)}`}>
              Show tab
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Red error with an optional "Try again". */
export function ErrorBanner({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex shrink-0 items-center gap-2.5 rounded-card border border-red-line bg-red-soft py-2 pr-2 pl-3">
      <CircleAlert size={16} aria-hidden className="shrink-0 self-start text-red mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-red">{title}</div>
        {detail && <div className="text-small text-text-2">{detail}</div>}
      </div>
      {onRetry && (
        <Button size="xs" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Amber "Restored 21 of 24 tabs" with the pages Chrome won't let extensions open. */
export function RestoreFailedCard({
  opened,
  failed,
  onDismiss,
}: {
  opened: number;
  failed: RestoreFailure[];
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const fileAccess = failed.some((f) => f.reason === 'file-access');
  return (
    <div role="alert" className="shrink-0 overflow-hidden rounded-card border border-amber-line bg-amber-soft">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-amber">
            Restored {opened} of {opened + failed.length} tabs
          </div>
          <div className="text-small text-text-2">
            {fileAccess
              ? 'Local files need “Allow access to file URLs” for Tabfold in Chrome’s extension settings. Copy the links to open them yourself.'
              : 'Chrome won’t let extensions reopen these pages. Copy the links and paste them into the address bar.'}
          </div>
        </div>
      </div>
      <ul className="max-h-[90px] overflow-y-auto border-t border-amber-line bg-surface py-1">
        {failed.map((f, i) => (
          <li key={`${f.url}-${i}`} className="flex h-7 items-center gap-2.5 px-3">
            <Favicon url={f.url} />
            <span className="min-w-0 truncate font-mono text-small">{f.url}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 border-t border-amber-line bg-surface px-3 py-2">
        <Button
          size="xs"
          icon={copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(failed.map((f) => f.url).join('\n'));
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Links copied' : 'Copy links'}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export function IncognitoBanner() {
  return (
    <div role="status" className="flex shrink-0 items-start gap-2.5 rounded-card border border-accent-line bg-accent-soft px-3 py-2.5">
      <HatGlasses size={16} aria-hidden className="mt-0.5 shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">This is an Incognito window</div>
        <div className="text-small text-pretty text-text-2">
          Its tabs are never saved on their own, never in snapshots and never synced.
        </div>
      </div>
    </div>
  );
}

function closedAt(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return `at ${time}`;
  return `on ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

/** After a crash or restart: "Restore your last session?" (shown once at the top). */
export function RecoveryBanner({
  offer,
  busy,
  onRestore,
  onReview,
  onDismiss,
}: {
  offer: RecoveryOffer;
  busy: boolean;
  onRestore: () => void;
  onReview: () => void;
  onDismiss: () => void;
}) {
  return (
    <Banner
      tone="accent"
      role="alert"
      icon={<RotateCcw size={16} aria-hidden />}
      className="shrink-0"
      title="Restore your last session?"
      actions={
        <>
          <Button size="xs" variant="primary" disabled={busy} onClick={onRestore}>
            Restore windows
          </Button>
          <Button size="xs" onClick={onReview}>
            Review first
          </Button>
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            Not now
          </Button>
        </>
      }
    >
      <span className="text-text">
        Chrome closed unexpectedly {closedAt(offer.createdAt)}. We kept a snapshot of {plural(offer.windowCount, 'window')} and{' '}
        {plural(offer.tabCount, 'tab')}.
      </span>
    </Banner>
  );
}
