import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { openLibrary } from '@/lib/openLibrary';
import { Button } from '@/ui/components/Button';
import { Kbd } from '@/ui/components/Chips';
import { Logo } from '@/ui/components/Logo';
import { ImportPanel } from '@/ui/ImportPanel';
import { cx } from '@/ui/cx';
import type { ImportSource } from '@/lib/importers';

function Steps({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-meta text-text-3">Step {step} of 3</span>
      <span aria-hidden className="flex gap-1">
        {[1, 2, 3].map((n) => (
          <span key={n} className={cx('h-1 w-[18px] rounded-sm', n <= step ? 'bg-accent' : 'bg-border-strong')} />
        ))}
      </span>
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
  return (
    <div aria-hidden className="flex h-[220px] flex-col justify-center gap-3.5 rounded-card border border-border bg-bg-subtle p-5">
      <div className="flex gap-2.5">
        {['Docs', 'Dashboards', 'AI chats'].map((name) => (
          <div key={name} className="flex-1 overflow-hidden rounded-control border border-border bg-surface">
            <div className="flex h-[22px] items-center gap-1 border-b border-border bg-hover px-2">
              <span className="size-1.5 rounded-full bg-border-strong" />
              <span className="size-1.5 rounded-full bg-border-strong" />
              <span className="ml-1.5 text-[10px] font-semibold text-text-2">{name}</span>
            </div>
            <div className="flex flex-col gap-1.5 p-2.5">
              <span className="h-1.5 w-4/5 rounded bg-hover" />
              <span className="h-1.5 w-3/5 rounded bg-hover" />
              <span className="h-1.5 w-2/3 rounded bg-hover" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 rounded-card border border-accent-line bg-surface px-3 py-2.5">
        <span className="text-meta font-semibold">Checkout app</span>
        <span className="flex flex-wrap gap-1.5">
          {['Docs · 9', 'Dashboards · 6', 'AI chats · 9'].map((label) => (
            <span key={label} className="inline-flex h-5 items-center rounded-full border border-border px-2 text-[10px] text-text-2">
              {label}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

export function Onboarding() {
  const [step, setStep] = useState(1);
  const [importSource, setImportSource] = useState<ImportSource | null>(null);
  const [saveShortcut, setSaveShortcut] = useState('Ctrl+Shift+S');

  useEffect(() => {
    browser.commands
      .getAll()
      .then((commands) => {
        const shortcut = commands.find((c) => c.name === 'save-all')?.shortcut;
        if (shortcut) setSaveShortcut(shortcut);
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
      <main className="flex w-full max-w-[480px] flex-col gap-4 rounded-card border border-border bg-bg p-6 shadow-pop">
        <div className="flex items-center gap-2.5">
          <Logo size={28} />
          <span className="text-section font-semibold">Tabfold</span>
          <span className="flex-1" />
          {step < 3 && (
            <Button size="sm" variant="ghost" onClick={finish}>
              Skip
            </Button>
          )}
        </div>
        <Steps step={step} />

        {step === 1 && (
          <>
            <FoldIllustration />
            <h1 className="text-hero font-semibold">Save everything in one click</h1>
            <p className="text-text-2">
              Your tabs fold into a saved session and close, so Chrome gets its memory back. Pinned tabs stay open. Changed your mind?
              Undo for 10 seconds.
            </p>
            <p className="flex items-center gap-1.5 text-small text-text-3">
              Shortcut <Kbd className="h-5 px-1.5">{saveShortcut}</Kbd> from any tab
            </p>
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
              Each window is saved as its own named group, with tab groups and pinned tabs. Restoring brings back the same windows,
              and tabs only load when you click them.
            </p>
            <p className="text-text-2">
              Saving a single tab? Pick a few <span className="font-semibold text-text">keywords</span> and find it later by any of
              them.
            </p>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button variant="primary" onClick={() => setStep(3)}>
                Next
              </Button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="text-hero font-semibold">Bring your tabs with you</h1>
            <p className="text-text-2">Import what you already saved. Nothing is uploaded; it all stays on this device.</p>
            {importSource ? (
              <ImportPanel initialSource={importSource} />
            ) : (
              <div className="flex flex-col gap-2">
                {[
                  { source: 'onetab' as const, title: 'OneTab', hint: 'Paste the text from OneTab’s “Export URLs”', letter: '1', color: '#2F80ED' },
                  { source: 'session-buddy' as const, title: 'Session Buddy', hint: 'Choose its JSON backup file', letter: 'S', color: '#3B82F6' },
                  { source: 'bookmarks' as const, title: 'Browser bookmarks', hint: 'Turn an exported bookmarks file into sessions', letter: 'B', color: '#6B6B75' },
                ].map((option) => (
                  <button
                    key={option.source}
                    type="button"
                    onClick={() => setImportSource(option.source)}
                    className="flex h-[52px] items-center gap-3 rounded-card border border-border-strong bg-surface px-3.5 text-left hover:bg-hover"
                  >
                    <span aria-hidden className="inline-flex size-7 items-center justify-center rounded-[7px] text-small font-semibold text-white" style={{ background: option.color }}>
                      {option.letter}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{option.title}</span>
                      <span className="block text-meta text-text-3">{option.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={finish}>
                Skip for now
              </Button>
              <Button variant="primary" onClick={finish}>
                Start using Tabfold
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
