import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Clock, FolderPlus, Plus } from 'lucide-react';
import { FREE_LIMITS } from '@/lib/limits';
import type { PlanState } from '@/lib/pro/types';
import type { LiveFolder } from '@/lib/state';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { ColorDot, FolderIcon } from '@/ui/components/FolderIcon';
import { cx } from '@/ui/cx';
import { nextFolderColor, type TabGroup } from '@/ui/folders';
import { hasFreeLimits } from '@/ui/hooks';
import { createFolder, folderLimitReached, renameFolder } from './folderActions';
import { openDialog, useDrag, useLibraryUi } from './uiStore';

/** Drag-and-drop handlers for one group, shared by the list and the left column. */
export interface DropTarget {
  canDrop: (group: TabGroup) => boolean;
  onDrop: (group: TabGroup, tab: TabRecord) => void;
}

export function dropHandlers(group: TabGroup, target: DropTarget) {
  return {
    onDragOver: (e: DragEvent) => {
      const { tab, setOver } = useDrag.getState();
      if (!tab || !target.canDrop(group)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOver(group.id);
    },
    onDragLeave: (e: DragEvent) => {
      // Leaving for a child of the same target isn't leaving.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      const { over, setOver } = useDrag.getState();
      if (over === group.id) setOver(null);
    },
    onDrop: (e: DragEvent) => {
      const { tab, end } = useDrag.getState();
      if (!tab || !target.canDrop(group)) return;
      e.preventDefault();
      end();
      target.onDrop(group, tab);
    },
  };
}

function Label({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-1 flex h-7 items-center justify-between pr-1 pl-2.5">
      <h2 className="label-caps m-0">{children}</h2>
      {right}
    </div>
  );
}

const ITEM = 'flex h-[30px] items-center gap-2.5 rounded-control px-2.5 no-underline';

function Item({
  group,
  active,
  icon,
  n,
  extra,
  target,
  onJump,
  onRename,
}: {
  group: TabGroup;
  active: boolean;
  icon: ReactNode;
  n: number;
  extra?: ReactNode;
  target: DropTarget;
  onJump: (id: string) => void;
  onRename?: () => void;
}) {
  const over = useDrag((s) => !!s.tab && s.over === group.id);
  return (
    <a
      href="#/"
      aria-current={active ? 'true' : undefined}
      onClick={(e) => {
        e.preventDefault();
        onJump(group.id);
      }}
      onDoubleClick={onRename}
      {...dropHandlers(group, target)}
      className={cx(
        ITEM,
        over
          ? 'bg-accent-soft font-semibold text-accent-text outline-[1.5px] outline-offset-[-1.5px] outline-accent outline-dashed'
          : active
            ? 'bg-hover font-semibold text-text hover:bg-hover'
            : 'text-text-2 hover:bg-hover',
      )}
    >
      {icon}
      <span dir="auto" className="min-w-0 flex-1 truncate">
        {group.name}
      </span>
      {extra}
      <span className="text-small font-normal text-text-3 tabular-nums">{n.toLocaleString()}</span>
    </a>
  );
}

/** The left column's "New folder" field (Fo-Folders-States): Enter makes it, Esc cancels. */
function NewFolderField({ folders, onDone }: { folders: readonly FolderRecord[]; onDone: () => void }) {
  const [name, setName] = useState('');
  const color = nextFolderColor(folders);
  const busy = useRef(false);
  const cancelled = useRef(false);
  const submit = async () => {
    // Esc already closed it (a blur can follow while the field goes away).
    if (busy.current || cancelled.current) return;
    if (!name.trim()) {
      onDone();
      return;
    }
    busy.current = true;
    await createFolder(name, color);
    busy.current = false;
    onDone();
  };
  return (
    <div>
      <div className="flex h-8 items-center gap-2.5 rounded-control border border-accent bg-surface pr-1.5 pl-2.5 shadow-[0_0_0_3px_var(--tf-accent-line)]">
        <FolderIcon color={color} size={15} />
        <input
          autoFocus
          aria-label="Folder name"
          aria-describedby="new-folder-hint"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancelled.current = true;
              onDone();
            }
          }}
          onBlur={() => void submit()}
          className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none"
        />
      </div>
      <p id="new-folder-hint" className="m-0 mt-1.5 mb-1 px-2.5 text-meta text-text-3">
        Enter to create · Esc to cancel
      </p>
    </div>
  );
}

