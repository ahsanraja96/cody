import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, CircleAlert, Info, LoaderCircle, ShieldCheck, Sparkles, TriangleAlert, X } from 'lucide-react';
import { send } from '@/lib/messages';
import { proConfigured } from '@/lib/pro/config';
import { hasProAi } from '@/lib/pro/tiers';
import { AI_RUNS_PER_MONTH, TRIAL_DAYS, type AiGroup, type OrganiseResult } from '@/lib/pro/types';
import type { FolderRecord, TabGroupColor, TabRecord } from '@/lib/types';
import { displayHost } from '@/lib/urls';
import { Favicon } from '@/ui/components/Favicon';
import { FaviconStrip } from '@/ui/components/FoldedList';
import { FolderIcon } from '@/ui/components/FolderIcon';
import { Chip } from '@/ui/components/ProBits';
import { toast, ToastViewport } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { useAiRuns, usePlan } from '@/ui/hooks';
import { errorCode, proErrorText, runsLine, shortDate, trialUsed } from '@/ui/pro';
import { startTrialFlow } from './AccountDialogs';
import { count } from './format';
import { goToPlans } from './router';

type Phase =
  | { kind: 'teaser' }
  | { kind: 'loading' }
  | { kind: 'preview'; result: OrganiseResult }
  | { kind: 'error'; code?: string; message: string };

/** Rows an open folder shows before "Show N more". */
const FIRST_ROWS = 4;

const PRIMARY =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent';
const SECONDARY = 'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control border border-border-strong bg-surface px-3.5 text-text hover:bg-hover';
const CLOSE = 'inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text';


/** The 16px tick from the Pro-Organise board, on a real (visually hidden) checkbox. */
function Tick({
  checked,
  mixed = false,
  onChange,
  label,
}: {
  checked: boolean;
  mixed?: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <span className="relative flex size-4 shrink-0">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        ref={(el) => {
          if (el) el.indeterminate = mixed;
        }}
        className="peer absolute inset-0 m-0 cursor-pointer opacity-0"
      />
      <span
        aria-hidden
        className={cx(
          'pointer-events-none flex size-4 items-center justify-center rounded-[4px] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          checked || mixed ? 'bg-accent text-on-accent' : 'border-[1.5px] border-border-strong bg-surface',
        )}
      >
        {mixed ? <span className="h-0.5 w-2 rounded bg-current" /> : checked && <Check size={12} strokeWidth={3} />}
      </span>
    </span>
  );
}

function IconTile({ size = 36 }: { size?: 32 | 36 }) {
  return (
    <span
      aria-hidden
      className={cx(
        'flex shrink-0 items-center justify-center bg-accent-soft text-accent-text',
        size === 36 ? 'size-9 rounded-[10px]' : 'size-8 rounded-control',
      )}
    >
      <Sparkles size={size === 36 ? 18 : 16} strokeWidth={1.75} />
    </span>
  );
}

/**
 * "Organise with AI" (Pro-Organise, Fo-Folders-States): the AI puts the folded tabs into folders,
 * the person's own (matched by name) and new ones marked "new"; people untick what should stay
 * where it is, and "Put them in folders" applies it. Without Pro AI it is the teaser from
 * Pro-States ("Organise with AI · free plan"); when the trial starts while it is open, the first
 * run follows straight away.
 */
