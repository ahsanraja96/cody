import { useRef, useState } from 'react';
import { LoaderCircle, Upload } from 'lucide-react';
import { refreshDataGuard } from '@/lib/dataGuard';
import { detectImportSource, type ImportResult, type ImportSource } from '@/lib/importers';
import { send } from '@/lib/messages';
import { saveCapture } from '@/lib/repo';
import { getDeviceId } from '@/lib/state';
import type { CapturedWindow } from '@/lib/types';
import { Button } from './components/Button';
import { Dialog } from './components/Dialog';

/**
 * Import from OneTab (Min-Settings › Your tabs, and the first-run list): paste OneTab's "Export
 * URLs" text or choose a file. OneTab text, Session Buddy backups and bookmark files are read in a
 * worker (a 50 MB export never freezes the page), lines that aren't addresses are skipped and
 * counted, and everything lands in the list grouped by kind of site.
 */

const NAMES: Record<ImportSource, string> = {
  onetab: 'Imported from OneTab',
  'session-buddy': 'Imported from Session Buddy',
  bookmarks: 'Imported bookmarks',
};

/** Tabs written per transaction, so a huge import shows progress and never holds one giant write. */
const CHUNK = 2000;

function parseInWorker(source: ImportSource, text: string): Promise<ImportResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../lib/importers/import.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ImportResult>) => {
      resolve(event.data);
      worker.terminate();
    };
    worker.onerror = () => {
      resolve({ sessions: [], tabCount: 0, skipped: 0 });
      worker.terminate();
    };
    worker.postMessage({ source, text });
  });
}

/** Everything the import found, as windows of one fold (a OneTab group or bookmark folder per window). */
function windowsOf(result: ImportResult): CapturedWindow[] {
  return result.sessions.flatMap((session) => session.windows.map((w) => ({ ...w, name: w.name || (result.sessions.length > 1 ? session.name : '') })));
}

async function writeImport(source: ImportSource, result: ImportResult, onProgress: (done: number) => void): Promise<number> {
  await send({ type: 'take-snapshot', reason: 'before-import' }).catch(() => undefined);
  const deviceId = await getDeviceId();
  const windows = windowsOf(result);
  let sessionId: string | null = null;
  let done = 0;
  let batch: CapturedWindow[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const saved = await saveCapture(
      batch,
      { name: NAMES[source], source: 'import', deviceId, now: Date.now() },
      { dedupe: false, targetSessionId: sessionId },
    );
    sessionId = saved.sessionId;
    done += saved.savedTabIds.length;
    batch = [];
    onProgress(done);
    await new Promise((r) => setTimeout(r, 0));
  };
  for (const window of windows) {
    batch.push(window);
    if (batch.reduce((n, w) => n + w.tabs.length, 0) >= CHUNK) await flush();
  }
  await flush();
  await refreshDataGuard().catch(() => undefined);
  return done;
}

type Step =
  | { kind: 'input'; error?: string }
  | { kind: 'reading' }
  | { kind: 'importing'; done: number; total: number }
  | { kind: 'done'; tabs: number; skipped: number; source: ImportSource };

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'input' });
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const close = () => {
    // Closed mid-import (Esc), the import finishes in the background and the result shows next time.
    if (step.kind !== 'reading' && step.kind !== 'importing') {
      setStep({ kind: 'input' });
      setText('');
    }
    onClose();
  };

  const run = async (input: string) => {
    if (!input.trim()) return;
    setStep({ kind: 'reading' });
    const source = detectImportSource(input);
    const result = await parseInWorker(source, input);
    if (result.tabCount === 0) {
      setStep({
        kind: 'input',
        error:
          source === 'onetab'
            ? 'No addresses found. In OneTab, choose “Export URLs” and copy all of its text.'
            : 'No tabs found in that file. Choose a OneTab export, a Session Buddy backup or a bookmarks file.',
      });
      return;
    }
    setStep({ kind: 'importing', done: 0, total: result.tabCount });
    try {
      const tabs = await writeImport(source, result, (done) => setStep({ kind: 'importing', done, total: result.tabCount }));
      setStep({ kind: 'done', tabs, skipped: result.skipped, source });
    } catch (error) {
      console.error('[tabfold] import failed', error);
      setStep({ kind: 'input', error: 'The import stopped partway. Try again; tabs already imported stay in your list.' });
    }
  };

  const readFile = async (file: File) => {
    if (/^(image|video|audio)\//.test(file.type) || /\.(pdf|zip|png|jpe?g|gif|webp|docx?|xlsx?)$/i.test(file.name)) {
      setStep({ kind: 'input', error: `${file.name} isn’t an export. Choose a .txt, .json or .html file.` });
      return;
    }
    await run(await file.text());
  };

  const busy = step.kind === 'reading' || step.kind === 'importing';

  let body;
  let footer;
  if (step.kind === 'done') {
    body = (
      <div role="status" className="flex flex-col gap-1">
        <p className="m-0 text-section font-semibold">Imported {step.tabs.toLocaleString()} {step.tabs === 1 ? 'tab' : 'tabs'}</p>
        <p className="m-0 text-text-2">
          They’re in your list, sorted by kind of site.
          {step.skipped > 0 &&
            ` ${step.skipped.toLocaleString()} ${step.skipped === 1 ? (step.source === 'onetab' ? 'line was' : 'entry was') : step.source === 'onetab' ? 'lines were' : 'entries were'} skipped because ${step.skipped === 1 ? 'it wasn’t a web address' : 'they weren’t web addresses'}.`}
        </p>
      </div>
    );
    footer = (
      <Button variant="primary" onClick={close} data-autofocus>
        Done
      </Button>
    );
  } else {
    body = (
      <>
        <p className="m-0 text-text-2">In OneTab, choose “Export URLs”, copy all the text and paste it here.</p>
        <textarea
          data-autofocus
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          aria-label="OneTab export text"
          placeholder="https://example.com | Example title"
          className="w-full resize-y rounded-control border border-border-strong bg-surface p-2.5 font-mono text-small outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-soft)] disabled:text-text-3"
        />
        <p className="m-0 text-small text-text-3">
          Or{' '}
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="font-semibold text-accent-text hover:underline">
            choose a file
          </button>
          : OneTab’s text, a Session Buddy backup or a bookmarks file. Nothing is uploaded.
        </p>
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
        <Button variant="ghost" disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !text.trim()} icon={<Upload size={14} aria-hidden />} onClick={() => void run(text)}>
          Import
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onClose={close} title="Import from OneTab" width={480} footer={footer}>
      {body}
    </Dialog>
  );
}
