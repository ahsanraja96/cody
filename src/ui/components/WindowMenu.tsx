import { useState, type ReactNode } from 'react';
import { ChevronLeft, Copy, Folder, FolderPlus, Group, Pencil, Sparkles } from 'lucide-react';
import { FREE_LIMITS } from '@/lib/limits';
import type { FolderRecord } from '@/lib/types';
import { cleanFolderName } from '../folders';
import { FolderIcon } from './FolderIcon';
import { Menu, type MenuAnchor, type MenuEntry } from './Menu';
import { StarMark } from './Star';

/**
 * A window's ⋯ (1.0, Fi-Fold-States, Fi-Panel-States): Fold into…, Tidy into groups, Rename window,
 * Close the copies ("2 pages", only when it has some). In the popup and the side panel "Fold into…"
 * swaps the menu for the folder list with a ‹ back row; the full list opens it as a submenu. The
 * folder list: starred folders, then the 3 used most recently ("Show N more folders" for the rest),
 * then "New folder…", which asks for a name in place (or says "Free has 3 folders"). The popup's
 * Fold ▾ and right-click › "Choose a folder…" open straight on the folder list.
 */

export type FoldTarget = { folderId: string } | { newName: string };

/** Non-starred folders listed before "Show N more folders". */
const RECENT_SHOWN = 3;

type View = 'menu' | 'into' | 'new' | 'limit';

export interface WindowMenuProps {
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  /** The window as shown: "Client work", "This window". */
  name: string;
  /** Folders in "Fold into" order (`foldIntoOrder`): starred first, then used lately. */
  folders: readonly FolderRecord[];
  /** Tabs in each folder. */
  counts: ReadonlyMap<string, number>;
  /** Is this folder starred for this person? */
  starred: (folder: FolderRecord) => boolean;
  /** Free already has its 3 folders: "New folder…" says so instead. */
  folderLimit: boolean;
  /** Start on the folder list (the popup's ▾, "Choose a folder…"). */
  start?: 'menu' | 'into';
  /** The folder list's heading when it is where the menu starts: "Fold into a folder" · "This window · 8 tabs". */
  heading?: { title: string; right?: string };
  /** "Fold into…" as a submenu (the full list) instead of swapping the menu. */
  submenu?: boolean;
  /** Pages open twice in this window ("2 pages"); 0 leaves "Close the copies" out. */
  copies?: number;
  /** Nothing to fold: "Fold into…" is greyed. */
  canFold?: boolean;
  onFoldInto: (target: FoldTarget) => void;
  onTidy?: () => void;
  onRename?: () => void;
  onCloseCopies?: () => void;
  onUpgrade: () => void;
  onClose: () => void;
}

const ICON = { size: 16, strokeWidth: 1.75 } as const;

