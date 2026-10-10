import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { AppWindow, Archive, ChevronDown, ChevronRight, History, Trash2 } from 'lucide-react';
import { db } from '@/lib/db';
import { formatDateTime, plural } from '@/lib/format';
import { send } from '@/lib/messages';
import { listSnapshots } from '@/lib/repo';
import type { CapturedWindow, SnapshotReason, SnapshotRecord } from '@/lib/types';
import { displayHost } from '@/lib/urls';
import { Button, IconButton } from '@/ui/components/Button';
import { ProLock } from '@/ui/components/Chips';
import { Favicon } from '@/ui/components/Favicon';
import { showProInfo } from '@/ui/components/ProDialog';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { currentScreen, useRecoveryOffer, useSettings } from '@/ui/hooks';

const REASONS: Record<SnapshotReason, { label: string; detail: string }> = {
  timer: { label: 'Automatic', detail: 'copied automatically and replaced every few minutes' },
  'before-bulk-close': { label: 'Before Save all', detail: 'taken just before Save all closed your tabs' },
  shutdown: { label: 'Browser closed', detail: 'what was open when the browser closed' },
  'before-restore': { label: 'Before restore', detail: 'taken just before a restore opened new tabs' },
  'before-import': { label: 'Before import', detail: 'taken just before an import' },
  manual: { label: 'Taken by you', detail: 'taken with “Take snapshot now”' },
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** List times: "2 min ago" for the rolling copy, otherwise "14:32", "Yesterday 18:04", "Oct 8". */
function listTime(snap: SnapshotRecord, now: number): string {
  const diff = now - snap.createdAt;
  if (snap.reason === 'timer') {
    if (diff < MINUTE) return 'Just now';
    if (diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)} min ago`;
    if (diff < DAY) return `${Math.floor(diff / (60 * MINUTE))}h ago`;
  }
  const date = new Date(snap.createdAt);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  if (date.toDateString() === new Date(now - DAY).toDateString()) return `Yesterday ${time}`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function Strip({ windows, max, size = 16 }: { windows: CapturedWindow[]; max: number; size?: number }) {
  const tabs = windows.flatMap((w) => w.tabs).slice(0, max);
  return (
    <span aria-hidden className="flex items-center gap-1">
      {tabs.map((t, i) => (
        <Favicon key={`${t.url}-${i}`} url={t.url} size={size} />
      ))}
    </span>
  );
}

/**
 * Snapshots (Library-Snapshots): the rolling automatic copy, the browser-close one and safety
 * copies, with a preview of the selected snapshot's windows.
 */
export function SnapshotsView() {
  // Newest first, including the rolling automatic ("timer") snapshot.
  const snapshots = useLiveQuery(() => listSnapshots(), []);
  const offer = useRecoveryOffer();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [taking, setTaking] = useState(false);
  const now = Date.now();

  const selected = snapshots?.find((s) => s.id === selectedId) ?? snapshots?.find((s) => s.id === offer?.snapshotId) ?? snapshots?.[0];

  const take = async () => {
    setTaking(true);
    try {
      const { snapshotId } = await send({ type: 'take-snapshot' });
      if (snapshotId) {
        setSelectedId(snapshotId);
        toast('Snapshot taken.');
      } else {
        toast('Nothing open to snapshot.');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not take a snapshot.', { tone: 'error' });
    } finally {
      setTaking(false);
    }
  };

  const remove = async (snap: SnapshotRecord) => {
    if (snap.id === undefined) return;
    const index = snapshots?.findIndex((s) => s.id === snap.id) ?? -1;
    const next = snapshots?.[index + 1] ?? snapshots?.[index - 1];
    await db.snapshots.delete(snap.id);
    if (offer?.snapshotId === snap.id) await send({ type: 'dismiss-recovery' }).catch(() => undefined);
    setSelectedId(next?.id ?? null);
    toast(`Deleted “${REASONS[snap.reason].label}”.`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          await db.snapshots.put(snap);
          setSelectedId(snap.id ?? null);
        },
      },
    });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (!snapshots?.length || !selected) return;
    const index = snapshots.indexOf(selected);
    const next = e.key === 'ArrowDown' ? index + 1 : e.key === 'ArrowUp' ? index - 1 : -1;
    if (next < 0 || next >= snapshots.length) return;
    e.preventDefault();
    setSelectedId(snapshots[next]!.id ?? null);
    (e.currentTarget.querySelectorAll<HTMLElement>('[role=option]')[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <section aria-label="Snapshots" className="flex h-full flex-col bg-bg-subtle px-6 pt-5 pb-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[240px] flex-1">
          <h1 className="text-page font-semibold">Snapshots</h1>
          <p className="mt-1 text-text-2">
            Tabfold copies your open windows every few minutes, when the browser closes, and before every Save all, restore or import.
          </p>
        </div>
        <Button icon={<History size={16} aria-hidden />} onClick={() => void take()} disabled={taking}>
          Take snapshot now
        </Button>
      </div>

      <div className="mt-5 flex min-h-0 flex-1 gap-6">
        <div className="flex w-[360px] shrink-0 flex-col gap-3">
          {snapshots?.length === 0 ? (
            <p className="rounded-card border border-dashed border-border-strong px-4 py-8 text-center text-text-2">
              No snapshots yet. Tabfold copies your open windows every few minutes, so the first one appears shortly.
            </p>
          ) : (
            <div
              role="listbox"
              aria-label="Snapshots"
              onKeyDown={onListKey}
              className="scroll-thin min-h-0 overflow-y-auto rounded-card border border-border bg-surface"
            >
              {snapshots?.map((snap, i) => {
                const active = snap.id === selected?.id;
                const reason = REASONS[snap.reason];
                return (
                  <button
                    key={snap.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => setSelectedId(snap.id ?? null)}
                    className={cx(
                      'flex w-full flex-col items-stretch gap-1.5 px-3.5 py-3 text-left transition-colors duration-150 focus-visible:-outline-offset-2',
                      i < snapshots.length - 1 && 'border-b border-border',
                      active ? 'bg-accent-soft' : 'hover:bg-hover',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cx('truncate font-semibold', active ? 'text-accent-text' : 'text-text')}>{reason.label}</span>
                      {offer?.snapshotId === snap.id && (
                        <span className="inline-flex h-[18px] shrink-0 items-center rounded bg-amber-soft px-1.5 text-meta font-semibold whitespace-nowrap text-amber">
                          Not restored yet
                        </span>
                      )}
                      <span className="flex-1" />
                      <span className="shrink-0 text-small whitespace-nowrap text-text-2">{listTime(snap, now)}</span>
                    </span>
                    <span className="truncate text-meta text-text-3">
                      {plural(snap.tabCount, 'tab')} · {plural(snap.windowCount, 'window')}
                      {snap.reason === 'timer' ? ' · replaced every few minutes' : ''}
                    </span>
                    <Strip windows={snap.windows} max={8} />
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-col gap-2 px-1 py-0.5 text-small text-text-3">
            <p>Free keeps the last browser-close snapshot and up to 5 safety copies for 7 days.</p>
            <button type="button" onClick={() => showProInfo('More snapshots')} className="flex items-center gap-2 text-left hover:text-text-2">
              <ProLock />
              Pro keeps the last 20 snapshots.
            </button>
          </div>
        </div>

        {selected ? <SnapshotPreview key={selected.id} snap={selected} onDelete={() => void remove(selected)} /> : <div className="flex-1" />}
      </div>
    </section>
  );
}

function SnapshotPreview({ snap, onDelete }: { snap: SnapshotRecord; onDelete: () => void }) {
  const [settings] = useSettings();
  const [busy, setBusy] = useState<null | 'restore' | 'save'>(null);
  const reason = REASONS[snap.reason];
  const windows = snap.windows.filter((w) => w.tabs.length > 0);

  const restore = async () => {
    if (snap.id === undefined) return;
    setBusy('restore');
    try {
      const current = await browser.windows.getCurrent();
      const outcome = await send({ type: 'restore-snapshot', snapshotId: snap.id, mode: 'original', currentWindowId: current.id, screen: currentScreen() });
      if (outcome.failed.length) {
        toast(`Restored ${outcome.opened} of ${outcome.opened + outcome.failed.length} tabs. Chrome blocked the rest.`, { tone: 'error', duration: 10_000 });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Restore failed.', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const saveAsSession = async () => {
    if (snap.id === undefined) return;
    setBusy('save');
    try {
      const { sessionId } = await send({ type: 'snapshot-to-session', snapshotId: snap.id });
      if (sessionId) {
        toast('Saved as a session.', {
          action: { label: 'Show it', onClick: () => (location.hash = `#/all?session=${encodeURIComponent(sessionId)}`) },
        });
      } else {
        toast('Nothing to save from this snapshot.');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save the snapshot.', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label={`Snapshot preview: ${reason.label}`} className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-bg">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-page font-semibold">{reason.label}</h2>
            <p className="mt-0.5 text-text-2">
              {formatDateTime(snap.createdAt)} · {plural(snap.tabCount, 'tab')} in {plural(snap.windowCount, 'window')} · {reason.detail}
            </p>
          </div>
          <IconButton label="Delete snapshot" size="lg" onClick={onDelete}>
            <Trash2 size={18} aria-hidden />
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<AppWindow size={16} aria-hidden />} onClick={() => void restore()} disabled={busy !== null}>
            Restore windows
          </Button>
          <Button icon={<Archive size={16} aria-hidden />} onClick={() => void saveAsSession()} disabled={busy !== null}>
            Save as session
          </Button>
          <span className="ml-2 text-small text-text-3">
            Opens {plural(windows.length, 'window')}.{settings.lazyRestore ? ' Tabs load when you click them.' : ''}
          </span>
        </div>
      </div>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto bg-bg-subtle px-5 py-4">
        {windows.map((w, i) => (
          <WindowSection key={i} window={w} name={w.name.trim() || `Window ${i + 1}`} initiallyOpen={i < 2} />
        ))}
      </div>
    </section>
  );
}

