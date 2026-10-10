import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { ArrowDown, ChevronRight } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ImportSource } from '@/lib/importers';
import { openLibrary } from '@/lib/openLibrary';
import { listLiveSessions } from '@/lib/repo';
import { Button } from '@/ui/components/Button';
import { Kbd } from '@/ui/components/Chips';
import { ProInfoHost } from '@/ui/components/ProDialog';
import { ToastViewport } from '@/ui/components/Toast';
import { ImportDialog, SourceTile } from '@/ui/ImportPanel';
import { cx } from '@/ui/cx';
import { isMac } from '@/ui/hooks';

function Steps({ step, onSkip }: { step: number; onSkip?: () => void }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-meta text-text-3">Step {step} of 3</span>
      <span aria-hidden className="flex gap-1">
        {[1, 2, 3].map((n) => (
          <span key={n} className={cx('h-1 w-[18px] rounded-sm', n <= step ? 'bg-accent' : 'bg-border-strong')} />
        ))}
      </span>
      <span className="flex-1" />
      {onSkip && (
        <button type="button" className="h-7 rounded-md px-2 text-text-2 hover:bg-hover hover:text-text" onClick={onSkip}>
          Skip
        </button>
      )}
    </div>
  );
}

function FoldIllustration() {
  const colors = ['#635BFF', '#1F2328', '#3ECF8E', '#FF0033', '#D97757'];
  return (
    <div aria-hidden className="relative h-[220px] overflow-hidden rounded-card border border-border bg-bg-subtle">
      <div className="absolute top-[34px] left-7 flex flex-col gap-1.5">
        {colors.map((color, i) => (
          <div
            key={color}
            className="tf-fold flex h-[26px] w-[150px] items-center gap-2 rounded-t-lg rounded-b-sm border border-border bg-surface px-2"
            style={{ transform: `translateX(${i * 10}px)`, opacity: 1 - i * 0.13, animationDelay: `${i * 90}ms` }}
          >
            <span className="size-3 rounded-[3px]" style={{ background: color }} />
            <span className="h-1.5 flex-1 rounded bg-hover" />
          </div>
        ))}
      </div>
      <svg width="40" height="24" viewBox="0 0 40 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="absolute top-[98px] left-[228px] text-accent">
        <path d="M2 12h34" />
        <path d="m28 4 8 8-8 8" />
      </svg>
      <div className="absolute top-14 right-6 flex w-[122px] flex-col gap-2 rounded-card border border-accent-line bg-surface p-3 shadow-pop">
        <span className="text-meta font-semibold">Oct 10 · 14:32</span>
        <span className="flex gap-[3px]">
          {colors.map((color) => (
            <span key={color} className="size-3 rounded-[3px]" style={{ background: color }} />
          ))}
        </span>
        <span className="text-meta text-text-3">47 tabs · 3 windows</span>
      </div>
      <span className="absolute top-[158px] right-6 inline-flex h-[22px] items-center rounded-full border border-green-line bg-green-soft px-2 text-meta font-semibold text-green">
        Freed ~2.1 GB
      </span>
    </div>
  );
}

