import { useEffect, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { ArrowDown, ArrowRight, Check, Pin, Puzzle, RefreshCw } from 'lucide-react';
import { extUrl } from '@/lib/extUrl';
import { Logo } from '@/ui/components/Logo';
import { LetterTile, MemoryBar, type Seg } from '../library/diagrams';

const TABS: Array<[string, string, string?, boolean?]> = [
  ['G', '#1F2328', undefined, true],
  ['D', '#4285F4'],
  ['Y', '#FF0033'],
  ['C', '#D97757'],
  ['a', '#FF9900', '#111111'],
];

const FOLDED: Seg[] = Array.from({ length: 30 }, (_, i) => (i < 3 ? 'on' : 'off'));

const GROUPS: Array<{ name: string; color: string; n: number; icons: Array<[string, string, string?, boolean?]> }> = [
  { name: 'Dev', color: 'blue', n: 64, icons: [['G', '#1F2328', undefined, true], ['V', '#000000', undefined, true], ['S', '#3ECF8E', '#0B3D26']] },
  { name: 'AI', color: 'purple', n: 27, icons: [['C', '#D97757'], ['C', '#10A37F']] },
  { name: 'Video', color: 'red', n: 23, icons: [['Y', '#FF0033'], ['V', '#1AB7EA']] },
  { name: 'Reading', color: 'green', n: 52, icons: [['M', '#111111', undefined, true], ['S', '#FF6719']] },
];

function Card({ illustration, title, children }: { illustration: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div aria-hidden className="flex h-[184px] items-center justify-center overflow-hidden rounded-card border border-border bg-bg-subtle">
        {illustration}
      </div>
      <h2 className="m-0 mt-5 text-section font-semibold">{title}</h2>
      <p className="m-0 mt-1.5 text-text-2">{children}</p>
    </div>
  );
}

function FoldDrawing() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex pl-2">
        {TABS.map(([letter, bg, fg, dark], i) => (
          <span
            key={i}
            className="-ml-2 flex h-[26px] w-14 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2 shadow-[0_1px_2px_var(--tf-overlay)]"
          >
            <LetterTile letter={letter} bg={bg} fg={fg} size={12} dark={dark} />
            <span className="h-1 flex-1 rounded-sm bg-skeleton" />
          </span>
        ))}
      </div>
      <ArrowDown size={18} strokeWidth={1.75} className="text-text-3" />
      <div className="w-60">
        <MemoryBar segments={FOLDED} capsule={1} label="Tabs folded, memory freed" />
      </div>
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-green-line bg-green-soft px-3 text-small font-semibold text-green">
        <Check size={14} strokeWidth={2.2} />
        <span className="tabular-nums">Folded 44 tabs · freed ~2.1 GB</span>
      </span>
    </div>
  );
}