export function OrganiseDialog({ open, onClose, tabs, folders }: { open: boolean; onClose: () => void; tabs: TabRecord[]; folders: FolderRecord[] }) {
  const ref = useRef<HTMLDialogElement>(null);
  const plan = usePlan();
  const proAi = hasProAi(plan);
  const [phase, setPhase] = useState<Phase>({ kind: proAi ? 'loading' : 'teaser' });
  const runId = useRef(0);

  const run = useCallback(async () => {
    const id = ++runId.current;
    setPhase({ kind: 'loading' });
    try {
      const result = await send({ type: 'ai-organise' });
      if (runId.current === id) setPhase({ kind: 'preview', result });
    } catch (error) {
      if (runId.current !== id) return;
      const code = errorCode(error);
      setPhase(code === 'needs-pro-ai' ? { kind: 'teaser' } : { kind: 'error', code, message: proErrorText(error) });
    }
  }, []);

  // Opening runs it (Pro AI) or shows the teaser; a trial that starts meanwhile runs it at once.
  useEffect(() => {
    if (!open) return;
    if (!proAi) {
      setPhase({ kind: 'teaser' });
      return;
    }
    setPhase({ kind: 'loading' });
    // A timer, so React's double effect in development doesn't spend two runs.
    const timer = setTimeout(() => void run(), 0);
    return () => {
      clearTimeout(timer);
      runId.current += 1;
    };
  }, [open, proAi, run]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // When the part that had focus goes away (loading → preview), keep focus in the dialog.
  useEffect(() => {
    const dialog = ref.current;
    if (dialog?.open && (!document.activeElement || document.activeElement === document.body)) dialog.focus();
  }, [phase.kind]);

  const teaser = phase.kind === 'teaser';
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      data-toasts
      aria-labelledby="org-h"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto overflow-hidden rounded-[12px] border border-border bg-surface p-0 text-text shadow-pop outline-none"
      style={{ width: teaser ? 'min(460px, calc(100vw - 32px))' : 'min(720px, calc(100vw - 32px))' }}
    >
      {open &&
        (phase.kind === 'teaser' ? (
          <Teaser onClose={onClose} />
        ) : (
          <div className="flex max-h-[min(812px,calc(100vh-32px))] flex-col">
            <header className="flex items-start gap-3.5 pt-5 pr-5 pb-4 pl-6">
              <IconTile />
              <div className="min-w-0 flex-1">
                <h1 id="org-h" className="m-0 text-page font-semibold">
                  Organise with AI
                </h1>
                <p className="mt-1 mb-0 text-text-2">
                  {phase.kind === 'preview'
                    ? `${count(tabs.length, 'folded tab')} → ${count(phase.result.groups.length, 'folder')}. Untick anything to leave it where it is. Nothing changes until you choose.`
                    : 'Puts your folded tabs into folders, not just by kind of site. You see the folders first and choose.'}
                </p>
              </div>
              <button type="button" aria-label="Close" title="Close" onClick={onClose} className={CLOSE}>
                <X size={18} strokeWidth={1.75} aria-hidden />
              </button>
            </header>
            {phase.kind === 'loading' ? (
              <Loading onCancel={onClose} total={tabs.length} />
            ) : phase.kind === 'error' ? (
              <Failed phase={phase} onRetry={() => void run()} onClose={onClose} />
            ) : (
              <Preview result={phase.result} tabs={tabs} folders={folders} onClose={onClose} />
            )}
          </div>
        ))}
      {open && <ToastViewport inDialog />}
    </dialog>
  );
}

function Footer({ children, runs }: { children: ReactNode; runs?: ReactNode }) {
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-border px-6 py-4">
      <span className="min-w-0 flex-1 text-small text-text-3 tabular-nums">{runs}</span>
      {children}
    </footer>
  );
}

function Loading({ onCancel, total }: { onCancel: () => void; total: number }) {
  return (
    <>
      <div role="status" className="flex flex-col gap-2 px-6 pt-1 pb-6">
        <div className="flex items-center gap-2.5 font-semibold">
          <LoaderCircle size={16} aria-hidden className="tf-spin shrink-0 text-accent-text" />
          Organising your tabs…
        </div>
        <p className="m-0 text-small text-text-3">
          Sending the titles and sites of {total > 300 ? 'your newest 300 tabs' : count(total, 'tab')}, never page content. This takes a few seconds.
        </p>
        <div aria-hidden className="mt-2 flex flex-col gap-2">
          {[0.9, 0.7, 0.8, 0.6].map((w, i) => (
            <div key={i} className="flex h-11 items-center gap-2.5 rounded-card border border-border px-3">
              <span className="size-4 rounded-[4px] bg-skeleton" />
              <span className="size-2.5 rounded-full bg-skeleton" />
              <span className="h-2.5 animate-pulse rounded bg-skeleton" style={{ width: `${w * 40}%` }} />
            </div>
          ))}
        </div>
      </div>
      <Footer>
        <button type="button" onClick={onCancel} className={cx(SECONDARY, 'h-9')}>
          Cancel
        </button>
      </Footer>
    </>
  );
}

