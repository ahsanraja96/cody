import { AppWindow, Import, Pin } from 'lucide-react';
import { plural, timeAgo } from '@/lib/format';
import { openLibrary } from '@/lib/openLibrary';
import type { SessionRecord } from '@/lib/types';
import { Button } from '@/ui/components/Button';
import { cx } from '@/ui/cx';

export interface RestoreProgressView {
  sessionId: string | null;
  name: string;
  restoreId?: string;
  done: number;
  total: number;
  windowCount: number;
}

export interface AlreadyOpenView {
  sessionId: string;
  name: string;
  windowIds: number[];
  openTabs: number;
  totalTabs: number;
}

function PinnedMark() {
  return <Pin size={12} strokeWidth={2} role="img" aria-label="Pinned" className="shrink-0 text-text-3" />;
}

function Meta({ session, narrow, strong }: { session: SessionRecord; narrow: boolean; strong?: boolean }) {
  const when = strong ? 'Just now' : timeAgo(session.updatedAt);
  if (narrow) {
    return (
      <div className={cx('truncate text-meta', strong ? 'text-text-2' : 'text-text-3')}>
        {when} · {plural(session.tabCount, 'tab')}
      </div>
    );
  }
  return (
    <div className={cx('flex min-w-0 items-center gap-[5px] text-meta', strong ? 'text-text-2' : 'text-text-3')}>
      <span className="shrink-0">{plural(session.tabCount, 'tab')}</span>
      <span aria-hidden>·</span>
      <span className="shrink-0">{plural(session.windowCount, 'window')}</span>
      <span aria-hidden>·</span>
      <span className="truncate">{when}</span>
    </div>
  );
}

