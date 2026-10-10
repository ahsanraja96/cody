import { useRef, useState } from 'react';
import { ArrowDownToLine, MoreHorizontal, Pin } from 'lucide-react';
import { timeAgo, plural } from '@/lib/format';
import type { SessionRecord } from '@/lib/types';
import { IconButton } from '@/ui/components/Button';
import { Kbd, TagChip } from '@/ui/components/Chips';
import { Menu, type MenuItem } from '@/ui/components/Menu';
import { showProInfo } from '@/ui/components/ProDialog';
import { cx } from '@/ui/cx';
import { useTabDrop } from './dnd';
import { ProMark, SelectBox, SiteStrip } from './views/parts';

/**
 * The session menu (cards, list rows and the detail panel). Merge stays visible on Free with a
 * lock and opens the Pro explainer.
 */
export function sessionMenuItems(
  session: SessionRecord,
  handlers: {
    onRename?: () => void;
    onTags?: () => void;
    onPin: () => void;
    onDuplicate: () => void;
    onExport: () => void;
    onMerge?: () => void;
    onTrash: () => void;
  },
): MenuItem[] {
  return [
    ...(handlers.onRename ? [{ label: 'Rename', onSelect: handlers.onRename }] : []),
    ...(handlers.onTags ? [{ label: 'Tags…', onSelect: handlers.onTags }] : []),
    { label: session.pinned ? 'Unpin' : 'Pin', onSelect: handlers.onPin },
    { label: 'Duplicate', onSelect: handlers.onDuplicate },
    { label: 'Export…', onSelect: handlers.onExport },
    { label: 'Merge with…', onSelect: handlers.onMerge ?? (() => showProInfo('Merging sessions')), hint: <ProMark /> },
    'separator',
    { label: 'Move to Trash', onSelect: handlers.onTrash, danger: true },
  ];
}

/** Inline name editor: Enter or clicking away saves, Esc puts the old name back, empty is never saved. */
function RenameField({ name, onDone, compact = false }: { name: string; onDone: (name: string | null) => void; compact?: boolean }) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    const trimmed = next?.trim();
    onDone(trimmed && trimmed !== name ? trimmed : null);
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
      <label className="flex h-[30px] items-center rounded-control border border-accent bg-surface px-2 shadow-[0_0_0_3px_var(--tf-accent-soft)]">
        <input
          autoFocus
          dir="auto"
          value={value}
          aria-label="Session name"
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(value);
            else if (e.key === 'Escape') finish(null);
          }}
          onBlur={() => finish(value)}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 font-semibold text-text outline-none"
        />
      </label>
      {!compact && (
        <span className="flex items-center gap-1.5 text-meta text-text-3">
          <Kbd>↵</Kbd>to save<Kbd>Esc</Kbd>to cancel
        </span>
      )}
    </div>
  );
}

export interface SessionItemProps {
  session: SessionRecord;
  /** Open in the detail panel. */
  current: boolean;
  /** Part of the multi-selection. */
  checked: boolean;
  /** A multi-selection is in progress, so cards show their checkbox. */
  selecting: boolean;
  renaming: boolean;
  onClick: (e: React.MouseEvent) => void;
  onCheck: (e: React.MouseEvent) => void;
  onRestore: () => void;
  onRenamed: (name: string | null) => void;
  menu: MenuItem[];
}

function SessionMenu({ session, items, triggerClass }: { session: SessionRecord; items: MenuItem[]; triggerClass?: string }) {
  return (
    <Menu
      label={`Actions for ${session.name}`}
      items={items}
      trigger={(props) => (
        <IconButton
          label={`Actions for ${session.name}`}
          size="sm"
          tone="muted"
          className={cx('aria-expanded:bg-hover aria-expanded:text-text', triggerClass)}
          {...props}
        >
          <MoreHorizontal size={16} aria-hidden />
        </IconButton>
      )}
    />
  );
}

/** Right-click opens the same menu as ⋯. */
function openMenuFrom(root: HTMLElement | null, e: React.MouseEvent) {
  const trigger = root?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!trigger || (e.target as Element).closest('input')) return;
  e.preventDefault();
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
}

