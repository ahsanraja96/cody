import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Bookmark, Check, ChevronDown, CircleAlert, Copy, Inbox, ShieldCheck, Upload, X } from 'lucide-react';
import type { ParseRequest, ParseResponse } from '@/entrypoints/library/flows/importParse.worker';
import { refreshDataGuard } from '@/lib/dataGuard';
import { plural } from '@/lib/format';
import type { ImportedSession, ImportSource } from '@/lib/importers';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { send } from '@/lib/messages';
import { openLibrary } from '@/lib/openLibrary';
import { countNamedSessions, deleteSessionsForever, listLiveSessions, removeTabs, saveCapture } from '@/lib/repo';
import { getDeviceId } from '@/lib/state';
import type { CapturedWindow } from '@/lib/types';
import { Button, IconButton } from './components/Button';
import { Checkbox } from './components/Controls';
import { showProInfo } from './components/ProDialog';
import { toast } from './components/Toast';
import { cx } from './cx';
import { copyText } from './hooks';

/**
 * Import from OneTab, Session Buddy and browser bookmarks (Library-Import): choose or drop a file
 * (the format is read from its contents) or paste OneTab's text, preview with the Free-limit note,
 * import with progress and Cancel, then results with any skipped lines. Parsing runs in a worker.
 * Nothing is written until Import; Cancel removes what the import added so far, and a safety
 * snapshot is taken first.
 */

const SOURCE_INFO: Record<ImportSource, { label: string; noun: string; skippedNoun: string; mergedName: string }> = {
  onetab: { label: 'OneTab export', noun: 'group', skippedNoun: 'line', mergedName: 'OneTab import' },
  'session-buddy': { label: 'Session Buddy backup', noun: 'session', skippedNoun: 'tab', mergedName: 'Session Buddy import' },
  bookmarks: { label: 'Bookmarks file', noun: 'folder', skippedNoun: 'bookmark', mergedName: 'Bookmarks import' },
};

export function SourceTile({ source, size = 28 }: { source: ImportSource; size?: number }) {
  const style = { width: size, height: size };
  if (source === 'bookmarks') {
    return (
      <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-[7px] border border-border bg-hover text-text-2" style={style}>
        <Bookmark size={14} strokeWidth={2} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-[7px] text-small font-semibold text-white"
      style={{ ...style, background: source === 'onetab' ? '#2F80ED' : '#3B82F6' }}
    >
      {source === 'onetab' ? '1' : 'S'}
    </span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseInWorker(request: ParseRequest): Promise<ParseResponse> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../entrypoints/library/flows/importParse.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      resolve(event.data);
      worker.terminate();
    };
    worker.onerror = () => {
      resolve({ source: request.source ?? 'onetab', result: { sessions: [], tabCount: 0, skipped: 0 }, skippedLines: [] });
      worker.terminate();
    };
    worker.postMessage(request);
  });
}

interface Parsed extends ParseResponse {
  fileName: string | null;
  size: number;
}

interface Outcome {
  tabs: number;
  sessions: number;
  unsortedId: string | null;
  snapshot: boolean;
  parsed: Parsed;
}

type Step =
  | { kind: 'choose' }
  | { kind: 'paste' }
  | { kind: 'reading'; fileName: string | null }
  | { kind: 'preview'; parsed: Parsed; error?: string }
  | { kind: 'importing'; parsed: Parsed; done: number; total: number; snapshot: boolean }
  | { kind: 'results'; outcome: Outcome }
  | { kind: 'failed'; fileName: string | null };

const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One OneTab group or bookmarks folder per window when merged; Session Buddy keeps its windows. */
function mergeAll(parsed: Parsed): ImportedSession {
  const windows: CapturedWindow[] =
    parsed.source === 'session-buddy'
      ? parsed.result.sessions.flatMap((s) => s.windows)
      : [{ name: '', focused: false, bounds: null, state: null, tabs: parsed.result.sessions.flatMap((s) => s.windows.flatMap((w) => w.tabs)) }];
  return { name: SOURCE_INFO[parsed.source].mergedName, createdAt: null, windows };
}

