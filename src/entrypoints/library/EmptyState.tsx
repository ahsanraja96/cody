import { Archive, ArrowUpRight, Laptop } from 'lucide-react';

const DOTS = ['blue', 'purple', 'red', 'green'];

/**
 * First run, nothing folded yet: what Fold does (pointing at the button above) and where people
 * coming from OneTab start.
 */
export function EmptyState({ onImport, foldable }: { onImport: () => void; foldable: number }) {
  return (
    <div className="flex flex-col items-center px-4 pt-16 pb-8 text-center">
      <h1 className="m-0 text-page font-semibold">Nothing folded yet</h1>
      <p className="m-0 mt-2 max-w-[440px] text-text-2">
        <span className="inline-flex items-center gap-1 font-semibold text-text">
          Fold all tabs
          <ArrowUpRight size={14} strokeWidth={2} aria-hidden className="text-accent-text" />
        </span>{' '}
        saves {foldable > 0 ? `your ${foldable === 1 ? 'open tab' : `${foldable.toLocaleString()} open tabs`}` : 'every open tab'} here and closes{' '}
        {foldable === 1 ? 'it' : 'them'}. Pinned and playing tabs stay open.
      </p>
      <ul className="m-0 mt-8 flex list-none flex-col gap-4 p-0 text-left">
        <li className="flex items-center gap-3.5">
          <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-control border border-border bg-bg-subtle text-text-2">
            <Archive size={16} strokeWidth={1.75} />
          </span>
          Fold to free memory
        </li>
        <li className="flex items-center gap-3.5">
          <span aria-hidden className="grid size-9 shrink-0 grid-cols-2 place-content-center gap-1 rounded-control border border-border bg-bg-subtle p-2.5">
            {DOTS.map((c) => (
              <span key={c} className="size-[7px] rounded-full" style={{ background: `var(--cg-${c})` }} />
            ))}
          </span>
          Find them here, sorted by kind of site
        </li>
        <li className="flex items-center gap-3.5">
          <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-control border border-border bg-bg-subtle text-text-2">
            <Laptop size={16} strokeWidth={1.75} />
          </span>
          Same list on your other computers with Chrome sync
        </li>
      </ul>
      <p className="m-0 mt-8 text-small text-text-3">
        Coming from OneTab?{' '}
        <button type="button" onClick={onImport} className="font-semibold text-accent-text hover:underline">
          Import from OneTab
        </button>
      </p>
    </div>
  );
}
