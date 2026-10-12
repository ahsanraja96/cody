import { useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { Archive, Ellipsis } from 'lucide-react';
import { anchorBelow, type MenuAnchor } from '@/ui/components/Menu';
import { CopiesLine, WindowNameField } from '@/ui/components/WindowParts';
import { SiteStrip, WindowIcon } from '@/ui/components/WindowBits';
import { cx } from '@/ui/cx';
import type { WindowInfo } from '@/ui/windows';
import type { OpenCopies } from '@/lib/openCopies';
import { SectionLabel } from './parts';

/** Windows listed before the rest are one click away. */
const SHOWN = 3;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export interface WindowRowActions {
  onFold: (info: WindowInfo) => void;
  /** Open the window's ⋯ menu below this button. */
  onMenu: (info: WindowInfo, anchor: MenuAnchor, button: HTMLElement) => void;
  onRename: (info: WindowInfo, name: string) => void;
}

function WindowRow({
  info,
  picked,
  disabled,
  menuOpen,
  renaming,
  hint,
  actions,
  onRenaming,
}: {
  info: WindowInfo;
  picked: boolean;
  disabled: boolean;
  menuOpen: boolean;
  renaming: boolean;
  hint: ReactNode;
  actions: WindowRowActions;
  onRenaming: (on: boolean) => void;
}) {
  const canFold = info.folds && info.foldable.length > 0 && !disabled;
  const label = `${info.name}, ${plural(info.tabs.length, 'tab')}`;
  const name = (
    <span
      title={info.incognito ? undefined : 'Click the name to rename'}
      onClick={(e) => {
        if (info.incognito) return;
        e.stopPropagation();
        onRenaming(true);
      }}
      className={cx('min-w-0 truncate', info.current && 'font-semibold', !info.incognito && 'cursor-text')}
    >
      {info.name}
    </span>
  );
  const body = (
    <>
      <WindowIcon info={info} className={cx('flex-none', picked ? 'text-accent-text' : 'text-text-3')} />
      {name}
      <span className="flex-1" />
      <SiteStrip tabs={info.tabs} />
    </>
  );
  const active = menuOpen ? 'bg-hover' : '';
  return (
    <div role="listitem">
      <div
        className={cx(
          'group/win flex h-9 items-center gap-2.5 rounded-control px-2',
          picked ? 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--tf-accent-line)]' : cx('focus-within:bg-hover hover:bg-hover', active),
          menuOpen && 'win-on',
        )}
      >
        {renaming ? (
          <span className="flex h-full min-w-0 flex-1 items-center gap-2.5">
            <WindowIcon info={info} className="flex-none text-text-3" />
            <WindowNameField
              info={info}
              onDone={(value) => {
                onRenaming(false);
                if (value !== null && value.trim() !== info.given) actions.onRename(info, value);
              }}
            />
          </span>
        ) : info.current ? (
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
                'group-focus-within/win:hidden group-hover/win:hidden',
                (menuOpen || renaming) && 'hidden',
              )}
            >
              {plural(info.tabs.length, 'tab')}
            </span>
            <span className={cx('hidden flex-none items-center gap-0.5 group-focus-within/win:flex group-hover/win:flex', menuOpen && 'flex!')}>
              {canFold && (
                <button
                  type="button"
                  onClick={() => actions.onFold(info)}
                  aria-label={`Fold ${info.current ? 'this window' : info.name}, ${plural(info.foldable.length, 'tab')}`}
                  title={`Saves and closes the ${plural(info.foldable.length, 'tab')} in ${info.current ? 'this window' : info.name}`}
                  className="inline-flex h-6 flex-none items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2 text-small font-semibold text-text hover:bg-hover"
                >
                  <Archive size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
                  Fold
                </button>
              )}
              <button
                type="button"
                aria-label={`More for ${info.name}`}
                title={`More for ${info.name}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(e) => actions.onMenu(info, anchorBelow(e.currentTarget), e.currentTarget)}
                className={cx(
                  'inline-flex size-6 flex-none items-center justify-center rounded-md text-text-2 hover:bg-border hover:text-text',
                  menuOpen && 'bg-border text-text',
                )}
              >
                <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </span>
          </>
        )}
      </div>
      {renaming && (
        <p id="window-name-hint" className="m-0 -mt-0.5 mb-1 pl-[34px] text-meta text-text-3">
          Enter to save · Esc to cancel
        </p>
      )}
      {!renaming && hint}
    </div>
  );
}

/**
 * "Open windows" (Min-Popup-Windows, Fi-Popup), above the folded tabs: this window first, then the
 * others. Click one to switch to it; hover for its own Fold and ⋯ (Fold into…, Tidy into groups,
 * Rename window, Close the copies); click its name to rename it. A window with a folder's tab group
 * says it folds back into the folder. While Fold asks which windows, the ones the highlighted
 * choice covers are tinted.
 */
export function OpenWindows({
  windows,
  highlight,
  disabled,
  menuFor,
  hints,
  copies,
  actions,
  renaming,
  onRenaming,
  onCloseCopies,
}: {
  windows: WindowInfo[];
  highlight: 'this' | 'all' | null;
  disabled: boolean;
  /** The window whose ⋯ menu is open. */
  menuFor?: number;
  /** The fold-back hint under a window, by window id. */
  hints: ReadonlyMap<number, ReactNode>;
  copies: OpenCopies;
  actions: WindowRowActions;
  /** The window whose name is being edited (click its name, or ⋯ › Rename window). */
  renaming: number | null;
  onRenaming: (windowId: number | null) => void;
  onCloseCopies: () => void;
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
          <WindowRow
            key={info.id}
            info={info}
            picked={picked(info)}
            disabled={disabled}
            menuOpen={menuFor === info.id}
            renaming={renaming === info.id}
            hint={hints.get(info.id)}
            actions={actions}
            onRenaming={(on) => onRenaming(on ? info.id : null)}
          />
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
      <CopiesLine copies={copies} onClose={onCloseCopies} className="px-2" />
    </section>
  );
}