function Failed({ phase, onRetry, onClose }: { phase: Extract<Phase, { kind: 'error' }>; onRetry: () => void; onClose: () => void }) {
  const runs = useAiRuns();
  if (phase.code === 'runs-used-up') {
    return (
      <>
        <div className="px-6 pt-1 pb-6">
          <div role="alert" className="flex items-start gap-2.5 rounded-card border border-amber-line bg-amber-soft px-3.5 py-3">
            <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-amber" />
            <div className="min-w-0">
              <div className="font-semibold">You’ve used this month’s {(runs?.limit ?? AI_RUNS_PER_MONTH).toLocaleString()} AI runs</div>
              <div className="text-small text-text-2">
                They start again {runs?.resetsAt ? `on ${shortDate(runs.resetsAt)}` : 'next month'}. Your folders stay as they are; new tabs are sorted by
                site until then.
              </div>
            </div>
          </div>
        </div>
        <Footer runs={runs ? `${runsLine(runs)} AI runs this month` : undefined}>
          <button type="button" autoFocus onClick={onClose} className={cx(SECONDARY, 'h-9')}>
            Close
          </button>
        </Footer>
      </>
    );
  }
  return (
    <>
      <div className="px-6 pt-1 pb-6">
        <div role="alert" className="flex items-start gap-2.5 rounded-card border border-border bg-bg-subtle px-3.5 py-3">
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-red" />
          <div className="min-w-0">
            <div className="font-semibold">Couldn’t organise your tabs</div>
            <div className="text-small text-text-2">{phase.message}</div>
          </div>
        </div>
      </div>
      <Footer runs={runs ? `${runsLine(runs)} AI runs this month` : undefined}>
        <button type="button" onClick={onClose} className={cx(SECONDARY, 'h-9')}>
          Cancel
        </button>
        {phase.code !== 'not-configured' && (
          <button type="button" autoFocus onClick={onRetry} className={cx(PRIMARY, 'h-9')}>
            Try again
          </button>
        )}
      </Footer>
    </>
  );
}

interface ProposedGroup {
  group: AiGroup;
  name: string;
  color: TabGroupColor;
  /** One of the person's folders (the AI's match, or the same name); else a new folder. */
  folder: FolderRecord | null;
  tabs: TabRecord[];
}