function pages(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'page' : 'pages'}`;
}

function NewFolderField({ onSubmit, onBack }: { onSubmit: (name: string) => void; onBack: () => void }) {
  const [name, setName] = useState('');
  const clean = cleanFolderName(name);
  return (
    <div className="px-1.5 pt-1 pb-1.5">
      <div className="flex h-8 items-center gap-2 rounded-control border border-accent bg-surface px-2 shadow-[0_0_0_3px_var(--tf-accent-soft)]">
        <FolderPlus size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
        <input
          data-menu-item=""
          aria-label="New folder’s name"
          placeholder="Folder name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              if (clean) onSubmit(clean);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onBack();
            } else if (e.key !== 'Tab') {
              // Typing stays in the field (the menu's arrow keys and Home/End don't take it).
              e.stopPropagation();
            }
          }}
          className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none"
        />
      </div>
      <p className="m-0 mt-1.5 px-0.5 text-meta text-text-3">Enter to fold into it · Esc to go back</p>
    </div>
  );
}

function LimitBox({ onBack, onUpgrade }: { onBack: () => void; onUpgrade: () => void }) {
  return (
    <div role="group" aria-labelledby="fold-into-limit" className="px-2.5 pt-1.5 pb-2">
      <div id="fold-into-limit" className="flex items-center gap-2 font-semibold">
        <Folder size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-text" />
        Free has {FREE_LIMITS.folders} folders
      </div>
      <p className="m-0 mt-1 text-small text-text-2">Upgrade for as many folders as you like, every tab on every computer, and a daily backup.</p>
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          data-menu-item=""
          onClick={onBack}
          className="inline-flex h-7 items-center rounded-control border border-border-strong bg-surface px-2.5 text-small text-text hover:bg-hover focus-visible:bg-hover"
        >
          Not now
        </button>
        <button
          type="button"
          data-menu-item=""
          onClick={onUpgrade}
          className="inline-flex h-7 items-center gap-1.5 rounded-control bg-accent px-2.5 text-small font-semibold text-on-accent hover:bg-accent-hover"
        >
          <Sparkles size={13} strokeWidth={1.75} aria-hidden />
          Upgrade
        </button>
      </div>
    </div>
  );
}

function headingEntry(key: string, title: ReactNode, right?: ReactNode): MenuEntry {
  return {
    type: 'custom',
    key,
    render: () => (
      <div className="flex min-h-[30px] items-center gap-2 px-2.5 py-1 text-small font-semibold text-text-2">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {right && <span className="shrink-0 font-normal text-text-3">{right}</span>}
      </div>
    ),
  };
}

/** The folder list "Fold into" shows: starred, then recent (3, or all), then New folder…. */
export function foldIntoEntries({
  folders,
  counts,
  starred,
  showAll,
  onShowAll,
  onPick,
  onNew,
}: {
  folders: readonly FolderRecord[];
  counts: ReadonlyMap<string, number>;
  starred: (folder: FolderRecord) => boolean;
  showAll: boolean;
  onShowAll: () => void;
  onPick: (folder: FolderRecord) => void;
  onNew: () => void;
}): MenuEntry[] {
  const stars = folders.filter(starred);
  const rest = folders.filter((f) => !starred(f));
  const shown = showAll ? rest : rest.slice(0, RECENT_SHOWN);
  const item = (folder: FolderRecord): MenuEntry => {
    const n = counts.get(folder.id) ?? 0;
    const star = starred(folder);
    return {
      key: `f:${folder.id}`,
      label: (
        <span className="flex min-w-0 items-center gap-1.5">
          <span dir="auto" className="min-w-0 truncate">
            {folder.name}
          </span>
          {star && <StarMark size={11} label={false} />}
        </span>
      ),
      ariaLabel: `${folder.name}${star ? ', starred' : ''}, ${n.toLocaleString()} ${n === 1 ? 'tab' : 'tabs'}`,
      icon: <FolderIcon color={folder.color} />,
      hint: <span className="tabular-nums">{n.toLocaleString()}</span>,
      onSelect: () => onPick(folder),
    };
  };
  const out: MenuEntry[] = stars.map(item);
  if (stars.length && shown.length) out.push({ type: 'separator', key: 'sep-stars' });
  out.push(...shown.map(item));
  if (rest.length > shown.length) {
    const more = rest.length - shown.length;
    out.push({
      key: 'more',
      label: `Show ${more.toLocaleString()} more ${more === 1 ? 'folder' : 'folders'}`,
      keepOpen: true,
      onSelect: onShowAll,
    });
  }
  if (out.length) out.push({ type: 'separator', key: 'sep-new' });
  out.push({ key: 'new', label: 'New folder…', icon: <FolderPlus {...ICON} />, keepOpen: true, onSelect: onNew });
  return out;
}

export function WindowMenu({
  anchor,
  returnFocus,
  name,
  folders,
  counts,
  starred,
  folderLimit,
  start = 'menu',
  heading,
  submenu = false,
  copies = 0,
  canFold = true,
  onFoldInto,
  onTidy,
  onRename,
  onCloseCopies,
  onUpgrade,
  onClose,
}: WindowMenuProps) {
  const [view, setView] = useState<View>(start);
  const [showAll, setShowAll] = useState(false);
  const back = () => setView(start === 'into' || !submenu ? 'into' : 'menu');
  const into = foldIntoEntries({
    folders,
    counts,
    starred,
    showAll,
    onShowAll: () => setShowAll(true),
    onPick: (folder) => onFoldInto({ folderId: folder.id }),
    onNew: () => setView(folderLimit ? 'limit' : 'new'),
  });
  const intoTitle = `Fold “${name}” into`;

  let entries: MenuEntry[];
  let width = 290;
  let label = `Fold ${name} into a folder`;
  if (view === 'menu') {
    width = 232;
    label = `More for ${name}`;
    entries = [
      {
        key: 'into',
        label: 'Fold into…',
        icon: <Folder {...ICON} />,
        disabled: !canFold,
        ...(submenu ? { submenu: into, submenuWidth: 280 } : { keepOpen: true, onSelect: () => setView('into') }),
      },
    ];
    if (onTidy) entries.push({ key: 'tidy', label: 'Tidy into groups', icon: <Group {...ICON} />, onSelect: onTidy });
    if (onRename) entries.push({ key: 'rename', label: 'Rename window', icon: <Pencil {...ICON} />, onSelect: onRename });
    if (copies > 0 && onCloseCopies) {
      entries.push({ type: 'separator', key: 'sep-copies' });
      entries.push({
        key: 'copies',
        label: 'Close the copies',
        icon: <Copy {...ICON} />,
        hint: pages(copies),
        ariaLabel: `Close the copies, ${pages(copies)}`,
        onSelect: onCloseCopies,
      });
    }
  } else if (view === 'into') {
    entries =
      start === 'into' && heading
        ? [headingEntry('heading', heading.title, heading.right), ...into]
        : [
            { key: 'back', label: intoTitle, icon: <ChevronLeft size={16} strokeWidth={2} />, keepOpen: true, onSelect: () => setView('menu') },
            { type: 'separator', key: 'sep-back' },
            ...into,
          ];
  } else if (view === 'new') {
    width = 280;
    label = 'Fold into a new folder';
    // The field comes first so it takes focus; Esc or "Back" returns to the folders.
    entries = [
      headingEntry('heading', 'Fold into a new folder'),
      {
        type: 'custom',
        key: 'field',
        render: (close) => (
          <NewFolderField
            onBack={back}
            onSubmit={(folderName) => {
              close();
              onFoldInto({ newName: folderName });
            }}
          />
        ),
      },
      { type: 'separator', key: 'sep-back' },
      { key: 'back', label: 'Back to the folders', icon: <ChevronLeft size={16} strokeWidth={2} />, keepOpen: true, onSelect: back },
    ];
  } else {
    width = 280;
    label = `Free has ${FREE_LIMITS.folders} folders`;
    entries = [
      {
        type: 'custom',
        key: 'limit',
        render: (close) => (
          <LimitBox
            onBack={back}
            onUpgrade={() => {
              close();
              onUpgrade();
            }}
          />
        ),
      },
    ];
  }

  return (
    <Menu
      // A new view is a new panel: it finds its place again and focuses its first item.
      key={view}
      anchor={anchor}
      entries={entries}
      label={label}
      width={width}
      onClose={onClose}
      returnFocus={returnFocus}
    />
  );
}
