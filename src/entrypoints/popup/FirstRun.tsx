import type { ReactNode } from 'react';
import { Archive, Laptop } from 'lucide-react';
import { openLibrary } from '@/lib/openLibrary';
import '@/ui/components/FoldedList.css';

/**
 * Nothing folded yet (Min-Popup-FirstRun): three lines on what Tabfold does, and Import from
 * OneTab, under the open windows when there are any.
 */
export function FirstRun({ top }: { top?: ReactNode }) {
  const intro = (
    <section
      aria-label="How Tabfold works"
      className={
        top
          ? 'flex flex-col gap-5 px-8 pt-3 pb-4'
          : 'flex min-h-0 flex-1 flex-col justify-center gap-6 overflow-y-auto border-t border-border px-8 pt-3 pb-4'
      }
    >
      <ul className="flex flex-col gap-[18px]">
        <Line icon={<Archive size={16} strokeWidth={1.75} />}>Fold to free memory</Line>
        <Line icon={<CategoryDots />}>Find them here, sorted by kind of site</Line>
        <Line icon={<Laptop size={16} strokeWidth={1.75} />}>Same list on your other computers with Chrome sync</Line>
      </ul>
      <p className="ml-[50px] text-small text-text-3">
        Coming from OneTab?{' '}
        <button
          type="button"
          onClick={() => {
            void openLibrary('#/import').finally(() => window.close());
          }}
          className="font-semibold text-accent-text hover:underline"
        >
          Import from OneTab
        </button>
      </p>
    </section>
  );
  if (!top) return intro;
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-border">
      <div className="px-2 pt-1">{top}</div>
      {intro}
    </div>
  );
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3.5">
      <span
        aria-hidden="true"
        className="flex size-9 flex-none items-center justify-center rounded-card border border-border bg-bg-subtle text-text-2"
      >
        {icon}
      </span>
      <span>{children}</span>
    </li>
  );
}

function CategoryDots() {
  return (
    <span className="grid grid-cols-[7px_7px] gap-1">
      {['blue', 'purple', 'red', 'green'].map((color) => (
        <span key={color} className={`tf-cg-dot tf-cg-${color} size-[7px]`} />
      ))}
    </span>
  );
}