function Preview({ result, tabs, folders, onClose }: { result: OrganiseResult; tabs: TabRecord[]; folders: FolderRecord[]; onClose: () => void }) {
  const groups = useMemo<ProposedGroup[]>(() => {
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const byName = new Map(folders.map((f) => [f.name.trim().toLowerCase(), f]));
    return result.groups
      .map((g) => {
        const matchedId = g.folderId;
        const folder = (matchedId ? folders.find((f) => f.id === matchedId) : undefined) ?? byName.get(g.name.trim().toLowerCase()) ?? null;
        return {
          group: g,
          name: folder?.name ?? g.name,
          color: folder?.color ?? g.color,
          folder,
          tabs: g.tabIds.map((id) => byId.get(id)).filter((t): t is TabRecord => !!t).sort((a, b) => b.savedAt - a.savedAt),
        };
      })
      .filter((g) => g.tabs.length > 0);
  }, [result, tabs, folders]);
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(groups[0] ? [groups[0].name] : []));
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  const [applying, setApplying] = useState(false);

  // The AI's group as it came (with the folder it matched, when it did), minus the unticked tabs.
  const kept: AiGroup[] = groups
    .map((g) => ({ ...g.group, tabIds: g.tabs.filter((t) => !unticked.has(t.id)).map((t) => t.id) }))
    .filter((g) => g.tabIds.length > 0);
  const keptTabs = kept.reduce((n, g) => n + g.tabIds.length, 0);
  const keptIds = new Set(kept.flatMap((g) => g.tabIds));
  const rest = tabs.filter((t) => !keptIds.has(t.id)).sort((a, b) => b.savedAt - a.savedAt);

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const setTicked = (ids: string[], on: boolean) =>
    setUnticked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const apply = async () => {
    setApplying(true);
    try {
      const result = await send({ type: 'ai-apply', groups: kept });
      toast(`Put ${count(result.applied || keptTabs, 'tab')} into ${count(result.folders ?? kept.length, 'folder')}.`, { tone: 'success' });
      onClose();
    } catch (error) {
      toast(proErrorText(error), { tone: 'error' });
      setApplying(false);
    }
  };

  return (
    <>
      <div className="mx-6 flex items-center gap-2 rounded-control bg-bg-subtle px-3 py-2 text-small text-text-2">
        <ShieldCheck size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
        <span>
          Only titles and addresses were sent, never page content.
          {result.notSent > 0 && ` ${count(result.notSent, 'older or Incognito tab')} ${result.notSent === 1 ? 'wasn’t' : 'weren’t'} sent.`}
        </span>
      </div>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-6 py-3.5">
        {groups.length === 0 && (
          <p role="status" className="m-0 rounded-card border border-border bg-bg-subtle px-3.5 py-3 text-text-2">
            The AI didn’t find folders for these tabs. They stay where they are.
          </p>
        )}
        {groups.map((group) => {
          const on = group.tabs.filter((t) => !unticked.has(t.id)).length;
          const isOpen = expanded.has(group.name);
          const visible = showAll.has(group.name) ? group.tabs : group.tabs.slice(0, FIRST_ROWS);
          const panel = `org-${group.name}`;
          return (
            <section key={group.name} aria-label={group.name} className="shrink-0 overflow-hidden rounded-card border border-border bg-surface">
              <div className={cx('flex h-11 items-center gap-2.5 pl-3', isOpen && 'bg-bg-subtle')}>
                <Tick
                  checked={on === group.tabs.length}
                  mixed={on > 0 && on < group.tabs.length}
                  label={`Put these tabs in “${group.name}”`}
                  onChange={() => setTicked(group.tabs.map((t) => t.id), on < group.tabs.length)}
                />
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panel}
                  onClick={() => setExpanded((s) => toggle(s, group.name))}
                  className="flex h-full min-w-0 flex-1 items-center gap-2.5 pr-3 text-left focus-visible:outline-offset-[-2px]"
                >
                  <FolderIcon color={group.color} />
                  <span dir="auto" className="min-w-0 flex-1 truncate font-semibold">
                    {group.name}
                  </span>
                  {!group.folder && <Chip tone="neutral">new</Chip>}
                  {!isOpen && <FaviconStrip tabs={group.tabs} />}
                  <span className="shrink-0 text-small text-text-3 tabular-nums">{count(group.tabs.length, 'tab')}</span>
                  {isOpen ? (
                    <ChevronDown size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
                  ) : (
                    <ChevronRight size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
                  )}
                </button>
              </div>
              {isOpen && (
                <div id={panel} className="border-t border-border py-1">
                  {visible.map((tab) => {
                    const ticked = !unticked.has(tab.id);
                    return (
                      <label
                        key={tab.id}
                        className={cx('flex h-[34px] cursor-pointer items-center gap-2.5 px-3 hover:bg-hover', !ticked && 'text-text-3')}
                      >
                        <Tick checked={ticked} onChange={(v) => setTicked([tab.id], v)} />
                        <Favicon url={tab.url} size={16} />
                        <span dir="auto" className="min-w-0 flex-1 truncate">
                          {tab.title || tab.url}
                        </span>
                        <span className="max-w-[40%] shrink-0 truncate text-small text-text-3">{ticked ? displayHost(tab.url) : 'Stays where it is'}</span>
                      </label>
                    );
                  })}
                  {group.tabs.length > visible.length && (
                    <button
                      type="button"
                      onClick={() => setShowAll((s) => toggle(s, group.name))}
                      className="flex h-[30px] items-center pr-3 pl-16 text-small text-text-3 hover:text-text hover:underline"
                    >
                      Show {(group.tabs.length - visible.length).toLocaleString()} more
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {rest.length > 0 && <EverythingElse tabs={rest} />}
      </div>
      <Footer runs={`${runsLine(result.runs)} AI runs this month`}>
        <button type="button" onClick={onClose} className={cx(SECONDARY, 'h-9')}>
          Cancel
        </button>
        <button type="button" disabled={kept.length === 0 || applying} onClick={() => void apply()} className={cx(PRIMARY, 'h-9')}>
          {applying && <LoaderCircle size={16} aria-hidden className="tf-spin" />}
          Put them in folders
        </button>
      </Footer>
    </>
  );
}

/** The dashed "Everything else · stays where it is" row: what no folder gets. */
function EverythingElse({ tabs }: { tabs: TabRecord[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const visible = all ? tabs : tabs.slice(0, FIRST_ROWS);
  return (
    <section aria-label="Everything else" className="shrink-0 overflow-hidden rounded-card border border-dashed border-border-strong bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="org-rest"
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-full items-center gap-2.5 px-3 text-left focus-visible:outline-offset-[-2px]"
      >
        <span aria-hidden className="w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-text-2">Everything else · stays where it is</span>
        <span className="shrink-0 text-small text-text-3 tabular-nums">{count(tabs.length, 'tab')}</span>
        {open ? (
          <ChevronDown size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
        ) : (
          <ChevronRight size={16} strokeWidth={2} aria-hidden className="shrink-0 text-text-3" />
        )}
      </button>
      {open && (
        <div id="org-rest" className="border-t border-border py-1">
          {visible.map((tab) => (
            <div key={tab.id} className="flex h-[34px] items-center gap-2.5 px-3 text-text-2">
              <span aria-hidden className="w-4 shrink-0" />
              <Favicon url={tab.url} size={16} />
              <span dir="auto" className="min-w-0 flex-1 truncate">
                {tab.title || tab.url}
              </span>
              <span className="max-w-[40%] shrink-0 truncate text-small text-text-3">{displayHost(tab.url)}</span>
            </div>
          ))}
          {tabs.length > visible.length && (
            <button type="button" onClick={() => setAll(true)} className="flex h-[30px] items-center pr-3 pl-16 text-small text-text-3 hover:text-text hover:underline">
              Show {(tabs.length - visible.length).toLocaleString()} more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const EXAMPLES: Array<{ name: string; color: TabGroupColor }> = [
  { name: 'Checkout app', color: 'blue' },
  { name: 'Tabfold launch', color: 'purple' },
  { name: 'Holiday in Lisbon', color: 'yellow' },
];

/**
 * "Organise with AI · free plan" (Pro-States): what it does, the trial, and the plans. "Start 7-day
 * free trial" opens the email-code dialog over it (or starts the trial at once when signed in);
 * once the trial is on, the first run follows here.
 */
function Teaser({ onClose }: { onClose: () => void }) {
  const plan = usePlan();
  const configured = proConfigured();
  const offerTrial = !trialUsed(plan);
  const [busy, setBusy] = useState(false);

  const startTrial = async () => {
    setBusy(true);
    await startTrialFlow(plan);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2.5">
        <IconTile size={32} />
        <h1 id="org-h" className="m-0 flex-1 text-section font-semibold">
          Organise with AI
        </h1>
        <button type="button" aria-label="Close" title="Close" onClick={onClose} className={cx(CLOSE, '-mt-1 -mr-1')}>
          <X size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <p className="m-0 text-text-2">
        Pro AI puts your folded tabs into folders, like “Checkout app” or “Holiday in Lisbon”, not just by kind of site. You see the folders first
        and choose.
      </p>
      <div aria-hidden className="flex flex-wrap items-center gap-2">
        {EXAMPLES.map((p) => (
          <span key={p.name} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-small">
            <FolderIcon color={p.color} size={13} />
            {p.name}
          </span>
        ))}
      </div>
      {!configured && (
        <p role="status" className="m-0 flex items-center gap-2 text-small text-text-3">
          <Info size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
          Pro isn’t switched on in this build yet.
        </p>
      )}
      <div className="flex items-center gap-2.5">
        {offerTrial ? (
          <button type="button" autoFocus disabled={!configured || busy} onClick={() => void startTrial()} className={cx(PRIMARY, 'h-8 px-3 text-small')}>
            {busy && <LoaderCircle size={14} aria-hidden className="tf-spin" />}
            Start {TRIAL_DAYS}-day free trial
          </button>
        ) : (
          <button
            type="button"
            autoFocus
            onClick={() => {
              onClose();
              goToPlans();
            }}
            className={cx(PRIMARY, 'h-8 px-3 text-small')}
          >
            See plans
          </button>
        )}
        {offerTrial && (
          <a
            href="#/pro"
            onClick={(e) => {
              e.preventDefault();
              onClose();
              goToPlans();
            }}
            className="text-small font-semibold no-underline hover:underline"
          >
            See plans
          </a>
        )}
      </div>
      <p className="m-0 text-meta text-text-3">
        {offerTrial ? 'No card needed. ' : ''}Only titles and addresses are sent, never page content.
      </p>
    </div>
  );
}
