import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { ChevronLeft, LoaderCircle, Upload, X } from 'lucide-react';
import { FREE_LIMITS } from '@/lib/limits';
import type { ImportedSession } from '@/lib/importers';
import { Modal } from './components/Modal';
import { cx } from './cx';
import { hasFreeLimits, usePlan } from './hooks';
import { importCollections, listBookmarkFolders, parseInWorker, readBookmarkFolder, type BookmarkFolderInfo, type ImportOutcome } from './importRun';

/**
 * Import (Mx-Ask "Moving from another tab manager", Settings › Import…): OneTab, Toby, Workona,
 * Session Buddy, a Chrome bookmarks folder, or a list of links. Exports are read in a worker (a
 * 50 MB file never freezes the page) and nothing is uploaded. Collections and workspaces become
 * folders (Free: while it has room for them, the rest go by site); Free imports up to the
 * 500-tab limit and says what was left out.
 */

type SourceId = 'onetab' | 'toby' | 'workona' | 'session-buddy' | 'chrome' | 'links';

interface Source {
  id: SourceId;
  name: string;
  how: string;
  letter: string;
  color: string;
  /** What to do, on the next step. */
  help: string;
  paste: boolean;
  /** Collections become folders. OneTab groups and plain links have no names, so they go by site. */
  folders: boolean;
}

const SOURCES: Source[] = [
  { id: 'onetab', name: 'OneTab', how: 'Paste the export', letter: '1', color: '#2D7FF9', help: 'In OneTab, choose “Export URLs”, copy all the text and paste it here.', paste: true, folders: false },
  { id: 'toby', name: 'Toby', how: 'Its JSON file', letter: 'T', color: '#1BB2A6', help: 'In Toby, export your collections as JSON (Settings › Export), then choose the file.', paste: false, folders: true },
  { id: 'workona', name: 'Workona', how: 'Its export file', letter: 'W', color: '#6C4CF1', help: 'In Workona, export your workspaces, then choose the file.', paste: false, folders: true },
  { id: 'session-buddy', name: 'Session Buddy', how: 'Its JSON file', letter: 'S', color: '#444444', help: 'In Session Buddy, export your sessions as JSON, then choose the file.', paste: false, folders: true },
  { id: 'chrome', name: 'Chrome bookmarks', how: 'Pick a folder', letter: '★', color: '#F4B400', help: 'Pick a bookmarks folder. Its subfolders become folders too.', paste: false, folders: true },
  { id: 'links', name: 'A list of links', how: 'Paste or a file', letter: '↗', color: '#888888', help: 'Paste links, one per line. A title can follow after a space, or write [title](link).', paste: true, folders: false },
];

const NAMES: Record<SourceId, string> = {
  onetab: 'Imported from OneTab',
  toby: 'Imported from Toby',
  workona: 'Imported from Workona',
  'session-buddy': 'Imported from Session Buddy',
  chrome: 'Imported bookmarks',
  links: 'Imported links',
};

type Step =
  | { kind: 'pick' }
  | { kind: 'input'; source: Source; error?: string }
  | { kind: 'folders'; source: Source; folders: BookmarkFolderInfo[] | null; error?: string }
  | { kind: 'reading'; source: Source }
  | { kind: 'importing'; source: Source; done: number; total: number }
  | { kind: 'done'; source: Source; outcome: ImportOutcome; skipped: number };

const PRIMARY =
  'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover disabled:bg-hover disabled:text-text-3';