/** A folder's name edited in place in the left column (double-click, or Rename). */
function RenameField({ folder, onDone }: { folder: FolderRecord; onDone: () => void }) {
  const [name, setName] = useState(folder.name);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) void renameFolder(folder, name);
    onDone();
  };
  return (
    <div className="flex h-8 items-center gap-2.5 rounded-control border border-accent bg-surface pr-1.5 pl-2.5 shadow-[0_0_0_3px_var(--tf-accent-line)]">
      <FolderIcon color={folder.color} size={15} />
      <input
        autoFocus
        aria-label={`Rename ${folder.name}`}
        value={name}
        maxLength={60}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none"
      />
    </div>
  );
}

/**
 * The left column (Fo-List, Mx-Live): "Snoozed" when any, the folders with "+" and "New folder ·
 * 2 of 3" on Free, then the kinds of site. Items jump to their group and take dropped tabs.
 */
export function Sidebar({
  snoozed,
  folders,
  folderGroups,
  sites,
  current,
  liveFolders,
  plan,
  target,
  onJump,
}: {
  snoozed: number;
  folders: readonly FolderRecord[];
  folderGroups: TabGroup[];
  sites: TabGroup[];
  current: string | undefined;
  liveFolders: Record<string, LiveFolder>;
  plan: PlanState;
  target: DropTarget;
  onJump: (id: string) => void;
}) {
  const creating = useLibraryUi((s) => s.creating);
  const setCreating = useLibraryUi((s) => s.setCreating);
  const renaming = useLibraryUi((s) => s.renaming);
  const setRenaming = useLibraryUi((s) => s.setRenaming);
  const free = hasFreeLimits(plan);
  const startNew = () => {
    if (folderLimitReached(plan, folders)) openDialog({ kind: 'folder-limit' });
    else setCreating(true);
  };
  useEffect(() => {
    if (creating && folderLimitReached(plan, folders)) setCreating(false);
  }, [creating, plan, folders, setCreating]);

  return (
    <nav
      aria-label="Folders and groups"
      className="scroll-thin sticky top-6 col-start-1 row-start-2 mt-[9px] flex max-h-[calc(100vh-112px)] w-44 flex-col gap-0.5 self-start overflow-y-auto max-[1319px]:hidden"
    >
      {snoozed > 0 && (
        <a
          href="#/"
          aria-current={current === 'snoozed' ? 'true' : undefined}
          onClick={(e) => {
            e.preventDefault();
            onJump('snoozed');
          }}
          className={cx(ITEM, 'mb-2', current === 'snoozed' ? 'bg-hover font-semibold text-text' : 'text-text-2 hover:bg-hover')}
        >
          <Clock size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
          <span className="min-w-0 flex-1 truncate">Snoozed</span>
          <span className="text-small font-normal text-text-3 tabular-nums">{snoozed}</span>
        </a>
      )}
      <Label
        right={
          <button
            type="button"
            aria-label="New folder"
            title="New folder"
            onClick={startNew}
            className="inline-flex size-6 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
          >
            <Plus size={14} strokeWidth={1.75} aria-hidden />
          </button>
        }
      >
        Folders
      </Label>
      {folderGroups.map((group) => {
        const folder = group.folder!;
        if (renaming?.id === folder.id && renaming.where === 'side') return <RenameField key={group.id} folder={folder} onDone={() => setRenaming(null)} />;
        return (
          <Item
            key={group.id}
            group={group}
            active={group.id === current}
            icon={<FolderIcon color={group.color} size={15} />}
            n={group.items.length}
            extra={liveFolders[folder.id] ? <span aria-label="Live" role="img" className="size-1.5 shrink-0 rounded-full bg-green" /> : undefined}
            target={target}
            onJump={onJump}
            onRename={() => setRenaming({ id: folder.id, where: 'side' })}
          />
        );
      })}
      {creating ? (
        <NewFolderField folders={folders} onDone={() => setCreating(false)} />
      ) : (
        <button type="button" onClick={startNew} className={cx(ITEM, 'w-full text-left text-text-2 hover:bg-hover')}>
          <FolderPlus size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
          <span className="flex-1">New folder</span>
          {free && (
            <span className="text-meta text-text-3 tabular-nums">
              {Math.min(folders.length, FREE_LIMITS.folders)} of {FREE_LIMITS.folders}
            </span>
          )}
        </button>
      )}
      {sites.length > 0 && (
        <>
          <div className="h-2.5" />
          <Label>By site</Label>
          {sites.map((group) => (
            <Item
              key={group.id}
              group={group}
              active={group.id === current}
              icon={<ColorDot color={group.color} size={8} />}
              n={group.items.length}
              target={target}
              onJump={onJump}
            />
          ))}
        </>
      )}
    </nav>
  );
}
