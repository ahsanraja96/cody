import { useState } from 'react';
import { browser } from 'wxt/browser';
import { Archive, Ellipsis } from 'lucide-react';
import { estimateBytes } from '@/lib/format';
import { send } from '@/lib/messages';
import type { FolderRecord } from '@/lib/types';
import { anchorBelow, type MenuAnchor } from '@/ui/components/Menu';
import { toast } from '@/ui/components/Toast';
import { SiteStrip, WindowIcon } from '@/ui/components/WindowBits';
import { WindowMenu, type FoldTarget } from '@/ui/components/WindowMenu';
import { CopiesLine, WindowNameField } from '@/ui/components/WindowParts';
import { cx } from '@/ui/cx';
import { closedText, commandProblem, copiesIn, groupedText, renameWindow } from '@/ui/openTabs';
import type { WindowInfo } from '@/ui/windows';
import { undoToast } from './folderActions';
import { approxBytes, count } from './format';
import { goToPlans } from './router';

const SECONDARY_SM =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover disabled:cursor-default disabled:text-text-3';

/** "Close the copies" (everywhere, or one window), with Undo and ⌘Z. */
async function closeCopies(windowId?: number): Promise<void> {
  try {
    const { closed, actionId } = await send({ type: 'copies-close', ...(windowId !== undefined ? { windowId } : {}) });
    if (closed > 0) undoToast(closedText(closed), [actionId]);
    else toast('No copies to close: every page is open once.');
  } catch (error) {
    toast(commandProblem(error), { tone: 'error' });
  }
}

/** "Tidy into groups", with Undo and ⌘Z. */
async function tidyWindow(windowId: number): Promise<void> {
  try {
    const { grouped, groups, actionId } = await send({ type: 'window-tidy', windowId });
    if (grouped > 0) undoToast(groupedText(grouped, groups), [actionId]);
    else toast('Nothing to tidy: no two loose tabs are the same kind of site.');
  } catch (error) {
    toast(commandProblem(error), { tone: 'error' });
  }
}

/** What "Fold into…" needs to list the folders. */
export interface FoldIntoContext {
  /** In "Fold into" order: starred, then used lately. */
  folders: readonly FolderRecord[];
  counts: ReadonlyMap<string, number>;
  starred: (folder: FolderRecord) => boolean;
  /** Free with its 3 folders. */
  folderLimit: boolean;
}

/**
 * "Open windows" (Min-List-Windows, Fi-List), first on the full list: a card per window with its own
 * Fold and ⋯ (Fold into ›, Tidy into groups, Rename window, Close the copies). Click a window to
 * switch to it, its name to rename it. "3 pages are open twice · Close the copies" under the cards.
 * An Incognito window shows "Stays open" while folding Incognito is off.
 */
export function OpenWindows({
  windows,
  disabled,
  onFold,
  onFoldInto,
  into,
}: {
  windows: WindowInfo[];
  disabled: boolean;
  onFold: (info: WindowInfo) => void;
  onFoldInto: (info: WindowInfo, target: FoldTarget) => void;
  into: FoldIntoContext;
}) {
  const [menu, setMenu] = useState<{ info: WindowInfo; anchor: MenuAnchor; button: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  if (windows.length === 0) return null;
  const tabs = windows.reduce((n, w) => n + w.tabs.length, 0);
  const loaded = windows.reduce((n, w) => n + w.tabs.filter((t) => !t.discarded).length, 0);
  const copies = copiesIn(windows);
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
          <WindowCard
            key={info.id}
            info={info}
            disabled={disabled}
            menuOpen={menu?.info.id === info.id}
            renaming={renaming === info.id}
            onFold={onFold}
            onMenu={(anchor, button) => setMenu({ info, anchor, button })}
            onRenaming={(on) => setRenaming(on ? info.id : null)}
          />
        ))}
      </div>
      <CopiesLine copies={copies} onClose={() => void closeCopies()} className="mt-2 px-0.5" />
      {menu && (
        <WindowMenu
          submenu
          anchor={menu.anchor}
          returnFocus={menu.button}
          name={menu.info.name}
          folders={into.folders}
          counts={into.counts}
          starred={into.starred}
          folderLimit={into.folderLimit}
          copies={copiesIn(windows, menu.info.id).pages}
          canFold={menu.info.folds && menu.info.foldable.length > 0 && !disabled}
          onFoldInto={(target) => onFoldInto(menu.info, target)}
          onTidy={menu.info.incognito ? undefined : () => void tidyWindow(menu.info.id)}
          onRename={menu.info.incognito ? undefined : () => setRenaming(menu.info.id)}
          onCloseCopies={() => void closeCopies(menu.info.id)}
          onUpgrade={goToPlans}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

function WindowCard({
  info,
  disabled,
  menuOpen,
  renaming,
  onFold,
  onMenu,
  onRenaming,
}: {
  info: WindowInfo;
  disabled: boolean;
  menuOpen: boolean;
  renaming: boolean;
  onFold: (info: WindowInfo) => void;
  onMenu: (anchor: MenuAnchor, button: HTMLElement) => void;
  onRenaming: (on: boolean) => void;
}) {
  const where = info.current ? 'this window' : info.name;
  const name = (
    <span
      title={info.incognito ? undefined : 'Click the name to rename'}
      onClick={(e) => {
        if (info.incognito) return;
        e.stopPropagation();
        onRenaming(true);
      }}
      className={cx('block truncate font-semibold', !info.incognito && 'cursor-text')}
    >
      {info.name}
    </span>
  );
  const meta = (
    <div className="flex min-w-0 items-center gap-1.5 text-small text-text-3">
      <span className="shrink-0 tabular-nums">{count(info.tabs.length, 'tab')}</span>
      <SiteStrip tabs={info.tabs} size={12} />
    </div>
  );
  return (
    <div className="flex items-center gap-2.5 rounded-card border border-border bg-surface py-3 pr-2 pl-3.5">
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
      {renaming ? (
        <div className="min-w-0 flex-1">
          <WindowNameField
            info={info}
            className="w-full"
            onDone={(value) => {
              onRenaming(false);
              if (value !== null && value.trim() !== info.given) void renameWindow(info.id, value);
            }}
          />
          <p id="window-name-hint" className="m-0 mt-0.5 text-meta text-text-3">
            Enter to save · Esc to cancel
          </p>
        </div>
      ) : info.current ? (
        <div className="min-w-0 flex-1">
          {name}
          {meta}
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Switch to ${info.name}, ${count(info.tabs.length, 'tab')}`}
          onClick={() => void browser.windows.update(info.id, { focused: true }).catch(() => undefined)}
          className={cx('min-w-0 flex-1 text-left', !info.folds && 'opacity-60')}
        >
          {name}
          {meta}
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
      <button
        type="button"
        aria-label={`More for ${info.name}`}
        title={`More for ${info.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => onMenu(anchorBelow(e.currentTarget), e.currentTarget)}
        className={cx(
          'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text',
          menuOpen && 'bg-hover text-text',
        )}
      >
        <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