/** A restore in progress: "Opening 3 windows · 12 of 24 tabs", a progress bar and Cancel. */
function RestoringCard({
  progress,
  pinned,
  lazy,
  onCancel,
}: {
  progress: RestoreProgressView;
  pinned: boolean;
  lazy: boolean;
  onCancel: () => void;
}) {
  const total = Math.max(progress.total, 1);
  const done = Math.min(progress.done, total);
  return (
    <div aria-busy="true" className="flex flex-col gap-2 rounded-card border border-accent-line bg-accent-soft py-2 pr-2 pl-3">
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span dir="auto" className="truncate font-semibold">
              {progress.name}
            </span>
            {pinned && <PinnedMark />}
          </div>
          <div role="status" className="truncate text-meta text-accent-text">
            <span className="font-semibold">Opening {plural(progress.windowCount, 'window')}</span> · {done} of{' '}
            {plural(progress.total, 'tab')}
          </div>
        </div>
        <Button size="xs" variant="ghost" disabled={!progress.restoreId} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div
        role="progressbar"
        aria-label={`Restoring ${progress.name}`}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${plural(progress.total, 'tab')}`}
        className="mr-1 h-1 overflow-hidden rounded-sm bg-accent-line"
      >
        <div className="tf-progress h-full rounded-sm bg-accent" style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </div>
      {lazy && <p className="text-meta text-text-2">Tabs open unloaded and load when you click them.</p>}
    </div>
  );
}

/** "Checkout app is already open": switch to it, open a copy, or cancel. */
function AlreadyOpenCard({
  view,
  onSwitch,
  onCopy,
  onCancel,
}: {
  view: AlreadyOpenView;
  onSwitch: () => void;
  onCopy: () => void;
  onCancel: () => void;
}) {
  const windows = plural(view.windowIds.length, 'window');
  const detail =
    view.openTabs >= view.totalTabs
      ? view.totalTabs === 1
        ? `Its 1 tab is open in ${windows}.`
        : `Its ${view.totalTabs} tabs are open in ${windows}.`
      : `${view.openTabs} of its ${view.totalTabs} tabs are open in ${windows}.`;
  return (
    <div
      role="alert"
      aria-labelledby={`ao-title-${view.sessionId}`}
      aria-describedby={`ao-desc-${view.sessionId}`}
      className="flex flex-col gap-2.5 rounded-card border border-accent-line bg-accent-soft pt-2.5 pr-2 pb-2 pl-3"
    >
      <div className="flex items-start gap-2">
        <AppWindow size={16} aria-hidden className="mt-px shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <div id={`ao-title-${view.sessionId}`} dir="auto" className="truncate font-semibold">
            {view.name} is already open
          </div>
          <div id={`ao-desc-${view.sessionId}`} className="text-small text-text-2">
            {detail}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-6">
        <Button size="sm" variant="primary" autoFocus onClick={onSwitch}>
          Switch to it
        </Button>
        <Button size="sm" onClick={onCopy}>
          Open a copy
        </Button>
        <Button size="sm" variant="ghost" className="px-2" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function FirstRunCard() {
  return (
    <section
      aria-labelledby="first-run-title"
      className="flex items-center gap-4 rounded-card border border-dashed border-border-strong bg-bg-subtle px-3.5 py-2.5"
    >
      <div aria-hidden className="relative h-[46px] w-16 shrink-0 max-[360px]:hidden">
        <div className="absolute top-0 left-3 h-[7px] w-10 rounded-t bg-border" />
        <div className="absolute top-[5px] left-1.5 h-[7px] w-[52px] rounded-t bg-border-strong" />
        <div className="absolute top-2.5 left-0 flex h-9 w-16 flex-col gap-[5px] rounded-[7px] border border-border-strong bg-surface px-2 py-[7px]">
          <div className="h-[5px] w-[70%] rounded-[3px] bg-accent-soft" />
          <div className="h-[5px] w-[90%] rounded-[3px] bg-hover" />
          <div className="h-[5px] w-[55%] rounded-[3px] bg-hover" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <h3 id="first-run-title" className="text-section leading-5 font-semibold">
          Nothing saved yet
        </h3>
        <p className="mt-0.5 text-small text-text-2">
          <span className="font-semibold text-text">Save all</span> folds your tabs into a session. Each window keeps its own
          group.
        </p>
        <button
          type="button"
          className="mt-1.5 inline-flex items-center gap-1.5 text-left text-small font-semibold text-accent-text hover:underline"
          onClick={() => {
            openLibrary('#/settings/data');
            window.close();
          }}
        >
          <Import size={14} aria-hidden className="shrink-0" />
          Import from OneTab or Session Buddy
        </button>
      </div>
    </section>
  );
}

export function RecentSessions({
  sessions,
  narrow,
  incognito,
  justSavedId,
  restoring,
  alreadyOpen,
  lazyRestore,
  restoreDisabled,
  onRestore,
  onCancelRestore,
  onSwitch,
  onOpenCopy,
  onDismissAlreadyOpen,
}: {
  sessions: SessionRecord[] | undefined;
  narrow: boolean;
  incognito: boolean;
  justSavedId: string | null;
  restoring: RestoreProgressView | null;
  alreadyOpen: AlreadyOpenView | null;
  lazyRestore: boolean;
  restoreDisabled: boolean;
  onRestore: (session: SessionRecord) => void;
  onCancelRestore: () => void;
  onSwitch: () => void;
  onOpenCopy: () => void;
  onDismissAlreadyOpen: () => void;
}) {
  const restoringOther = restoring && !sessions?.some((s) => s.id === restoring.sessionId);
  return (
    <>
      <div
        className={cx(
          'mt-1.5 flex items-center justify-between max-[360px]:mt-0 max-[360px]:h-[30px]',
          incognito ? 'h-8' : 'h-[38px]',
        )}
      >
        <h2 className="label-caps">Recent sessions</h2>
        {sessions && sessions.length > 0 && (
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
        )}
      </div>
      {incognito && (
        <p className="mb-2 flex items-center gap-1.5 text-meta text-text-3">
          <AppWindow size={12} strokeWidth={2} aria-hidden className="shrink-0" />
          Sessions open in a normal window
        </p>
      )}
      {sessions && sessions.length === 0 && !restoring && <FirstRunCard />}
      <div className="flex flex-col gap-1.5">
        {restoringOther && restoring && (
          <RestoringCard progress={restoring} pinned={false} lazy={lazyRestore} onCancel={onCancelRestore} />
        )}
        {sessions?.map((session) => {
          if (restoring && restoring.sessionId === session.id) {
            return (
              <RestoringCard
                key={session.id}
                progress={{ ...restoring, name: session.name }}
                pinned={session.pinned === 1}
                lazy={lazyRestore}
                onCancel={onCancelRestore}
              />
            );
          }
          if (alreadyOpen && alreadyOpen.sessionId === session.id) {
            return (
              <AlreadyOpenCard
                key={session.id}
                view={alreadyOpen}
                onSwitch={onSwitch}
                onCopy={onOpenCopy}
                onCancel={onDismissAlreadyOpen}
              />
            );
          }
          const justSaved = session.id === justSavedId;
          const waitFor = restoring ? `Wait for ${restoring.name} to finish opening` : undefined;
          return (
            <div
              key={session.id}
              className={cx(
                'flex items-center gap-2.5 rounded-card border py-2 pr-2 pl-3 max-[360px]:py-[7px]',
                justSaved ? 'border-accent-line bg-accent-soft' : 'border-border bg-surface',
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  openLibrary(`#/session/${session.id}`);
                  window.close();
                }}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span dir="auto" className="truncate font-semibold">
                    {session.name}
                  </span>
                  {session.pinned === 1 && <PinnedMark />}
                  {justSaved && <span className="shrink-0 text-meta font-semibold text-accent-text">Just saved</span>}
                </span>
                <Meta session={session} narrow={narrow} strong={justSaved} />
              </button>
              <Button
                size="xs"
                disabled={restoreDisabled || !!restoring}
                title={waitFor}
                aria-label={`Restore ${session.name}`}
                onClick={() => onRestore(session)}
              >
                Restore
              </Button>
            </div>
          );
        })}
      </div>
    </>
  );
}