const GHOST = 'inline-flex h-9 shrink-0 items-center justify-center rounded-control px-3 text-text-2 hover:bg-hover hover:text-text disabled:text-text-3';

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "Imported 312 tabs into 4 folders · 2 collections went by site (Free has 3 folders) · 40 left out (free list full)". */
export function importSummary(o: ImportOutcome): { title: string; details: string[] } {
  const title = o.folders > 0 ? `Imported ${plural(o.tabs, 'tab')} into ${plural(o.folders, 'folder')}` : `Imported ${plural(o.tabs, 'tab')}`;
  const details: string[] = [];
  if (o.withoutFolder > 0) details.push(`${plural(o.withoutFolder, 'collection')} went by site (Free has ${FREE_LIMITS.folders} folders)`);
  if (o.skippedOverLimit > 0) details.push(`${o.skippedOverLimit.toLocaleString()} left out (free list full)`);
  if (o.duplicates > 0) details.push(`${plural(o.duplicates, 'page')} already in your list`);
  return { title, details };
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const plan = usePlan();
  const unlimited = !hasFreeLimits(plan);
  const titleId = useId();

  const busy = step.kind === 'reading' || step.kind === 'importing';

  // Each step starts on its field (or its first button), so keyboard people never land on the page.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || box.contains(document.activeElement)) return;
    (box.querySelector<HTMLElement>('[data-autofocus]') ?? box.querySelector<HTMLElement>('button, textarea, input'))?.focus();
  }, [step.kind]);

  const close = () => {
    // Closed mid-import (Esc), the import finishes in the background and the result shows next time.
    if (!busy) {
      setStep({ kind: 'pick' });
      setText('');
      setPicked(null);
    }
    onClose();
  };

  useEffect(() => {
    if (!open && !busy) setStep({ kind: 'pick' });
    // Only when it closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const write = async (source: Source, sessions: ImportedSession[], total: number, skipped: number) => {
    setStep({ kind: 'importing', source, done: 0, total });
    try {
      const outcome = await importCollections(sessions, {
        name: NAMES[source.id],
        asFolders: source.folders,
        unlimited,
        onProgress: (done) => setStep({ kind: 'importing', source, done, total }),
      });
      setStep({ kind: 'done', source, outcome, skipped });
    } catch (error) {
      console.error('[tabfold] import failed', error instanceof Error ? error.name : 'error');
      setStep({ kind: 'input', source, error: 'The import stopped partway. Try again; tabs already imported stay in your list.' });
    }
  };

  const run = async (source: Source, input: string) => {
    if (!input.trim()) return;
    setStep({ kind: 'reading', source });
    const { result } = await parseInWorker(input);
    if (result.tabCount === 0) {
      setStep({
        kind: 'input',
        source,
        error: source.id === 'onetab' ? 'No addresses found. In OneTab, choose “Export URLs” and copy all of its text.' : `No tabs found in that. ${source.help}`,
      });
      return;
    }
    await write(source, result.sessions, result.tabCount, result.skipped);
  };

  const readFile = async (source: Source, file: File) => {
    if (/^(image|video|audio)\//.test(file.type) || /\.(pdf|zip|png|jpe?g|gif|webp|docx?|xlsx?)$/i.test(file.name)) {
      setStep({ kind: 'input', source, error: `${file.name} isn’t an export. Choose a .txt, .json or .html file.` });
      return;
    }
    await run(source, await file.text());
  };

  const chooseSource = async (source: Source) => {
    if (source.id !== 'chrome') {
      setStep({ kind: 'input', source });
      return;
    }
    // Asked from the click: Chrome only shows its prompt for a user gesture.
    let granted = false;
    try {
      granted = await browser.permissions.request({ permissions: ['bookmarks'] });
    } catch {
      granted = false;
    }
    if (!granted) {
      setStep({ kind: 'folders', source, folders: [], error: 'Chrome didn’t let Tabfold read your bookmarks. Try again and choose Allow.' });
      return;
    }
    setStep({ kind: 'folders', source, folders: null });
    try {
      const folders = await listBookmarkFolders();
      setStep({ kind: 'folders', source, folders });
      setPicked(folders[0]?.id ?? null);
    } catch {
      setStep({ kind: 'folders', source, folders: [], error: 'Couldn’t read your bookmarks.' });
    }
  };

  const importFolder = async (source: Source, id: string) => {
    setStep({ kind: 'reading', source });
    try {
      const sessions = await readBookmarkFolder(id);
      const total = sessions.reduce((n, s) => n + s.windows.reduce((m, w) => m + w.tabs.length, 0), 0);
      if (total === 0) {
        setStep({ kind: 'folders', source, folders: await listBookmarkFolders(), error: 'That folder has no links.' });
        return;
      }
      await write(source, sessions, total, 0);
    } catch {
      setStep({ kind: 'folders', source, folders: [], error: 'Couldn’t read that folder.' });
    }
  };

  let body: ReactNode;
  let footer: ReactNode = null;
  let title = 'Bring your tabs from…';
  const back = (
    <button type="button" disabled={busy} onClick={() => setStep({ kind: 'pick' })} className="-ml-1 inline-flex items-center gap-1 self-start text-small font-semibold text-text-2 hover:text-text">
      <ChevronLeft size={14} strokeWidth={2} aria-hidden />
      Other sources
    </button>
  );

  if (step.kind === 'pick') {
    body = (
      <>
        <div className="grid grid-cols-2 gap-2 max-[480px]:grid-cols-1">
          {SOURCES.map((source, index) => (
            <button
              key={source.id}
              type="button"
              data-autofocus={index === 0 ? true : undefined}
              onClick={() => void chooseSource(source)}
              className="flex h-[52px] items-center gap-2.5 rounded-card border border-border-strong bg-surface px-3 text-left hover:bg-hover"
            >
              <span aria-hidden className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-small font-semibold text-white" style={{ background: source.color }}>
                {source.letter}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold">{source.name}</span>
                <span className="block text-meta text-text-3">{source.how}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="m-0 text-small text-text-3">
          Collections and workspaces become folders.{unlimited ? '' : ` Free imports up to the ${FREE_LIMITS.tabs}-tab limit.`} Nothing is uploaded.
        </p>
      </>
    );
  } else if (step.kind === 'done') {
    const { title: line, details } = importSummary(step.outcome);
    title = `From ${step.source.name}`;
    body = (
      <div role="status" className="flex flex-col gap-1">
        <p className="m-0 text-section font-semibold">{line}</p>
        {details.length > 0 && <p className="m-0 text-text-2">{details.join(' · ')}</p>}
        <p className="m-0 text-text-2">
          {step.outcome.folders > 0 ? 'Your folders are at the top of the list; the rest are sorted by kind of site.' : 'They’re in your list, sorted by kind of site.'}
          {step.skipped > 0 && ` ${plural(step.skipped, 'entry', 'entries')} weren’t web addresses and were skipped.`}
        </p>
      </div>
    );
    footer = (
      <button type="button" data-autofocus onClick={close} className={PRIMARY}>
        Done
      </button>
    );
  } else if (step.kind === 'folders') {
    title = 'From Chrome bookmarks';
    body = (
      <>
        {back}
        <p className="m-0 text-text-2">{step.source.help}</p>
        {step.folders === null ? (
          <p role="status" className="m-0 inline-flex items-center gap-2 text-small text-text-2">
            <LoaderCircle size={14} aria-hidden className="tf-spin" />
            Reading your bookmarks…
          </p>
        ) : (
          step.folders.length > 0 && (
            <div role="radiogroup" aria-label="Bookmarks folder" className="scroll-thin flex max-h-[280px] flex-col gap-0.5 overflow-y-auto rounded-card border border-border p-1">
              {step.folders.map((folder) => (
                <label key={folder.id} className="flex h-9 cursor-pointer items-center gap-2.5 rounded-control px-2.5 hover:bg-hover has-[:focus-visible]:bg-hover">
                  <input type="radio" name="bm-folder" checked={picked === folder.id} onChange={() => setPicked(folder.id)} className="accent-[var(--tf-accent)]" />
                  <span dir="auto" className="min-w-0 flex-1 truncate">
                    {folder.path}
                  </span>
                  <span className="shrink-0 text-small text-text-3 tabular-nums">{plural(folder.count, 'link')}</span>
                </label>
              ))}
            </div>
          )
        )}
        {step.error && (
          <p role="alert" className="m-0 text-small text-red">
            {step.error}
          </p>
        )}
      </>
    );
    footer = (
      <>
        <button type="button" onClick={close} className={GHOST}>
          Cancel
        </button>
        {step.folders && step.folders.length === 0 ? (
          <button type="button" onClick={() => void chooseSource(step.source)} className={PRIMARY}>
            Try again
          </button>
        ) : (
          <button type="button" disabled={!picked || !step.folders} onClick={() => picked && void importFolder(step.source, picked)} className={PRIMARY}>
            <Upload size={14} aria-hidden />
            Import
          </button>
        )}
      </>
    );
  } else {
    const source = step.source;
    title = `From ${source.name}`;
    body = (
      <>
        {back}
        <p className="m-0 text-text-2">{source.help}</p>
        {source.paste && (
          <textarea
            data-autofocus
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            aria-label={source.id === 'onetab' ? 'OneTab export text' : 'Links, one per line'}
            placeholder={source.id === 'onetab' ? 'https://example.com | Example title' : 'https://example.com Example title'}
            className="w-full resize-y rounded-control border border-border-strong bg-surface p-2.5 font-mono text-small outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-soft)] disabled:text-text-3"
          />
        )}
        <p className="m-0 text-small text-text-3">
          {source.paste ? 'Or ' : ''}
          <button
            type="button"
            data-autofocus={source.paste ? undefined : true}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className={cx('font-semibold text-accent-text hover:underline', !source.paste && 'text-body')}
          >
            {source.paste ? 'choose a file' : 'Choose the file…'}
          </button>
          {source.paste ? '. Nothing is uploaded.' : ' Nothing is uploaded.'}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.json,.html,.htm,.md,.csv,text/plain,application/json,text/html,text/markdown,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) await readFile(source, file);
          }}
        />
        {step.kind === 'input' && step.error && (
          <p role="alert" className="m-0 text-small text-red">
            {step.error}
          </p>
        )}
        {busy && (
          <p role="status" className="m-0 inline-flex items-center gap-2 text-small text-text-2">
            <LoaderCircle size={14} aria-hidden className="tf-spin" />
            {step.kind === 'importing' ? `Importing ${step.done.toLocaleString()} of ${step.total.toLocaleString()} tabs…` : 'Reading…'}
          </p>
        )}
      </>
    );
    footer = (
      <>
        <button type="button" disabled={busy} onClick={close} className={GHOST}>
          Cancel
        </button>
        {source.paste && (
          <button type="button" disabled={busy || !text.trim()} onClick={() => void run(source, text)} className={PRIMARY}>
            <Upload size={14} aria-hidden />
            Import
          </button>
        )}
      </>
    );
  }

  return (
    <Modal open={open} onClose={close} labelledBy={titleId} width={step.kind === 'pick' ? 470 : 480}>
      <div ref={boxRef} className="flex flex-col gap-3 px-[22px] pt-5 pb-5">
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="m-0 min-w-0 flex-1 text-[17px] font-semibold">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={close}
            className="-mt-1 -mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
          >
            <X size={18} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        {body}
        {footer && <div className="mt-1 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </Modal>
  );
}
