import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock, Folder, Radio, RotateCcw, X, Zap } from 'lucide-react';
import type { Browser } from 'wxt/browser';
import { CommandError, send } from '@/lib/messages';
import { autoFoldNotice as autoFoldNoticeState, type AutoFoldNotice, type LiveFolder, type SnoozeBack } from '@/lib/state';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { classifyUrl } from '@/lib/urls';
import { extUrl } from '@/lib/extUrl';
import { FolderIcon } from '@/ui/components/FolderIcon';
import { anchorBelow, Menu } from '@/ui/components/Menu';
import { cx } from '@/ui/cx';
import { useLastAction, useNow } from '@/ui/hooks';
import { autoFoldText } from '@/ui/limits';
import { snoozeChoices } from '@/ui/snooze';
import { SectionLabel } from './parts';

/**
 * The popup's 0.6 lines (Mx-Auto, Mx-Live-States, Mx-Ask): tabs that came back from snooze, the
 * last automatic fold with Undo, which folder you're working in, and actions for the tab you're on
 * in search.
 */

/**
 * "2 tabs came back from snooze" (Mx-Auto). Seen once shown: the worker clears the toolbar number,
 * and the line stays until the popup closes.
 */
export function SnoozeBackLine({ back }: { back: SnoozeBack | undefined }) {
  const [shown, setShown] = useState<SnoozeBack | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!back || back.tabRecordIds.length === 0 || shown?.at === back.at) return;
    setShown(back);
    void send({ type: 'snooze-seen' }).catch(() => undefined);
  }, [back, shown]);
  if (!shown || dismissed) return null;
  const n = shown.tabRecordIds.length || shown.titles.length;
  const names = shown.titles.slice(0, 2).join(' · ');
  return (
    <div className="flex-none px-4 pb-3">
      <div role="status" className="flex items-start gap-2.5 rounded-card border border-accent-line bg-accent-soft py-2.5 pr-1.5 pl-3">
        <Clock size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 flex-none text-accent-text" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {n === 1 ? '1 tab came back from snooze' : `${n.toLocaleString()} tabs came back from snooze`}
          </div>
          {names && (
            <div dir="auto" className="truncate text-small text-text-2">
              {names}
              {shown.titles.length > 2 ? ` and ${shown.titles.length - 2} more` : ''} — opened in the background
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => setDismissed(true)}
          className="flex size-7 flex-none items-center justify-center rounded-md text-text-2 hover:bg-white/40 hover:text-text"
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** How long the last automatic fold is mentioned in the popup. */
const AUTO_LINE_MS = 6 * 3_600_000;

/** "Folded 23 tabs at 18:00 (your weekday rule) · freed ~1.1 GB · Undo" (Mx-Auto). */
export function AutoFoldLine({ notice }: { notice: AutoFoldNotice | undefined }) {
  const action = useLastAction();
  const live = !!notice?.actionId && !!action && action.id === notice.actionId && !action.undone;
  const now = useNow(live, 500);
  const [busy, setBusy] = useState(false);
  if (!notice || notice.folded <= 0 || Date.now() - notice.at > AUTO_LINE_MS) return null;
  const canUndo = live && now < action!.expiresAt;
  return (
    <div className="flex-none px-4 pb-3">
      <div role="status" className="flex items-center gap-2.5 rounded-card border border-border bg-bg-subtle py-2 pr-1.5 pl-3">
        <Zap size={16} strokeWidth={1.75} aria-hidden className="flex-none text-accent-text" />
        <span className="min-w-0 flex-1 text-small">{autoFoldText(notice)}</span>
        {canUndo && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              send({ type: 'undo', actionId: notice.actionId! })
                .catch(() => undefined)
                .finally(() => setBusy(false));
            }}
            className="inline-flex h-7 flex-none items-center gap-1 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold hover:bg-hover disabled:opacity-60"
          >
            <RotateCcw size={13} strokeWidth={2} aria-hidden className="text-text-2" />
            Undo
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => void autoFoldNoticeState.set(null).catch(() => undefined)}
          className="flex size-7 flex-none items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/**
 * "Working in Client sites ▾" (Mx-Live-States, Pro): which folder is open as a live group;
 * picking another switches to it (folding the current one), picking the live one goes to it.
 */
export function WorkingIn({
  folders,
  live,
  tabs,
  onProblem,
}: {
  folders: FolderRecord[];
  live: Record<string, LiveFolder>;
  tabs: TabRecord[] | undefined;
  onProblem: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const current = folders.filter((f) => live[f.id]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tabs ?? []) if (t.folderId && !t.snoozeUntil) map.set(t.folderId, (map.get(t.folderId) ?? 0) + 1);
    return map;
  }, [tabs]);
  if (current.length === 0) return null;
  const run = async (folder: FolderRecord) => {
    try {
      if (live[folder.id]) await send({ type: 'live-focus', folderId: folder.id });
      else {
        const result = await send({ type: 'live-open', folderId: folder.id, foldOthers: true });
        if (result.reason) {
          onProblem(result.reason);
          return;
        }
      }
      window.close();
    } catch (error) {
      onProblem(error instanceof Error ? error.message : 'Couldn’t open that folder.');
    }
  };
  return (
    <div className="flex-none px-4 pb-3">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center gap-2 rounded-control border border-border-strong bg-surface px-2.5 text-left hover:bg-hover"
      >
        <Radio size={15} strokeWidth={1.75} aria-hidden className="flex-none text-green" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-text-3">Working in</span> <b className="font-semibold">{current.map((f) => f.name).join(', ')}</b>
        </span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden className="flex-none text-text-3" />
      </button>
      {open && button.current && (
        <Menu
          anchor={{ ...anchorBelow(button.current, false) }}
          width={button.current.offsetWidth}
          label="Switch folder"
          returnFocus={button.current}
          onClose={() => setOpen(false)}
          entries={folders.map((folder) => ({
            key: folder.id,
            label: folder.name,
            icon: <FolderIcon color={folder.color} size={15} />,
            hint: live[folder.id] ? 'live' : `${(counts.get(folder.id) ?? 0).toLocaleString()} ${counts.get(folder.id) === 1 ? 'tab' : 'tabs'}`,
            onSelect: () => void run(folder),
          }))}
        />
      )}
    </div>
  );
}

const FILLER = new Set(['this', 'tab', 'to', 'the', 'a']);

/** Every query word starts a word of the label (or its extra words). */
function fits(query: string, words: string[]): boolean {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (q.length === 0 || q.every((w) => FILLER.has(w))) return false;
  return q.every((w) => words.some((x) => x.startsWith(w)));
}

/**
 * Actions for the tab you're on, in the popup's search (Mx-Ask): "Snooze this tab ▸" and "Move
 * this tab to <folder>" (it folds into the folder).
 */
export function SearchActions({
  query,
  tab,
  folders,
  onProblem,
}: {
  query: string;
  tab: Browser.tabs.Tab | undefined;
  folders: FolderRecord[];
  onProblem: (text: string) => void;
}) {
  const [snoozing, setSnoozing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSnoozing(false), [query]);
  const url = tab?.url || tab?.pendingUrl || '';
  const kind = classifyUrl(url, extUrl('/'));
  if (!tab || tab.id === undefined || kind === 'own' || kind === 'blank') return null;
  const tabId = tab.id;

  const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const snooze = fits(query, ['snooze', 'later', 'remind', 'tomorrow', 'weekend', 'this', 'tab']);
  const moves = folders.filter((f) => fits(query, ['move', 'this', 'tab', 'to', ...words(f.name)])).slice(0, 3);
  if (!snooze && moves.length === 0) return null;

  const fail = (error: unknown) => {
    const code = error instanceof CommandError ? error.code : undefined;
    onProblem(
      code === 'snooze-limit'
        ? 'Free has 3 snoozed tabs at a time. Wake one, or upgrade to snooze as many as you like.'
        : code === 'list-full'
          ? 'Your free list is full. Make room in the full list, or upgrade for unlimited.'
          : error instanceof Error
            ? error.message
            : 'Something went wrong. Please try again.',
    );
  };
  const act = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
      window.close();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const row = 'flex h-10 w-full items-center gap-2.5 rounded-control px-2 text-left hover:bg-hover focus-visible:bg-hover disabled:opacity-60';
  return (
    <div role="group" aria-label="This tab" className="flex-none px-2 pt-1">
      <SectionLabel>Actions</SectionLabel>
      {snooze && (
        <>
          <button type="button" disabled={busy} aria-expanded={snoozing} onClick={() => setSnoozing((s) => !s)} className={row}>
            <Clock size={16} strokeWidth={1.75} aria-hidden className="flex-none text-text-2" />
            <span className="flex-1">Snooze this tab</span>
            <ChevronDown size={14} strokeWidth={2} aria-hidden className={cx('flex-none text-text-3 transition-transform', !snoozing && '-rotate-90')} />
          </button>
          {snoozing &&
            snoozeChoices().map((choice) => (
              <button
                key={choice.id}
                type="button"
                disabled={busy}
                onClick={() => void act(() => send({ type: 'snooze', until: choice.at, tabIds: [tabId] }))}
                className={cx(row, 'h-8 pl-9')}
              >
                <span className="flex-1">{choice.label}</span>
                <span className="text-small text-text-3">{choice.detail}</span>
              </button>
            ))}
        </>
      )}
      {moves.map((folder) => (
        <button
          key={folder.id}
          type="button"
          disabled={busy}
          onClick={() => void act(() => send({ type: 'fold', tabIds: [tabId], intoFolderId: folder.id, keepWindowOpen: true }))}
          className={row}
        >
          <Folder size={16} strokeWidth={1.75} aria-hidden className="flex-none text-text-2" />
          <span dir="auto" className="min-w-0 flex-1 truncate">
            Move this tab to {folder.name}
          </span>
          <FolderIcon color={folder.color} size={14} />
        </button>
      ))}
      <div aria-hidden className="mx-2 mt-1 h-px bg-border" />
    </div>
  );
}