function WindowsIllustration() {
  const windows: Array<[string, string[]]> = [
    ['Docs', ['80%', '60%', '70%']],
    ['Dashboards', ['70%', '85%', '50%']],
    ['AI chats', ['60%', '75%', '65%']],
  ];
  return (
    <div aria-hidden className="flex h-[220px] flex-col justify-center gap-3.5 rounded-card border border-border bg-bg-subtle p-5">
      <div className="flex gap-2.5">
        {windows.map(([name, widths]) => (
          <div key={name} className="flex-1 overflow-hidden rounded-control border border-border bg-surface">
            <div className="flex h-[22px] items-center gap-1 border-b border-border bg-hover px-2">
              <span className="size-1.5 rounded-full bg-border-strong" />
              <span className="size-1.5 rounded-full bg-border-strong" />
              <span className="ml-1.5 text-[10px] font-semibold text-text-2">{name}</span>
            </div>
            <div className="flex flex-col gap-1.5 p-2.5">
              {widths.map((width, i) => (
                <span key={i} className="h-1.5 rounded bg-hover" style={{ width }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <ArrowDown size={16} className="self-center text-accent" />
      <div className="flex flex-col gap-1.5 rounded-card border border-accent-line bg-surface px-3 py-2.5">
        <span className="text-meta font-semibold">Checkout app</span>
        <span className="flex flex-wrap gap-1.5">
          {['Docs · 9', 'Dashboards · 6', 'AI chats · 9'].map((label) => (
            <span key={label} className="inline-flex h-5 items-center rounded-full border border-border px-[7px] text-[10px] text-text-2">
              {label}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

/** Chrome gives "⇧⌘S" on a Mac and "Ctrl+Shift+S" elsewhere; the board shows "⌘⇧S". */
function prettyShortcut(shortcut: string): string {
  if (!isMac || shortcut.includes('+')) return shortcut;
  const order = ['⌃', '⌥', '⌘', '⇧'];
  const mods = [...shortcut].filter((c) => order.includes(c));
  const rest = [...shortcut].filter((c) => !order.includes(c)).join('');
  return `${mods.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('')}${rest}`;
}

export function Onboarding() {
  const [step, setStep] = useState(1);
  const [importSource, setImportSource] = useState<ImportSource | null>(null);
  const [saveShortcut, setSaveShortcut] = useState(isMac ? '⌘⇧S' : 'Ctrl+Shift+S');
  const imported = useLiveQuery(async () => (await listLiveSessions()).filter((s) => s.source === 'import').length, []) ?? 0;

  useEffect(() => {
    browser.commands
      .getAll()
      .then((commands) => {
        const shortcut = commands.find((c) => c.name === 'save-all')?.shortcut;
        if (shortcut) setSaveShortcut(prettyShortcut(shortcut));
      })
      .catch(() => undefined);
  }, []);

  const finish = async () => {
    await openLibrary();
    const tab = await browser.tabs.getCurrent();
    if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-subtle px-4 py-10">
      <main
        aria-label={`Step ${step} of 3`}
        className="flex min-h-[534px] w-full max-w-[480px] flex-col gap-4 rounded-card border border-border bg-bg p-6 shadow-pop"
      >
        <Steps step={step} onSkip={step < 3 ? finish : undefined} />

        {step === 1 && (
          <>
            <FoldIllustration />
            <h1 className="text-hero font-semibold">Save everything in one click</h1>
            <p className="text-text-2">
              Your tabs fold into a saved session and close, so Chrome gets its memory back. Pinned tabs stay open. Changed your mind? Undo
              for 10 seconds.
            </p>
            <p className="flex items-center gap-1.5 text-small text-text-3">
              Shortcut <Kbd className="h-5 rounded-[5px] px-1.5">{saveShortcut}</Kbd> from any tab
            </p>
            <span className="flex-1" />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setStep(2)}>
                Next
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <WindowsIllustration />
            <h1 className="text-hero font-semibold">Your windows stay separate</h1>
            <p className="text-text-2">
              Each window is saved as its own named group, with tab groups and pinned tabs. Restore brings back the same windows, and background
              tabs sleep until you click them.
            </p>
            <span className="flex-1" />
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button variant="primary" onClick={() => setStep(3)} autoFocus>
                Next
              </Button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="text-hero font-semibold">Bring your tabs with you</h1>
            <p className="text-text-2">Import what you already saved. Nothing is uploaded; it all stays on this device.</p>
            <div className="flex flex-col gap-2">
              {(
                [
                  { source: 'onetab', title: 'OneTab', hint: 'Paste the text from OneTab\'s "Export URLs"' },
                  { source: 'session-buddy', title: 'Session Buddy', hint: 'Choose its JSON backup file' },
                  { source: 'bookmarks', title: 'Chrome bookmarks', hint: 'Turn a bookmark folder into a session' },
                ] as const
              ).map((option) => (
                <button
                  key={option.source}
                  type="button"
                  onClick={() => setImportSource(option.source)}
                  className="flex h-[52px] items-center gap-3 rounded-card border border-border-strong bg-surface px-3.5 text-left hover:bg-hover"
                >
                  <SourceTile source={option.source} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{option.title}</span>
                    <span className="block truncate text-meta text-text-3">{option.hint}</span>
                  </span>
                  <ChevronRight size={16} aria-hidden className="shrink-0 text-text-3" />
                </button>
              ))}
            </div>
            {imported > 0 && (
              <p role="status" className="text-small text-green">
                {imported === 1 ? '1 session is ready in your library.' : `${imported.toLocaleString()} sessions are ready in your library.`}
              </p>
            )}
            <span className="flex-1" />
            <div className="flex justify-between">
              <Button variant="ghost" onClick={finish}>
                Skip for now
              </Button>
              <Button variant="primary" onClick={finish} autoFocus>
                Start using Tabfold
              </Button>
            </div>
          </>
        )}
      </main>
      <ImportDialog
        open={importSource !== null}
        initialSource={importSource ?? undefined}
        onClose={() => setImportSource(null)}
        onOpenSession={(id) => void openLibrary(`#/session/${encodeURIComponent(id)}`)}
      />
      <ToastViewport />
      <ProInfoHost />
    </div>
  );
}