export function SessionCard({
  session,
  current,
  checked,
  selecting,
  renaming,
  onClick,
  onCheck,
  onRestore,
  onRenamed,
  menu,
}: SessionItemProps) {
  const drop = useTabDrop(session);
  const root = useRef<HTMLElement>(null);
  return (
    <article
      ref={root}
      aria-label={session.name}
      aria-current={current || undefined}
      {...drop.props}
      onClick={onClick}
      onContextMenu={(e) => openMenuFrom(root.current, e)}
      className={cx(
        'group flex h-full min-w-0 cursor-pointer flex-col gap-2.5 rounded-card border p-3.5 transition-colors duration-150',
        drop.over
          ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--tf-accent)]'
          : checked
            ? 'border-accent-line bg-accent-soft'
            : 'bg-surface',
        !drop.over && (current ? 'border-accent shadow-[0_0_0_1px_var(--tf-accent)]' : !checked && 'border-border hover:border-border-strong'),
        'has-[button:focus-visible]:border-accent',
      )}
    >
      <div className="flex min-h-6 items-center gap-2">
        {(selecting || checked) && !renaming && (
          <SelectBox checked={checked} label={`Select ${session.name}`} onToggle={onCheck} className="mr-0.5" />
        )}
        {renaming ? (
          <RenameField name={session.name} onDone={onRenamed} />
        ) : (
          <>
            <button
              type="button"
              dir="auto"
              title={session.name}
              onClick={(e) => {
                e.stopPropagation();
                onClick(e);
              }}
              className="min-w-0 flex-1 truncate text-left font-semibold focus-visible:outline-none"
            >
              {session.name}
            </button>
            {session.pinned === 1 && <Pin size={13} aria-label="Pinned" className="shrink-0 text-text-3" />}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRestore();
              }}
              className="hidden h-6 shrink-0 items-center rounded-md border border-border-strong bg-surface px-2 text-meta font-semibold text-text group-hover:inline-flex group-has-[button:focus-visible]:inline-flex hover:bg-hover"
            >
              Restore
            </button>
            <SessionMenu session={session} items={menu} />
          </>
        )}
      </div>
      <div className="flex min-h-5 flex-wrap gap-1.5 overflow-hidden" style={{ maxHeight: 20 }}>
        {session.kind === 'unsorted' && (
          <span className="inline-flex h-5 items-center rounded-full border border-dashed border-border-strong px-2 text-meta text-text-2">
            Saves after the Free limit
          </span>
        )}
        {session.tags.map((tag) => (
          <TagChip key={tag} tag={tag} />
        ))}
      </div>
      <SiteStrip preview={session.preview} total={session.tabCount} />
      {drop.over ? (
        <div className="mt-auto flex items-center gap-1.5 text-small font-semibold text-accent-text">
          <ArrowDownToLine size={14} aria-hidden />
          <span className="truncate">Drop to move into {session.name}</span>
        </div>
      ) : (
        <div className="mt-auto flex items-center justify-between gap-2 text-meta text-text-3">
          <span className="truncate">
            {plural(session.tabCount, 'tab')} · {plural(session.windowCount, 'window')}
          </span>
          <span className="shrink-0">{timeAgo(session.updatedAt)}</span>
        </div>
      )}
    </article>
  );
}

/** One row of the list view (Library-List): checkbox, name, tags, counts, sites, updated, actions. */
export function SessionListRow({
  session,
  current,
  checked,
  renaming,
  onClick,
  onCheck,
  onRestore,
  onRenamed,
  menu,
  last,
}: SessionItemProps & { last: boolean }) {
  const drop = useTabDrop(session);
  const root = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={root}
      role="row"
      aria-selected={checked}
      aria-current={current || undefined}
      {...drop.props}
      onClick={onClick}
      onContextMenu={(e) => openMenuFrom(root.current, e)}
      className={cx(
        'group flex h-12 cursor-pointer items-center gap-3 pr-3 pl-4',
        !last && 'border-b border-border',
        drop.over ? 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--tf-accent)]' : checked ? 'bg-accent-soft' : 'hover:bg-hover has-[button:focus-visible]:bg-hover',
        current && !drop.over && 'shadow-[inset_3px_0_0_var(--tf-accent)]',
      )}
    >
      <span role="gridcell" className="flex w-6 shrink-0">
        <SelectBox checked={checked} label={`Select ${session.name}`} onToggle={onCheck} />
      </span>
      <span role="gridcell" className="flex min-w-0 flex-1 items-center gap-2">
        {renaming ? (
          <RenameField name={session.name} onDone={onRenamed} compact />
        ) : (
          <>
            <button
              type="button"
              dir="auto"
              title={session.name}
              onClick={(e) => {
                e.stopPropagation();
                onClick(e);
              }}
              className="min-w-0 truncate text-left font-semibold"
            >
              {session.name}
            </button>
            {session.pinned === 1 && <Pin size={13} aria-label="Pinned" className="shrink-0 text-text-3" />}
          </>
        )}
      </span>
      <span role="gridcell" className="flex w-[200px] shrink-0 gap-1.5 overflow-hidden @max-[720px]:hidden">
        {session.kind === 'unsorted' ? (
          <span className="inline-flex h-5 items-center rounded-full border border-dashed border-border-strong px-2 text-meta whitespace-nowrap text-text-2">
            After the Free limit
          </span>
        ) : session.tags.length ? (
          session.tags.map((tag) => <TagChip key={tag} tag={tag} />)
        ) : (
          <span className="text-meta text-text-3">—</span>
        )}
      </span>
      <span role="gridcell" className="w-14 shrink-0 text-right text-text-2 tabular-nums">
        {session.tabCount.toLocaleString()}
      </span>
      <span role="gridcell" className="w-[72px] shrink-0 text-right text-text-2 tabular-nums @max-[860px]:hidden">
        {session.windowCount.toLocaleString()}
      </span>
      <span role="gridcell" className="flex w-[184px] shrink-0 pl-4 @max-[980px]:hidden">
        <SiteStrip preview={session.preview} total={session.tabCount} />
      </span>
      <span role="gridcell" className="w-24 shrink-0 truncate text-right text-small text-text-3">
        {drop.over ? <span className="font-semibold text-accent-text">Drop to move here</span> : timeAgo(session.updatedAt)}
      </span>
      <span className="flex w-[104px] shrink-0 items-center justify-end gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
          className="invisible h-7 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text group-hover:visible group-has-[button:focus-visible]:visible hover:bg-hover"
        >
          Restore
        </button>
        <SessionMenu session={session} items={menu} triggerClass="size-7 rounded-control" />
      </span>
    </div>
  );
}
