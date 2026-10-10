import { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import type { ImportResult, ImportSource } from '@/lib/importers';
import { send } from '@/lib/messages';
import { importSessions } from '@/lib/repo';
import { getDeviceId } from '@/lib/state';
import { plural } from '@/lib/format';
import { Banner } from './components/Banner';
import { Button } from './components/Button';
import { Segmented } from './components/Controls';

const SOURCES: Array<{ value: ImportSource; label: string; hint: string; accept?: string }> = [
  { value: 'onetab', label: 'OneTab', hint: 'In OneTab, choose "Export URLs", copy all the text and paste it here.' },
  { value: 'session-buddy', label: 'Session Buddy', hint: 'Choose a Session Buddy backup (.json).', accept: '.json,application/json' },
  {
    value: 'bookmarks',
    label: 'Bookmarks',
    hint: 'Export bookmarks from your browser (Bookmark manager › Export) and choose the .html file. Each folder becomes a session.',
    accept: '.html,.htm,text/html',
  },
];

/** Parse an import in a worker, so a huge file never freezes the page. */
function parseInWorker(source: ImportSource, text: string): Promise<ImportResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../lib/importers/import.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ImportResult>) => {
      resolve(event.data);
      worker.terminate();
    };
    worker.onerror = () => {
      resolve({ sessions: [], tabCount: 0, skipped: 1 });
      worker.terminate();
    };
    worker.postMessage({ source, text });
  });
}

export function ImportPanel({ onDone, initialSource = 'onetab' }: { onDone?: () => void; initialSource?: ImportSource }) {
  const [source, setSource] = useState<ImportSource>(initialSource);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'neutral'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const info = SOURCES.find((s) => s.value === source)!;

  const parse = async (input: string) => {
    setBusy(true);
    setMessage(null);
    const result = await parseInWorker(source, input);
    setParsed(result);
    setBusy(false);
    if (result.tabCount === 0) {
      setMessage({ tone: 'error', text: "We couldn't find any tabs in that. Check it's the right export and try again." });
    }
  };

  const runImport = async () => {
    if (!parsed || parsed.tabCount === 0) return;
    setBusy(true);
    try {
      await send({ type: 'take-snapshot', reason: 'before-import' }).catch(() => undefined);
      const done = await importSessions(parsed.sessions, await getDeviceId());
      const parts = [`Imported ${plural(done.sessions, 'session')} with ${plural(done.tabs, 'tab')}`];
      if (done.intoUnsorted) parts.push(`${done.intoUnsorted} more went into Unsorted (Free holds 50 named sessions)`);
      if (parsed.skipped) parts.push(`${plural(parsed.skipped, 'line')} skipped`);
      setMessage({ tone: 'success', text: `${parts.join(' · ')}.` });
      setParsed(null);
      setText('');
      onDone?.();
    } catch {
      setMessage({ tone: 'error', text: 'Import failed. Nothing was changed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
      <Segmented
        label="Import from"
        value={source}
        onChange={(v) => {
          setSource(v);
          setParsed(null);
          setMessage(null);
        }}
        options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
      />
      <p className="text-small text-text-2">{info.hint}</p>
      {source === 'onetab' ? (
        <>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setParsed(null);
            }}
            rows={6}
            aria-label="OneTab export text"
            placeholder="https://example.com | Example title"
            className="w-full resize-y rounded-control border border-border-strong bg-surface p-2.5 font-mono text-small outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={!text.trim() || busy} onClick={() => parse(text)}>
              Check
            </Button>
          </div>
        </>
      ) : (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept={info.accept}
            className="sr-only"
            aria-label={`Choose a ${info.label} file`}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) await parse(await file.text());
              e.target.value = '';
            }}
          />
          <Button size="sm" icon={<FileUp size={14} aria-hidden />} disabled={busy} onClick={() => fileRef.current?.click()}>
            Choose file
          </Button>
        </div>
      )}
      {busy && <p className="text-small text-text-3">Working…</p>}
      {parsed && parsed.tabCount > 0 && (
        <Banner
          tone="accent"
          icon={null}
          title={`Found ${plural(parsed.sessions.length, 'session')} with ${plural(parsed.tabCount, 'tab')}`}
          actions={
            <Button size="xs" variant="primary" disabled={busy} onClick={runImport}>
              Import
            </Button>
          }
        >
          {parsed.skipped > 0 ? `${plural(parsed.skipped, 'line')} couldn't be read and will be skipped.` : 'Everything looks good.'}
        </Banner>
      )}
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
    </div>
  );
}