function ListDrawing() {
  return (
    <div className="w-[236px] rounded-card border border-border bg-surface py-1 shadow-[0_1px_2px_var(--tf-overlay)]">
      {GROUPS.map((group) => (
        <div key={group.name} className="flex h-[30px] items-center gap-2 px-2.5">
          <span className="size-2 shrink-0 rounded-full" style={{ background: `var(--cg-${group.color})` }} />
          <span className="text-small font-semibold">{group.name}</span>
          <span className="text-meta text-text-3">· {group.n}</span>
          <span className="flex-1" />
          <span className="flex shrink-0 gap-[3px]">
            {group.icons.map(([letter, bg, fg, dark], i) => (
              <LetterTile key={i} letter={letter} bg={bg} fg={fg} size={12} dark={dark} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function Laptop() {
  return (
    <div className="flex flex-col items-center">
      <div className="flex h-[68px] w-[104px] flex-col justify-center gap-2 rounded-t-md rounded-b-[2px] border border-border-strong bg-surface px-3.5">
        {(
          [
            ['blue', 44],
            ['purple', 30],
            ['red', 38],
          ] as const
        ).map(([color, width]) => (
          <div key={color} className="flex items-center gap-[5px]">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: `var(--cg-${color})` }} />
            <span className="h-1 rounded-sm bg-skeleton" style={{ width }} />
          </div>
        ))}
      </div>
      <div className="h-1.5 w-[124px] rounded-b-md border border-t-0 border-border-strong bg-hover" />
    </div>
  );
}

function SyncDrawing() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-3.5 max-[1180px]:gap-1.5">
        <Laptop />
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-text-2">
          <RefreshCw size={16} strokeWidth={1.75} />
        </span>
        <Laptop />
      </div>
      <span className="inline-flex items-center gap-1.5 text-meta text-text-3">
        <Check size={12} strokeWidth={2.2} className="text-green" />
        Synced with Chrome
      </span>
    </div>
  );
}

async function closeTab(): Promise<void> {
  try {
    const tab = await browser.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await browser.tabs.remove(tab.id);
      return;
    }
  } catch {
    // Fall through to closing the window.
  }
  window.close();
}

/**
 * The Welcome tab (Min-Welcome), opened once on install: the three things Tabfold does, the tip to
 * pin it to the toolbar, and a link to how it frees memory. "Got it" closes the tab.
 */
export function Onboarding() {
  useEffect(() => {
    document.title = 'Welcome to Tabfold';
  }, []);
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-bg pb-16 text-text">
      <header className="flex h-[72px] items-center gap-2.5 px-10 max-[720px]:px-5">
        <Logo size={28} />
        <span className="text-section font-semibold">Tabfold</span>
      </header>

      <aside
        aria-label="Tip"
        className="absolute top-4 right-6 w-[316px] rounded-card border border-border bg-surface px-4 pt-3.5 pb-4 shadow-pop max-[1180px]:static max-[1180px]:mx-auto max-[1180px]:mt-2 max-[720px]:w-auto max-[720px]:mx-5"
      >
        <span
          aria-hidden
          className="absolute -top-[7px] right-[30px] size-3 rotate-45 border-t border-l border-border bg-surface max-[1180px]:hidden"
        />
        <div className="flex items-center gap-2 font-semibold">
          <Pin size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-text" />
          Pin Tabfold to your toolbar
        </div>
        <p className="m-0 mt-1 mb-3 text-small text-text-2">
          Click the puzzle piece <Puzzle size={13} strokeWidth={1.75} aria-label="(Extensions)" className="inline align-[-2px] text-text" /> in
          Chrome’s toolbar, then the pin next to Tabfold.
        </p>
        <div aria-hidden className="flex h-9 items-center gap-2.5 rounded-control border border-border bg-bg-subtle pr-1.5 pl-2.5">
          <Logo size={18} />
          <span className="flex-1 text-small">Tabfold</span>
          <span className="flex size-[26px] items-center justify-center rounded-md bg-accent-soft text-accent-text shadow-[0_0_0_1px_var(--tf-accent-line)]">
            <Pin size={14} strokeWidth={1.75} />
          </span>
        </div>
      </aside>

      <main className="mx-auto flex w-full max-w-[1088px] flex-col items-center px-6 pt-20 max-[1180px]:pt-12">
        <h1 className="m-0 text-center text-[32px] leading-[1.2] font-semibold tracking-[-.01em]">Fold your tabs. Find them later.</h1>
        <p className="m-0 mt-3 text-center text-section text-text-2">Three things, and nothing to set up.</p>

        <div className="mt-14 grid w-full grid-cols-3 gap-10 max-[900px]:grid-cols-1 max-[900px]:max-w-[420px]">
          <Card illustration={<FoldDrawing />} title="Fold to free memory">
            One click saves every open tab and closes it. Pinned and playing tabs stay open. Undo if you change your mind.
          </Card>
          <Card illustration={<ListDrawing />} title="One list, sorted for you">
            Everything you fold is grouped by kind of site: Dev, Docs, Video and more. Search finds any tab.
          </Card>
          <Card illustration={<SyncDrawing />} title="Same list on every computer">
            Signed into Chrome? Your folded tabs show up on your other computers too. No account needed.
          </Card>
        </div>

        <a href={extUrl('/library.html#/how')} className="mt-10 inline-flex items-center gap-1.5 font-semibold text-accent-text no-underline hover:underline">
          How Tabfold frees memory
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
        </a>
        <div className="mt-6">
          <button
            type="button"
            onClick={() => void closeTab()}
            className="inline-flex h-11 items-center justify-center rounded-control bg-accent px-10 font-semibold text-on-accent hover:bg-accent-hover"
          >
            Got it
          </button>
        </div>
      </main>
    </div>
  );
}