export function ImportPanel({
  onDone,
  initialSource,
  onOpenSession,
  className,
}: {
  /** Called when the user finishes (Done), cancels or closes. */
  onDone?: () => void;
  /** Start in OneTab's paste step (or, for files, just show the drop zone). */
  initialSource?: ImportSource;
  /** "Open Unsorted": defaults to the library's session detail. */
  onOpenSession?: (sessionId: string) => void;
  className?: string;
}) {
  const [step, setStep] = useState<Step>(initialSource === 'onetab' ? { kind: 'paste' } : { kind: 'choose' });
  const [pasted, setPasted] = useState('');
  const [eachGroup, setEachGroup] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [showSkipped, setShowSkipped] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const named = useLiveQuery(() => countNamedSessions(), []) ?? 0;
  const limit = limitsFor(CURRENT_PLAN).namedSessions;

  const readText = async (text: string, fileName: string | null, size: number, source?: ImportSource) => {
    setStep({ kind: 'reading', fileName });
    const response = await parseInWorker({ text, source });
    if (response.result.tabCount === 0) {
      setStep({ kind: 'failed', fileName });
      return;
    }
    setEachGroup(true);
    setStep({ kind: 'preview', parsed: { ...response, fileName, size } });
  };

  const readFile = async (file: File) => {
    // Binary files (PDFs, images) are never an export; skip reading megabytes of them.
    if (/^(image|video|audio)\//.test(file.type) || /\.(pdf|zip|png|jpe?g|gif|webp|docx?|xlsx?)$/i.test(file.name)) {
      setStep({ kind: 'failed', fileName: file.name });
      return;
    }
    await readText(await file.text(), file.name, file.size);
  };

  const close = () => {
    if (step.kind === 'importing') {
      cancelRef.current = true;
      return;
    }
    onDone?.();
  };

  const runImport = async (parsed: Parsed) => {
    cancelRef.current = false;
    const groups = eachGroup ? parsed.result.sessions : [mergeAll(parsed)];
    const total = parsed.result.tabCount;
    setStep({ kind: 'importing', parsed, done: 0, total, snapshot: false });
    const snapshot = await send({ type: 'take-snapshot', reason: 'before-import' })
      .then((r) => r.snapshotId !== null)
      .catch(() => false);
    setStep({ kind: 'importing', parsed, done: 0, total, snapshot });

    const deviceId = await getDeviceId();
    const existingUnsorted = (await listLiveSessions()).find((s) => s.kind === 'unsorted')?.id ?? null;
    const created: string[] = [];
    const unsortedTabs: string[] = [];
    let unsortedId: string | null = null;
    let done = 0;
    let failed = false;
    try {
      for (const group of groups) {
        if (cancelRef.current) break;
        const result = await saveCapture(
          group.windows,
          { name: group.name, source: 'import', deviceId, now: group.createdAt ?? Date.now() },
          { dedupe: false },
        );
        if (result.createdSession) created.push(result.sessionId);
        else {
          unsortedId = result.sessionId;
          unsortedTabs.push(...result.savedTabIds);
        }
        done += group.windows.reduce((n, w) => n + w.tabs.length, 0);
        setStep({ kind: 'importing', parsed, done, total, snapshot });
        await yieldToPage();
      }
    } catch (error) {
      console.error('[tabfold] import failed', error);
      failed = true;
    }

    if (cancelRef.current || failed) {
      // Take back everything this import added; the snapshot is a second safety net.
      try {
        if (created.length) await deleteSessionsForever(created);
        if (unsortedTabs.length) await removeTabs(unsortedTabs);
        if (unsortedId && !existingUnsorted) await deleteSessionsForever([unsortedId]);
      } catch (error) {
        console.error('[tabfold] import rollback failed', error);
      }
      if (failed) {
        setStep({ kind: 'preview', parsed, error: 'Import failed. Nothing was added.' });
      } else {
        toast('Import cancelled. Nothing was added.');
        onDone?.();
      }
      return;
    }
    await refreshDataGuard().catch(() => undefined);
    setShowSkipped(true);
    setStep({
      kind: 'results',
      outcome: { tabs: done, sessions: created.length, unsortedId: unsortedTabs.length ? unsortedId : null, snapshot, parsed },
    });
  };

  // Paste anywhere in the first step: OneTab's export text, or a whole JSON/HTML export.
  const onPaste = (e: React.ClipboardEvent) => {
    if (step.kind !== 'choose') return;
    const text = e.clipboardData.getData('text/plain');
    if (!text.trim()) return;
    e.preventDefault();
    void readText(text, null, new Blob([text]).size);
  };

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept=".txt,.json,.html,.htm,text/plain,application/json,text/html"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      onChange={async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) await readFile(file);
      }}
    />
  );
  const choose = () => fileRef.current?.click();

  let body: ReactNode;
  let footer: ReactNode = null;

  switch (step.kind) {
    case 'choose':
      body = (
        <>
          <p className="text-text-2">Nothing is uploaded. Everything stays on this device.</p>
          <div
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) await readFile(file);
            }}
            className={cx(
              'flex flex-col items-center gap-2 rounded-card border border-dashed px-4 py-6 text-center transition-colors duration-150',
              dragging ? 'border-accent bg-accent-soft' : 'border-border-strong bg-bg-subtle',
            )}
          >
            <span aria-hidden className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-text-2">
              <Upload size={18} />
            </span>
            <div className="font-semibold">
              Drop a file here or{' '}
              <button type="button" onClick={choose} className="font-semibold text-accent-text hover:underline">
                choose one
              </button>
            </div>
            <div className="text-meta text-text-3">.txt, .json or .html · we work out which app it came from</div>
          </div>
          <div className="grid grid-cols-1 gap-2 min-[440px]:grid-cols-3">
            {(
              [
                ['onetab', 'OneTab', "Paste or drop OneTab's export text"],
                ['session-buddy', 'Session Buddy', 'Its JSON backup file'],
                ['bookmarks', 'Bookmarks', "An HTML file from Chrome's bookmark manager"],
              ] as const
            ).map(([source, title, hint]) => (
              <button
                key={source}
                type="button"
                onClick={() => (source === 'onetab' ? setStep({ kind: 'paste' }) : choose())}
                className="flex flex-col items-start gap-2 rounded-card border border-border-strong bg-surface p-3 text-left hover:bg-hover"
              >
                <SourceTile source={source} />
                <span className="font-semibold">{title}</span>
                <span className="text-meta text-text-3">{hint}</span>
              </button>
            ))}
          </div>
        </>
      );
      footer = <Button onClick={close}>Cancel</Button>;
      break;

    case 'paste':
      body = (
        <>
          <p className="text-text-2">In OneTab, choose "Export URLs", copy all the text and paste it here.</p>
          <textarea
            autoFocus
            data-autofocus
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={7}
            aria-label="OneTab export text"
            placeholder="https://example.com | Example title"
            className="w-full resize-y rounded-control border border-border-strong bg-surface p-2.5 font-mono text-small outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-soft)]"
          />
        </>
      );
      footer = (
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => setStep({ kind: 'choose' })}>
            Back
          </Button>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!pasted.trim()} onClick={() => readText(pasted, null, new Blob([pasted]).size, 'onetab')}>
            Continue
          </Button>
        </>
      );
      break;

    case 'reading':
      body = (
        <div role="status" className="flex flex-col gap-2.5 rounded-card border border-border px-4 py-3.5">
          <span className="font-semibold">Reading {step.fileName ?? 'the text'}…</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-border">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
          </div>
        </div>
      );
      footer = <Button onClick={() => setStep({ kind: 'choose' })}>Cancel</Button>;
      break;

    case 'preview': {
      const { parsed } = step;
      const info = SOURCE_INFO[parsed.source];
      const groupCount = parsed.result.sessions.length;
      const groups = eachGroup ? groupCount : 1;
      const remaining = Math.max(0, limit - named);
      const asSessions = Math.min(groups, remaining);
      const overflow = Number.isFinite(limit) ? groups - asSessions : 0;
      body = (
        <>
          <div className="flex items-center gap-3 rounded-card border border-border p-3">
            <SourceTile source={parsed.source} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                {info.label} · {plural(parsed.result.tabCount, 'tab')} in {plural(groupCount, info.noun)}
              </div>
              <div className="truncate text-meta text-text-3">
                {parsed.fileName ?? 'Pasted text'} · {formatSize(parsed.size)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setStep({ kind: 'choose' })}
              className="h-7 shrink-0 rounded-md px-2 text-small text-text-2 hover:bg-hover hover:text-text"
            >
              Change
            </button>
          </div>
          {groupCount > 1 && (
            <label className="flex cursor-pointer items-start gap-2.5">
              <span className="mt-px">
                <Checkbox checked={eachGroup} onChange={setEachGroup} />
              </span>
              <span>
                <span className="block">
                  {parsed.source === 'session-buddy' ? 'Each saved session stays a session' : `Each ${info.noun} becomes a session`}
                </span>
                <span className="block text-meta text-text-3">Off puts all {plural(parsed.result.tabCount, 'tab')} in one session.</span>
              </span>
            </label>
          )}
          {overflow > 0 && (
            <div role="note" className="flex flex-col gap-2 rounded-card border border-border-strong bg-bg-subtle px-3.5 py-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-[22px] items-center rounded-full border border-border-strong px-2 text-meta font-semibold text-text-2">
                  {Math.min(named, limit)} of {limit}
                </span>
                <span className="font-semibold">Free plan</span>
              </div>
              <p className="text-text-2">
                You have {named} of {limit} sessions.{' '}
                {asSessions === 0
                  ? `${groups === 1 ? `The ${info.noun} goes` : `All ${groups} ${info.noun}s go`} into Unsorted.`
                  : `The first ${asSessions} ${asSessions === 1 ? `${info.noun} becomes a session` : `${info.noun}s become sessions`}; the other ${overflow} ${overflow === 1 ? 'goes' : 'go'} into Unsorted.`}{' '}
                Nothing is left out.
              </p>
              <button type="button" onClick={() => showProInfo()} className="self-start text-small font-semibold text-accent-text hover:underline">
                See what Pro adds
              </button>
            </div>
          )}
          {step.error && (
            <p role="alert" className="flex items-center gap-2 text-small text-red">
              <CircleAlert size={14} aria-hidden />
              {step.error}
            </p>
          )}
        </>
      );
      footer = (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" autoFocus onClick={() => runImport(parsed)}>
            Import {plural(parsed.result.tabCount, 'tab')}
          </Button>
        </>
      );
      break;
    }

    case 'importing': {
      const pct = step.total ? Math.round((step.done / step.total) * 100) : 0;
      body = (
        <div role="status" className="flex flex-col gap-2.5 rounded-card border border-border px-4 py-3.5">
          <div className="flex items-baseline gap-3">
            <span className="flex-1 font-semibold">Importing…</span>
            <span className="text-text-2">
              {step.done.toLocaleString()} of {step.total.toLocaleString()}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Tabs imported"
            aria-valuemin={0}
            aria-valuemax={step.total}
            aria-valuenow={step.done}
            className="h-1.5 overflow-hidden rounded-full bg-border"
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
          </div>
          {step.snapshot && (
            <div className="flex items-center gap-1.5 text-small text-text-2">
              <ShieldCheck size={14} aria-hidden className="shrink-0 text-green" />A safety snapshot was saved first.
            </div>
          )}
        </div>
      );
      footer = <Button onClick={() => (cancelRef.current = true)}>Cancel</Button>;
      break;
    }

    case 'results': {
      const { outcome } = step;
      const { parsed } = outcome;
      const skipped = parsed.result.skipped;
      const lines = parsed.skippedLines;
      const noun = SOURCE_INFO[parsed.source].skippedNoun;
      const into = [
        outcome.sessions > 0 ? plural(outcome.sessions, 'session') : '',
        outcome.unsortedId ? 'Unsorted' : '',
      ]
        .filter(Boolean)
        .join(' and ');
      body = (
        <>
          <div role="status" className="flex items-start gap-2.5 rounded-card border border-green-line bg-green-soft px-3.5 py-3 text-green">
            <Check size={16} strokeWidth={2} aria-hidden className="mt-px shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                Imported {plural(outcome.tabs, 'tab')} into {into || 'your library'}
              </div>
              {outcome.snapshot && <div className="text-small text-text-2">A snapshot from before the import is in Snapshots.</div>}
            </div>
          </div>
          {skipped > 0 && (
            <div role="alert" className="overflow-hidden rounded-card border border-amber-line bg-amber-soft">
              <div className="flex items-center gap-2.5 py-2.5 pr-2 pl-3.5">
                <AlertTriangle size={16} aria-hidden className="shrink-0 text-amber" />
                <span className="flex-1 font-semibold text-amber">
                  {plural(skipped, noun)} skipped (not web addresses)
                </span>
                {lines.length > 0 && (
                  <IconButton
                    label={showSkipped ? `Hide skipped ${noun}s` : `Show skipped ${noun}s`}
                    aria-expanded={showSkipped}
                    onClick={() => setShowSkipped((v) => !v)}
                    className="text-amber hover:text-amber"
                  >
                    <ChevronDown size={16} strokeWidth={2} aria-hidden className={cx('transition-transform duration-150', showSkipped && 'rotate-180')} />
                  </IconButton>
                )}
              </div>
              {lines.length > 0 && showSkipped && (
                <div className="border-t border-amber-line bg-surface">
                  <div className="py-1.5">
                    {lines.slice(0, 3).map((line, index) => (
                      <div key={index} className="flex h-[30px] items-center px-3.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-small" dir="auto" title={line}>
                          {line}
                        </span>
                      </div>
                    ))}
                    {skipped > 3 && (
                      <div className="flex h-6 items-center px-3.5 text-meta text-text-3">and {(skipped - Math.min(3, lines.length)).toLocaleString()} more</div>
                    )}
                  </div>
                  <div className="flex gap-2 border-t border-border px-3.5 py-2.5">
                    <Button
                      size="xs"
                      icon={<Copy size={14} aria-hidden />}
                      onClick={async () => {
                        if (await copyText(lines.join('\n'))) toast(`Copied ${plural(lines.length, `skipped ${noun}`)}.`);
                      }}
                    >
                      Copy skipped {noun}s
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      );
      footer = (
        <>
          {outcome.unsortedId && (
            <Button
              icon={<Inbox size={16} aria-hidden />}
              onClick={() => {
                const id = outcome.unsortedId!;
                onDone?.();
                if (onOpenSession) onOpenSession(id);
                else void openLibrary(`#/session/${encodeURIComponent(id)}`);
              }}
            >
              Open Unsorted
            </Button>
          )}
          <Button variant="primary" autoFocus onClick={() => onDone?.()}>
            Done
          </Button>
        </>
      );
      break;
    }

    case 'failed':
      body = (
        <div role="alert" className="flex items-start gap-2.5 rounded-card border border-red-line bg-red-soft px-3.5 py-3">
          <CircleAlert size={16} aria-hidden className="mt-px shrink-0 text-red" />
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <div>
              <div className="font-semibold text-red">
                {step.fileName ? "This file isn't a OneTab, Session Buddy or bookmarks export" : "We couldn't find any tabs in that text"}
              </div>
              <div className="text-small text-text-2" dir="auto">
                {step.fileName ?? 'Pasted text'} · nothing was imported.
              </div>
            </div>
            <div>
              {step.fileName ? (
                <Button size="xs" icon={<Upload size={14} aria-hidden />} onClick={choose}>
                  Choose another file
                </Button>
              ) : (
                <Button size="xs" onClick={() => setStep({ kind: 'paste' })}>
                  Paste again
                </Button>
              )}
            </div>
          </div>
        </div>
      );
      footer = null;
      break;
  }

  return (
    <div
      onPaste={onPaste}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onDone) {
          // Escape cancels a running import (which then closes), otherwise closes.
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
      className={cx('flex flex-col gap-3', className)}
    >
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="min-w-0 flex-1 text-section font-semibold">Import tabs</h2>
        {onDone && (
          <IconButton label={step.kind === 'importing' ? 'Cancel import' : 'Close'} onClick={close} className="-mr-1.5">
            <X size={16} aria-hidden />
          </IconButton>
        )}
      </div>
      {body}
      {footer && <div className="mt-1 flex flex-wrap items-center justify-end gap-2">{footer}</div>}
      {fileInput}
    </div>
  );
}

/** The import as a modal dialog (library, onboarding). Escape or the close button cancels a running import. */
export function ImportDialog({
  open,
  onClose,
  initialSource,
  onOpenSession,
}: {
  open: boolean;
  onClose: () => void;
  initialSource?: ImportSource;
  onOpenSession?: (sessionId: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // showModal focuses the first control (the close button); the paste box should have it.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label="Import tabs"
      onCancel={(e) => {
        // The panel decides: Escape while importing cancels the import instead of closing.
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
      className="m-auto max-h-[calc(100vh-48px)] overflow-y-auto rounded-card border border-border bg-surface p-0 text-text shadow-pop"
      style={{ width: 'min(480px, calc(100vw - 32px))' }}
    >
      {open && <ImportPanel className="px-5 pt-[18px] pb-5" onDone={onClose} initialSource={initialSource} onOpenSession={onOpenSession} />}
    </dialog>
  );
}
