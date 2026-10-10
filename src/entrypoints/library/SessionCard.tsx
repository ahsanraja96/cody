import { memo, useState } from 'react';
import { MoreHorizontal, Pin } from 'lucide-react';
import { timeAgo, plural } from '@/lib/format';
import { moveTab } from '@/lib/repo';
import type { SessionRecord } from '@/lib/types';
import { IconButton, Button } from '@/ui/components/Button';
import { TagChip } from '@/ui/components/Chips';
import { Favicon } from '@/ui/components/Favicon';
import { Menu, type MenuItem } from '@/ui/components/Menu';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { TAB_DRAG_TYPE } from './dnd';

export function sessionMenuItems(
  session: SessionRecord,
  handlers: {
    onRename?: () => void;
    onTags?: () => void;
    onPin: () => void;
    onDuplicate: () => void;
    onExport: () => void;
    onTrash: () => void;
  },
): MenuItem[] {
  return [
    ...(handlers.onRename ? [{ label: 'Rename', onSelect: handlers.onRename }] : []),
    ...(handlers.onTags ? [{ label: 'Tags…', onSelect: handlers.onTags }] : []),
    { label: session.pinned ? 'Unpin' : 'Pin', onSelect: handlers.onPin },
    { label: 'Duplicate', onSelect: handlers.onDuplicate },
    { label: 'Export as HTML', onSelect: handlers.onExport },
    'separator',
    { label: 'Move to Trash', onSelect: handlers.onTrash, danger: true },
  ];
}

/** Drop a dragged tab on a card to move it into that session. */
function useTabDrop(sessionId: string) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: async (e: React.DragEvent) => {
        setOver(false);
        const tabId = e.dataTransfer.getData(TAB_DRAG_TYPE);
        if (!tabId) return;
        e.preventDefault();
        await moveTab(tabId, { sessionId });
        toast('Moved the tab.');
      },
    },
  };
}

export const SessionCard = memo(function SessionCard({
  session,
  selected,
  onSelect,
  onRestore,
  menu,
}: {
  session: SessionRecord;
  selected: boolean;
  onSelect: () => void;
  onRestore: () => void;
  menu: MenuItem[];
}) {
  const drop = useTabDrop(session.id);
  const more = session.tabCount - session.preview.length;
  return (
    <article
      aria-label={session.name}
      aria-current={selected || undefined}
      {...drop.props}
      onClick={onSelect}
      className={cx(
        'group flex h-full cursor-pointer flex-col gap-2.5 rounded-card border bg-surface p-3.5 transition-colors duration-150',
        selected ? 'border-accent shadow-[0_0_0_1px_var(--tf-accent)]' : 'border-border hover:border-border-strong',
        drop.over && 'border-accent bg-accent-soft',
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          className="min-w-0 flex-1 truncate text-left font-semibold"
        >
          {session.name}
        </button>
        {session.pinned === 1 && <Pin size={13} aria-label="Pinned" className="shrink-0 text-text-3" />}
        <Button
          size="xs"
          className="hidden group-focus-within:inline-flex group-hover:inline-flex"
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
        >
          Restore
        </Button>
        <Menu
          label={`Actions for ${session.name}`}
          items={menu}
          trigger={(props) => (
            <IconButton label={`Actions for ${session.name}`} size="sm" tone="muted" {...props}>
              <MoreHorizontal size={16} aria-hidden />
            </IconButton>
          )}
        />
      </div>
      {(session.tags.length > 0 || session.kind === 'unsorted') && (
        <div className="flex flex-wrap gap-1.5">
          {session.kind === 'unsorted' && (
            <span className="inline-flex h-5 items-center rounded-full border border-dashed border-border-strong px-2 text-meta text-text-2">
              Saves after the Free limit
            </span>
          )}
          {session.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </div>
      )}
      <div aria-hidden className="flex items-center gap-1">
        {session.preview.map((p) => (
          <Favicon key={p.url} url={p.url} size={18} />
        ))}
        {more > 0 && <span className="ml-0.5 text-meta text-text-3">+{more}</span>}
      </div>
      <div className="mt-auto flex items-center justify-between text-meta text-text-3">
        <span>
          {plural(session.tabCount, 'tab')} · {plural(session.windowCount, 'window')}
        </span>
        <span>{timeAgo(session.updatedAt)}</span>
      </div>
    </article>
  );
});

export const SessionListRow = memo(function SessionListRow({
  session,
  selected,
  onSelect,
  onRestore,
  menu,
}: {
  session: SessionRecord;
  selected: boolean;
  onSelect: () => void;
  onRestore: () => void;
  menu: MenuItem[];
}) {
  const drop = useTabDrop(session.id);
  return (
    <div
      {...drop.props}
      onClick={onSelect}
      aria-current={selected || undefined}
      className={cx(
        'group flex h-12 cursor-pointer items-center gap-3 rounded-control border px-3',
        selected ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-hover',
        drop.over && 'border-accent bg-accent-soft',
      )}
    >
      <span aria-hidden className="flex w-[66px] shrink-0 gap-1">
        {session.preview.slice(0, 3).map((p) => (
          <Favicon key={p.url} url={p.url} size={16} />
        ))}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        className="min-w-0 flex-1 truncate text-left font-semibold"
      >
        {session.name}
      </button>
      <span className="hidden gap-1.5 md:flex">
        {session.tags.slice(0, 3).map((tag) => (
          <TagChip key={tag} tag={tag} />
        ))}
      </span>
      <span className="w-28 shrink-0 text-right text-meta text-text-3">{plural(session.tabCount, 'tab')}</span>
      <span className="w-24 shrink-0 text-right text-meta text-text-3">{timeAgo(session.updatedAt)}</span>
      <Button
        size="xs"
        className="invisible group-focus-within:visible group-hover:visible"
        onClick={(e) => {
          e.stopPropagation();
          onRestore();
        }}
      >
        Restore
      </Button>
      <Menu
        label={`Actions for ${session.name}`}
        items={menu}
        trigger={(props) => (
          <IconButton label={`Actions for ${session.name}`} size="sm" tone="muted" {...props}>
            <MoreHorizontal size={16} aria-hidden />
          </IconButton>
        )}
      />
    </div>
  );
});
