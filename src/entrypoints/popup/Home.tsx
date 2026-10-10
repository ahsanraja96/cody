import { useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { AppWindow, Archive, Copy, Laptop, MemoryStick, Pause, RotateCcw } from 'lucide-react';
import { estimateBytes, formatBytes, plural, timeAgo } from '@/lib/format';
import { send, type RestoreFailure, type SaveOutcome } from '@/lib/messages';
import { openLibrary } from '@/lib/openLibrary';
import { listRecentSessions } from '@/lib/repo';
import { windowNames } from '@/lib/state';
import { Banner } from '@/ui/components/Banner';
import { Button } from '@/ui/components/Button';
import {
  copyText,
  currentScreen,
  modKey,
  useCommandShortcut,
  useLastAction,
  useNow,
  useRecoveryOffer,
  useSettings,
  type OpenWindow,
} from '@/ui/hooks';
import { WindowCard } from './parts';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'audible'; count: number; scope: 'all' | 'window' }
  | { kind: 'error'; message: string }
  | { kind: 'info'; message: string }
  | { kind: 'suspended'; count: number; freedBytes: number; skipped: number }
  | { kind: 'already-open'; sessionId: string; windowId: number }
  | { kind: 'restore-failed'; opened: number; failed: RestoreFailure[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function Home({
  windows,
  loaded,
  currentWindowId,
  onAskKeywords,
}: {
  windows: OpenWindow[];
  loaded: boolean;
  currentWindowId: number | undefined;
  onAskKeywords: (tabIds: number[]) => void;
}) {
  const [settings] = useSettings();
  const action = useLastAction();
  const offer = useRecoveryOffer();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const recent = useLiveQuery(() => listRecentSessions(5), []);
  const saveShortcut = useCommandShortcut('save-all');

  const showUndo = !!action && !action.undone && action.expiresAt > Date.now();
  const now = useNow(showUndo);
  const secondsLeft = action ? Math.max(0, Math.ceil((action.expiresAt - now) / 1000)) : 0;

  const ordered = useMemo(
    () => [...windows].sort((a, b) => Number(b.id === currentWindowId) - Number(a.id === currentWindowId)),
    [windows, currentWindowId],
  );
  const allTabs = windows.flatMap((w) => w.tabs);
  const loadedTabs = allTabs.filter((t) => !t.discarded).length;
  const current = windows.find((w) => w.id === currentWindowId);
  const highlighted = (current?.tabs ?? []).filter((t) => t.highlighted && t.id !== undefined).map((t) => t.id!);
  const selectedIds = selection.size ? [...selection] : highlighted.length > 1 ? highlighted : [];

  const report = (outcome: SaveOutcome) => {
    if (outcome.savedTabs === 0 && outcome.skippedDuplicates === 0) {
      setStatus({ kind: 'info', message: 'Nothing to save: only pinned, blank or Tabfold tabs are open.' });
    } else if (outcome.failedToClose.length) {
      setStatus({
        kind: 'info',
        message: `${plural(outcome.failedToClose.length, 'tab')} stayed open (it may have unsaved changes). Everything is saved.`,
      });
    } else if (outcome.savedTabs === 0 && outcome.skippedDuplicates > 0) {
      setStatus({ kind: 'info', message: 'Already saved in that session.' });
    } else {
      setStatus({ kind: 'idle' });
    }
  };

  const save = async (scope: 'all' | 'window', audible?: 'keep' | 'close') => {
    try {
      if (!audible) {
        const pre = await send({ type: 'preflight-save', scope, windowId: currentWindowId });
        if (pre.audible > 0) {
          setStatus({ kind: 'audible', count: pre.audible, scope });
          return;
        }
      }
      setStatus({ kind: 'busy', label: 'Saving…' });
      report(await send({ type: 'save', scope, close: true, windowId: currentWindowId, audible: audible ?? 'keep' }));
    } catch (error) {
      setStatus({ kind: 'error', message: messageOf(error) });
    }
  };

  const saveTabs = async (tabIds: number[]) => {
    if (settings.askKeywordsOnSingleSave) {
      onAskKeywords(tabIds);
      return;
    }
    try {
      report(await send({ type: 'save', scope: 'tabs', tabIds, close: true, windowId: currentWindowId }));
      setSelection(new Set());
    } catch (error) {
      setStatus({ kind: 'error', message: messageOf(error) });
    }
  };

  const suspendAll = async () => {
    try {
      setStatus({ kind: 'busy', label: 'Suspending…' });
      const outcome = await send({ type: 'suspend-inactive' });
      const skipped = Object.values(outcome.skipped).reduce((a, b) => a + b, 0) - outcome.skipped.already - outcome.skipped.active;
      setStatus({ kind: 'suspended', count: outcome.suspended, freedBytes: outcome.freedBytes, skipped });
    } catch (error) {
      setStatus({ kind: 'error', message: messageOf(error) });
    }
  };

  const restore = async (sessionId: string, force = false) => {
    try {
      setStatus({ kind: 'busy', label: 'Restoring…' });
      const outcome = await send({
        type: 'restore',
        sessionId,
        mode: 'original',
        currentWindowId,
        screen: currentScreen(),
        force,
      });
      if (outcome.alreadyOpenWindowId !== undefined) {
        setStatus({ kind: 'already-open', sessionId, windowId: outcome.alreadyOpenWindowId });
      } else if (outcome.failed.length) {
        setStatus({ kind: 'restore-failed', opened: outcome.opened, failed: outcome.failed });
      } else {
        setStatus({ kind: 'idle' });
      }
    } catch (error) {
      setStatus({ kind: 'error', message: messageOf(error) });
    }
  };

  const restoreRecovery = async () => {
    if (!offer) return;
    try {
      setStatus({ kind: 'busy', label: 'Restoring your last session…' });
      const outcome = await send({
        type: 'restore-snapshot',
        snapshotId: offer.snapshotId,
        mode: 'original',
        screen: currentScreen(),
      });
      setStatus(outcome.failed.length ? { kind: 'restore-failed', opened: outcome.opened, failed: outcome.failed } : { kind: 'idle' });
    } catch (error) {
      setStatus({ kind: 'error', message: messageOf(error) });
    }
  };

  const rowHandlers = (tab: (typeof allTabs)[number]) => ({
    onActivate: () => {
      if (tab.id === undefined) return;
      browser.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) browser.windows.update(tab.windowId, { focused: true });
      window.close();
    },
    onToggleSelect: () =>
      setSelection((prev) => {
        const next = new Set(prev);
        if (tab.id === undefined) return next;
        if (next.has(tab.id)) next.delete(tab.id);
        else next.add(tab.id);
        return next;
      }),
    onSuspend: () => {
      if (tab.id !== undefined) send({ type: 'suspend-tab', tabId: tab.id }).catch(() => undefined);
    },
    onSave: () => {
      if (tab.id !== undefined) saveTabs([tab.id]);
    },
    onClose: () => {
      if (tab.id !== undefined) browser.tabs.remove(tab.id).catch(() => undefined);
    },
  });

  const banner = (() => {
    switch (status.kind) {
      case 'busy':
        return <Banner tone="neutral" icon={null}>{status.label}</Banner>;
      case 'error':
        return <Banner tone="error" role="alert">{status.message}</Banner>;
      case 'info':
        return <Banner tone="neutral">{status.message}</Banner>;
      case 'audible':
        return (
          <Banner
            tone="warning"
            title={`${plural(status.count, 'tab')} ${status.count === 1 ? 'is' : 'are'} playing audio`}
            actions={
              <>
                <Button size="xs" onClick={() => save(status.scope, 'keep')}>
                  Keep {status.count === 1 ? 'it' : 'them'} open
                </Button>
                <Button size="xs" variant="ghost" className="text-amber" onClick={() => save(status.scope, 'close')}>
                  Save &amp; close anyway
                </Button>
              </>
            }
          />
        );
      case 'suspended':
        return (
          <Banner tone="success" role="status" icon={<Pause size={16} aria-hidden />}>
            {status.count ? (
              <>
                <span className="font-semibold">Suspended {plural(status.count, 'tab')}</span> · freed ~{formatBytes(status.freedBytes)}
              </>
            ) : (
              'No tabs to suspend right now.'
            )}
            {status.skipped > 0 && <span className="text-text-2"> · {status.skipped} kept (pinned, audio or protected)</span>}
          </Banner>
        );
      case 'already-open':
        return (
          <Banner
            tone="accent"
            title="This session is already open"
            actions={
              <>
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => {
                    browser.windows.update(status.windowId, { focused: true });
                    window.close();
                  }}
                >
                  Switch to it
                </Button>
                <Button size="xs" onClick={() => restore(status.sessionId, true)}>
                  Open a copy
                </Button>
              </>
            }
          />
        );
      case 'restore-failed':
        return (
          <Banner
            tone="warning"
            title={`Restored ${status.opened} of ${status.opened + status.failed.length} tabs`}
            actions={
              <Button
                size="xs"
                icon={<Copy size={14} aria-hidden />}
                onClick={async () => {
                  const ok = await copyText(status.failed.map((f) => f.url).join('\n'));
                  setStatus(ok ? { kind: 'info', message: 'Links copied. Paste them into the address bar.' } : status);
                }}
              >
                Copy links
              </Button>
            }
          >
            Chrome won't let extensions reopen {status.failed.length === 1 ? 'one page' : `${status.failed.length} pages`}.
          </Banner>
        );
      default:
        break;
    }
    if (showUndo && action) {
      return (
        <Banner
          tone="success"
          role="status"
          icon={null}
          className="items-center py-1.5 pr-1.5"
          actions={undefined}
        >
          <div className="flex items-center gap-2.5">
            <span className="min-w-0 flex-1">
              {action.closedTabs > 0 ? (
                <>
                  <span className="font-semibold">Freed ~{formatBytes(action.freedBytes || estimateBytes(action.closedTabs))}</span> ·{' '}
                  {plural(action.savedTabs, 'tab')} saved
                </>
              ) : (
                <>
                  <span className="font-semibold">Saved {plural(action.savedTabs, 'tab')}</span> to {action.sessionName}
                </>
              )}
              {action.intoUnsorted && <span className="block text-meta">Into Unsorted: Free holds 50 named sessions.</span>}
            </span>
            <button
              type="button"
              onClick={() => send({ type: 'undo', actionId: action.id }).catch(() => undefined)}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-semibold text-green hover:bg-green-line/40"
            >
              <RotateCcw size={14} aria-hidden />
              Undo <span className="font-normal">{secondsLeft}s</span>
            </button>
          </div>
        </Banner>
      );
    }
    return (
      <div className="flex h-10 items-center gap-2.5 rounded-card border border-border bg-bg-subtle px-3">
        <MemoryStick size={16} aria-hidden className="shrink-0 text-text-2" />
        <p className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{plural(allTabs.length, 'tab')} open</span>
          <span className="text-text-2"> · ~{formatBytes(estimateBytes(loadedTabs))} in use</span>
        </p>
        <span className="shrink-0 text-meta text-text-3">{plural(windows.length, 'window')}</span>
      </div>
    );
  })();

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2.5 px-3">
        {offer && (
          <Banner
            tone="accent"
            role="alert"
            icon={<RotateCcw size={16} aria-hidden />}
            title="Restore your last session?"
            actions={
              <>
                <Button size="xs" variant="primary" onClick={restoreRecovery}>
                  Restore windows
                </Button>
                <Button
                  size="xs"
                  onClick={() => {
                    openLibrary('#/snapshots');
                    window.close();
                  }}
                >
                  Review first
                </Button>
                <Button size="xs" variant="ghost" onClick={() => send({ type: 'dismiss-recovery' })}>
                  Not now
                </Button>
              </>
            }
          >
            Last time you had {plural(offer.tabCount, 'tab')} in {plural(offer.windowCount, 'window')}, saved {timeAgo(offer.createdAt).toLowerCase()}.
          </Banner>
        )}
        {banner}
        <div className="flex flex-col gap-2 pb-3">
          <Button
            variant="primary"
            size="lg"
            className="relative w-full"
            icon={<Archive size={16} aria-hidden />}
            disabled={status.kind === 'busy'}
            onClick={() => save('all')}
            trailing={saveShortcut ? <span aria-hidden className="absolute right-3 text-meta font-normal">{saveShortcut}</span> : undefined}
          >
            Save all &amp; free memory
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              className="h-[34px]"
              icon={<AppWindow size={16} aria-hidden className="text-text-2" />}
              disabled={status.kind === 'busy'}
              onClick={() => save('window')}
            >
              Save this window
            </Button>
            <Button
              size="sm"
              className="h-[34px]"
              icon={<Pause size={16} aria-hidden className="text-text-2" />}
              disabled={status.kind === 'busy'}
              onClick={suspendAll}
            >
              Suspend inactive
            </Button>
          </div>
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-border px-3 pb-3">
        <div className="flex h-[38px] items-center justify-between">
          <h2 className="label-caps">Open now</h2>
          {selection.size === 0 && <span className="text-meta text-text-3">{modKey.replace('+', '')}-click tabs to select</span>}
        </div>
        {!loaded ? (
          <div className="flex flex-col gap-3 rounded-card border border-border p-3" aria-busy="true">
            {[70, 82, 58].map((w) => (
              <div key={w} className="flex items-center gap-2.5">
                <span className="size-4 rounded bg-skeleton" />
                <span className="h-2.5 rounded bg-skeleton" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {ordered.map((window, index) => {
              const label = window.name || `Window ${windows.indexOf(window) + 1}`;
              const isCurrent = window.id === currentWindowId;
              return (
                <WindowCard
                  key={window.id}
                  window={window}
                  label={label}
                  isCurrent={isCurrent}
                  expanded={expanded[window.id] ?? (isCurrent || (index === 0 && currentWindowId === undefined))}
                  onToggle={() => setExpanded((e) => ({ ...e, [window.id]: !(e[window.id] ?? isCurrent) }))}
                  onRename={(name) => windowNames.set(window.id, name)}
                  selection={selection}
                  rowHandlers={rowHandlers}
                  onSaveWindow={async () => {
                    try {
                      report(await send({ type: 'save', scope: 'window', windowId: window.id, close: true }));
                    } catch (error) {
                      setStatus({ kind: 'error', message: messageOf(error) });
                    }
                  }}
                />
              );
            })}
          </div>
        )}

        <div className="mt-1.5 flex h-[38px] items-center justify-between">
          <h2 className="label-caps">Recent sessions</h2>
          <button
            type="button"
            className="text-small font-semibold text-accent-text hover:underline"
            onClick={() => {
              openLibrary();
              window.close();
            }}
          >
            View all
          </button>
        </div>
        {recent && recent.length === 0 && (
          <p className="rounded-card border border-dashed border-border-strong px-3 py-4 text-center text-text-2">
            Your saved tabs will live here.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          {recent?.map((session) => (
            <div key={session.id} className="flex items-center gap-2.5 rounded-card border border-border bg-surface py-2 pr-2 pl-3">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  openLibrary(`#/session/${session.id}`);
                  window.close();
                }}
              >
                <span className="block truncate font-semibold">{session.name}</span>
                <span className="flex items-center gap-1.5 text-meta text-text-3">
                  <span>{plural(session.tabCount, 'tab')}</span>·<span>{plural(session.windowCount, 'window')}</span>·
                  <span>{timeAgo(session.updatedAt)}</span>
                  <Laptop size={12} aria-hidden className="ml-0.5" />
                </span>
              </button>
              <Button size="xs" disabled={status.kind === 'busy'} onClick={() => restore(session.id)}>
                Restore
              </Button>
            </div>
          ))}
        </div>
      </div>

      {selectedIds.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-3 py-2">
          <span className="min-w-0 flex-1 font-semibold">
            {selectedIds.length} selected
            {selection.size === 0 && <span className="block text-meta font-normal text-text-3">Highlighted in Chrome</span>}
          </span>
          {selection.size > 0 && (
            <Button size="xs" variant="ghost" onClick={() => setSelection(new Set())}>
              Clear
            </Button>
          )}
          <Button size="xs" onClick={() => onAskKeywords(selectedIds)}>
            Add keywords
          </Button>
          <Button
            size="xs"
            variant="primary"
            onClick={async () => {
              try {
                report(await send({ type: 'save', scope: 'tabs', tabIds: selectedIds, close: true, windowId: currentWindowId }));
                setSelection(new Set());
              } catch (error) {
                setStatus({ kind: 'error', message: messageOf(error) });
              }
            }}
          >
            Save &amp; close
          </Button>
        </div>
      )}
    </>
  );
}
