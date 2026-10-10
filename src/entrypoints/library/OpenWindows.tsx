import { browser } from 'wxt/browser';
import { Archive } from 'lucide-react';
import { estimateBytes } from '@/lib/format';
import { SiteStrip, WindowIcon } from '@/ui/components/WindowBits';
import { cx } from '@/ui/cx';
import type { WindowInfo } from '@/ui/windows';
import { approxBytes, count } from './format';

const SECONDARY_SM =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover disabled:cursor-default disabled:text-text-3';

/**
 * "Open windows" (Min-List-Windows), first on the full list: a card per window with its own Fold.
 * Click a window to switch to it. An Incognito window shows "Stays open" while folding Incognito
 * is off.
 */
export function OpenWindows({
  windows,
  disabled,
  onFold,
}: {
  windows: WindowInfo[];
  disabled: boolean;
  onFold: (info: WindowInfo) => void;
}) {
  if (windows.length === 0) return null;
  const tabs = windows.reduce((n, w) => n + w.tabs.length, 0);
  const loaded = windows.reduce((n, w) => n + w.tabs.filter((t) => !t.discarded).length, 0);
  return (
    <section aria-labelledby="ow-h" className="mb-7">
      <div className="mb-3 flex items-baseline justify-between gap-4 px-0.5">
        <h2 id="ow-h" className="label-caps m-0">
          Open windows · {windows.length}
        </h2>
        <span className="text-small text-text-3 tabular-nums max-[560px]:hidden">
          {count(tabs, 'tab')} · {approxBytes(estimateBytes(loaded))} in use
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3 max-[720px]:grid-cols-1">
        {windows.map((info) => (
          <WindowCard key={info.id} info={info} disabled={disabled} onFold={onFold} />
        ))}
      </div>
    </section>
  );
}

function WindowCard({ info, disabled, onFold }: { info: WindowInfo; disabled: boolean; onFold: (info: WindowInfo) => void }) {
  const where = info.current ? 'this window' : info.name;
  const text = (
    <>
      <div className="truncate font-semibold">{info.name}</div>
      <div className="flex min-w-0 items-center gap-1.5 text-small text-text-3">
        <span className="shrink-0 tabular-nums">{count(info.tabs.length, 'tab')}</span>
        <SiteStrip tabs={info.tabs} size={12} />
      </div>
    </>
  );
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-surface py-3 pr-3 pl-3.5">
      <span
        aria-hidden="true"
        className={cx(
          'inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-bg-subtle',
          info.current ? 'text-accent-text' : 'text-text-2',
          !info.folds && 'opacity-60',
        )}
      >
        <WindowIcon info={info} />
      </span>
      {info.current ? (
        <div className="min-w-0 flex-1">{text}</div>
      ) : (
        <button
          type="button"
          aria-label={`Switch to ${info.name}, ${count(info.tabs.length, 'tab')}`}
          onClick={() => void browser.windows.update(info.id, { focused: true }).catch(() => undefined)}
          className={cx('min-w-0 flex-1 text-left', !info.folds && 'opacity-60')}
        >
          {text}
        </button>
      )}
      {!info.folds ? (
        <span className="shrink-0 text-small text-text-3" title="Turn on “Fold Incognito windows too” in Settings to fold it">
          Stays open
        </span>
      ) : (
        <button
          type="button"
          disabled={disabled || info.foldable.length === 0}
          onClick={() => onFold(info)}
          aria-label={`Fold ${where}, ${count(info.foldable.length, 'tab')}`}
          title={
            info.foldable.length
              ? `Saves and closes the ${count(info.foldable.length, 'tab')} in ${where}. Pinned and playing tabs stay open.`
              : 'Nothing to fold: only pinned, playing or new tab pages are open here.'
          }
          className={SECONDARY_SM}
        >
          <Archive size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
          Fold
        </button>
      )}
    </div>
  );
}