const PREVIEW_TABS = 5;

function WindowSection({ window: w, name, initiallyOpen }: { window: CapturedWindow; name: string; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [open]);
  const shown = all ? w.tabs : w.tabs.slice(0, PREVIEW_TABS);
  const more = w.tabs.length - shown.length;
  return (
    <section aria-label={`${name} window, ${plural(w.tabs.length, 'tab')}`} className="shrink-0 overflow-hidden rounded-card border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx('flex h-9 w-full items-center gap-2 pr-3 pl-2.5 text-left hover:bg-hover', open && 'border-b border-border')}
      >
        {open ? <ChevronDown size={14} aria-hidden className="text-text-3" /> : <ChevronRight size={14} aria-hidden className="text-text-3" />}
        <span dir="auto" className="truncate font-semibold">
          {name}
        </span>
        <span className="shrink-0 text-text-3">· {plural(w.tabs.length, 'tab')}</span>
        <span className="flex-1" />
        {!open && <Strip windows={[w]} max={5} />}
      </button>
      {open && (
        <>
          {shown.map((tab, i) => (
            <div key={`${tab.url}-${i}`} className="flex h-8 items-center gap-2.5 pr-3 pl-[30px]">
              <Favicon url={tab.url} />
              <span dir="auto" className="min-w-0 flex-1 truncate" title={tab.title || tab.url}>
                {tab.title || displayHost(tab.url)}
              </span>
              <span className="shrink-0 text-meta text-text-3">{displayHost(tab.url)}</span>
            </div>
          ))}
          {(more > 0 || all) && w.tabs.length > PREVIEW_TABS && (
            <button
              type="button"
              onClick={() => setAll(!all)}
              className="flex h-[30px] w-full items-center border-t border-border pr-3 pl-14 text-left text-small text-text-2 hover:bg-hover"
            >
              {all ? 'Show less' : `Show ${more} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
