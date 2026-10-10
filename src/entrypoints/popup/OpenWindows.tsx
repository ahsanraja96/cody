import { useState } from 'react';
import { browser } from 'wxt/browser';
import { Archive } from 'lucide-react';
import { SiteStrip, WindowIcon } from '@/ui/components/WindowBits';
import { cx } from '@/ui/cx';
import type { WindowInfo } from '@/ui/windows';
import { SectionLabel } from './parts';

/** Windows listed before the rest are one click away. */
const SHOWN = 3;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function WindowRow({
  info,
  picked,
  disabled,
  onFold,
}: {
  info: WindowInfo;
  picked: boolean;
  disabled: boolean;
  onFold: (info: WindowInfo) => void;
}) {
  const canFold = info.folds && info.foldable.length > 0 && !disabled;
  const label = `${info.name}, ${plural(info.tabs.length, 'tab')}`;
  const body = (
    <>
      <WindowIcon info={info} className={cx('flex-none', picked ? 'text-accent-text' : 'text-text-3')} />
      <span className={cx('min-w-0 flex-1 truncate', info.current && 'font-semibold')}>{info.name}</span>
      <SiteStrip tabs={info.tabs} />
    </>
  );
  return (
    <div
      role="listitem"
      className={cx(
        'group/win flex h-9 items-center gap-2.5 rounded-control px-2',
        picked ? 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--tf-accent-line)]' : 'focus-within:bg-hover hover:bg-hover',
      )}
    >
      {info.current ? (
        <div aria-label={label} className="flex h-full min-w-0 flex-1 items-center gap-2.5">
          {body}
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Switch to ${label}`}
          onClick={() => void browser.windows.update(info.id, { focused: true }).catch(() => undefined)}
          className={cx('flex h-full min-w-0 flex-1 items-center gap-2.5 text-left', !info.folds && 'opacity-60')}
        >
          {body}
        </button>
      )}
      {!info.folds ? (
        <span className="flex-none text-small text-text-3">Stays open</span>
      ) : (
        <>
          <span
            className={cx(
              'w-[52px] flex-none text-right text-small text-text-2 tabular-nums',
              canFold && 'group-focus-within/win:hidden group-hover/win:hidden',
            )}
          >
            {plural(info.tabs.length, 'tab')}
          </span>
          {canFold && (
            <button
              type="button"
              onClick={() => onFold(info)}
              aria-label={`Fold ${info.current ? 'this window' : info.name}, ${plural(info.foldable.length, 'tab')}`}
              title={`Saves and closes the ${plural(info.foldable.length, 'tab')} in ${info.current ? 'this window' : info.name}`}
              className="hidden h-6 flex-none items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2 text-small font-semibold text-text group-focus-within/win:inline-flex group-hover/win:inline-flex hover:bg-hover"
            >
              <Archive size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
              Fold
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * "Open windows" (Min-Popup-Windows), above the folded tabs: this window first, then the others.
 * Click one to switch to it; hover for its own Fold. While Fold asks which windows, the ones the
 * highlighted choice covers are tinted.
 */
export function OpenWindows({
  windows,
  highlight,
  disabled,
  onFold,
}: {
  windows: WindowInfo[];
  highlight: 'this' | 'all' | null;
  disabled: boolean;
  onFold: (info: WindowInfo) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (windows.length === 0) return null;
  const shown = expanded ? windows : windows.slice(0, SHOWN);
  const picked = (info: WindowInfo) =>
    highlight === 'all' ? info.foldable.length > 0 : highlight === 'this' ? info.current : false;
  return (
    <section aria-label="Open windows" className="mb-1.5">
      <SectionLabel count={windows.length}>Open windows</SectionLabel>
      <div role="list">
        {shown.map((info) => (
          <WindowRow key={info.id} info={info} picked={picked(info)} disabled={disabled} onFold={onFold} />
        ))}
      </div>
      {!expanded && windows.length > SHOWN && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-7 items-center rounded-control pr-2 pl-[34px] text-small text-text-3 hover:text-text"
        >
          Show {plural(windows.length - SHOWN, 'more window')}
        </button>
      )}
    </section>
  );
}
