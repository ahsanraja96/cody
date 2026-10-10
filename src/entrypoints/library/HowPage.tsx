import type { ReactNode } from 'react';
import { ArrowDown, Check, ChevronLeft, Info, Moon, MousePointer2 } from 'lucide-react';
import { Logo } from '@/ui/components/Logo';
import { useSettings } from '@/ui/hooks';
import { LetterTile, MemoryBar, PageBlocks, Step, StepArrow, TabInStrip, type Seg } from './diagrams';

/** 47 open tabs, three of them asleep. */
const ALL_TABS: Seg[] = Array.from({ length: 47 }, (_, i) => (i === 14 || i === 27 || i === 40 ? 'asleep' : 'on'));
const FREED: Seg[] = ['on', 'on', 'off', 'off', 'off', 'off'];

function Section({ n, title, children, diagram }: { n: string; title: string; children: ReactNode; diagram: ReactNode }) {
  return (
    <section className="border-t border-border py-10">
      <div className="flex items-baseline gap-3.5">
        <span className="text-meta font-semibold tracking-[.08em] text-text-3 tabular-nums">{n}</span>
        <h2 className="m-0 text-page font-semibold">{title}</h2>
      </div>
      <p className="m-0 mt-2 ml-[33px] max-w-[680px] text-text-2">{children}</p>
      <div className="mt-6 flex min-h-[236px] items-center justify-center gap-4 overflow-x-auto rounded-card border border-border bg-bg-subtle p-8">{diagram}</div>
    </section>
  );
}

function sleepAfter(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`;
}

/**
 * How Tabfold frees memory (Min-HowMemory): every open tab is a running page; Fold keeps the
 * address and closes the page; Sleep keeps the tab and unloads the page. Then why numbers have "~".
 */
export function HowPage({ onBack }: { onBack: () => void }) {
  const [settings] = useSettings();
  const idle = sleepAfter(settings.autoSuspendMinutes);
  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="flex h-16 items-center gap-2.5 border-b border-border px-8 max-[720px]:px-4">
        <Logo size={28} />
        <span className="text-section font-semibold">Tabfold</span>
        <span className="flex-1" />
        <a
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
          className="inline-flex items-center gap-1.5 font-semibold text-accent-text no-underline hover:underline"
        >
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
          Back to your list
        </a>
      </header>
      <main className="mx-auto w-full max-w-[1088px] px-6 pt-14 pb-[72px]">
        <div className="label-caps tracking-[.08em]">How it works</div>
        <h1 className="m-0 mt-2.5 text-[32px] leading-[1.2] font-semibold tracking-[-.01em]">How Tabfold frees memory</h1>
        <p className="m-0 mt-2.5 mb-10 text-section text-text-2">Two ways to give memory back to your computer. Both keep your tabs.</p>

        <Section
          n="01"
          title="Every open tab is a running page"
          diagram={
            <>
              <Step width={250} n={1} label="A tab">
                <TabInStrip title="Q4 roadmap — Google Docs" width={250} />
              </Step>
              <StepArrow caption="runs" width={56} />
              <Step width={220} n={2} label="A running page">
                <div className="flex flex-col items-center gap-2">
                  <PageBlocks state="running" />
                  <span className="tabular-nums">
                    <span className="font-semibold">50–300 MB</span>
                    <span className="text-text-3"> each</span>
                  </span>
                </div>
              </Step>
              <StepArrow caption="×47" width={56} />
              <Step width={210} n={3} label="All your tabs">
                <div className="flex w-[210px] flex-col gap-2.5">
                  <MemoryBar segments={ALL_TABS} label="47 open tabs" />
                  <span className="tabular-nums">
                    <span className="font-semibold">~2.1 GB</span>
                    <span className="text-text-3"> for 47 tabs</span>
                  </span>
                </div>
              </Step>
            </>
          }
        >
          Each one holds 50–300 MB, even when you’re not looking at it.
        </Section>

        <Section
          n="02"
          title="Fold: keep the address, close the page"
          diagram={
            <>
              <Step width={220} n={1} label="Keep the address">
                <div className="flex w-[220px] flex-col gap-2.5">
                  <div className="flex items-center gap-2.5 rounded-control border border-border-strong bg-surface px-3 py-2.5">
                    <LetterTile letter="D" bg="#4285F4" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-small font-semibold">Q4 roadmap</div>
                      <div className="truncate text-meta text-text-3">docs.google.com/document/d/1xQ…</div>
                    </div>
                    <span className="inline-flex h-[18px] shrink-0 items-center rounded bg-accent-soft px-1.5 text-meta font-semibold text-accent-text tabular-nums">
                      ≈ 1 KB
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-meta text-text-3">
                    <ArrowDown size={14} strokeWidth={1.75} aria-hidden />
                    Into your list, on this computer
                  </div>
                </div>
              </Step>
              <StepArrow />
              <Step width={208} n={2} label="Chrome closes the page">
                <div className="flex flex-col items-center gap-2">
                  <PageBlocks state="gone" />
                  <span className="text-small text-text-3">Nothing left running</span>
                </div>
              </Step>
              <StepArrow />
              <Step width={200} n={3} label="Memory goes back">
                <div className="flex w-[200px] flex-col items-center gap-2.5">
                  <div className="w-full">
                    <MemoryBar segments={FREED} capsule={0.6} label="Freed" />
                  </div>
                  <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-green-line bg-green-soft px-2.5 text-small font-semibold text-green tabular-nums">
                    <Check size={13} strokeWidth={2.2} aria-hidden />
                    50–300 MB back
                  </span>
                </div>
              </Step>
            </>
          }
        >
          The address, title and icon go into your list on this computer. Chrome closes the page and the memory goes back. Reopen it any time;
          the page loads fresh.
        </Section>

        <Section
          n="03"
          title="Sleep: keep the tab, unload the page"
          diagram={
            <>
              <Step width={200} n={1} label={`Idle ${idle}`}>
                <TabInStrip
                  title="Pricing page copy"
                  width={200}
                  trailing={<Moon size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-text" />}
                />
              </Step>
              <StepArrow />
              <Step width={208} n={2} label="Chrome unloads the page">
                <div className="flex flex-col items-center gap-2">
                  <PageBlocks state="asleep" />
                  <span className="text-small text-text-3">Tab stays, memory released</span>
                </div>
              </Step>
              <StepArrow />
              <Step width={200} n={3} label="A click wakes it">
                <div className="relative flex flex-col items-center">
                  <TabInStrip title="Pricing page copy" width={200} />
                  <MousePointer2 size={18} strokeWidth={1.75} aria-hidden className="absolute top-[26px] left-[112px] text-text" />
                  <span className="mt-[22px] text-small text-text-3">Page loads fresh</span>
                </div>
              </Step>
            </>
          }
        >
          Chrome’s own discard: the tab stays in your tab bar with its title and icon, its memory is released, and a click wakes it. Automatic
          after {idle} idle. Never pinned tabs, tabs playing sound or the tab you’re on.
        </Section>

        <div className="border-t border-border pt-8">
          <aside className="mt-2 flex gap-3.5 rounded-card border border-border bg-bg-subtle px-6 py-5">
            <Info size={18} strokeWidth={1.75} aria-hidden className="mt-px shrink-0 text-text-2" />
            <div>
              <div className="font-semibold">Why the “~”?</div>
              <p className="m-0 mt-1 text-text-2">
                Chrome doesn’t tell extensions how much memory each tab uses, so Tabfold estimates about 50 MB per loaded tab. After a fold it
                also reads your computer’s free memory, so you see the real change.
              </p>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
