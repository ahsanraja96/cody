import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { plural } from '@/lib/format';
import { normalizeKeyword } from '@/lib/keywords';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { deleteTag, renameTag } from '@/lib/repo';
import { IconButton } from '@/ui/components/Button';
import { tagColor } from '@/ui/components/Chips';
import { confirmAction } from '@/ui/components/Dialog';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import type { Route } from '../router';

function RenameInput({ tag, onDone }: { tag: string; onDone: (next: string | null) => void }) {
  const [value, setValue] = useState(tag);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    const clean = next === null ? '' : normalizeKeyword(next);
    onDone(clean && clean !== tag ? clean : null);
  };
  return (
    <input
      autoFocus
      dir="auto"
      value={value}
      aria-label={`New name for ${tag}`}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value)}
      className="h-7 min-w-0 flex-1 rounded-md border border-accent bg-surface px-2 font-semibold text-text shadow-[0_0_0_3px_var(--tf-accent-soft)] outline-none"
    />
  );
}

/**
 * Manage tags popover (Library-Tag): rename or delete each tag, with session counts, and the Free
 * limit in the footer. New tags are made on a session, so "New tag" opens the open session's tags.
 */
export function ManageTags({
  tags,
  route,
  navigate,
  onClose,
  onNewTag,
  className,
}: {
  tags: Array<{ tag: string; count: number }>;
  route: Route;
  navigate: (route: Route) => void;
  onClose: () => void;
  /** Present when a session is open in the detail panel. */
  onNewTag?: () => void;
  className?: string;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const limit = limitsFor(CURRENT_PLAN).tags;
  const limited = Number.isFinite(limit);
  const atLimit = limited && tags.length >= limit;

  useEffect(() => {
    root.current?.focus();
  }, []);

  const rename = async (from: string, to: string | null) => {
    setRenaming(null);
    if (!to) return;
    try {
      await renameTag(from, to);
      if (route.view === 'tag' && route.tag === from) navigate({ view: 'tag', tag: to });
    } catch {
      toast('Could not rename the tag. Please try again.', { tone: 'error' });
    }
  };

  const remove = async (tag: string, count: number) => {
    const ok = await confirmAction({
      title: `Delete the tag “${tag}”?`,
      body: `It comes off ${plural(count, 'session')}. The sessions themselves stay.`,
      confirmLabel: 'Delete tag',
      danger: true,
    });
    if (!ok) return;
    await deleteTag(tag);
    if (route.view === 'tag' && route.tag === tag) navigate({ view: 'all' });
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Manage tags"
      tabIndex={-1}
      className={cx('anim-in absolute z-50 w-[340px] rounded-card border border-border bg-surface shadow-pop outline-none', className)}
    >
      <div className="flex h-12 items-center gap-2 border-b border-border pr-2 pl-4">
        <h2 className="flex-1 text-section font-semibold">Manage tags</h2>
        <IconButton label="Close" className="rounded-control" onClick={onClose}>
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      {tags.length === 0 ? (
        <p className="px-4 py-4 text-text-2">No tags yet. Add one from a session's Tags… menu.</p>
      ) : (
        <ul className="scroll-thin max-h-[320px] overflow-y-auto p-1.5">
          {tags.map(({ tag, count }) => (
            <li key={tag} className="group flex h-10 items-center gap-2.5 rounded-control pr-1.5 pl-2.5 hover:bg-hover has-[:focus-visible]:bg-hover">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: tagColor(tag) }} />
              {renaming === tag ? (
                <RenameInput tag={tag} onDone={(next) => void rename(tag, next)} />
              ) : (
                <>
                  <span className={cx('min-w-0 flex-1 truncate', route.view === 'tag' && route.tag === tag && 'font-semibold')}>{tag}</span>
                  <span className="text-meta text-text-3">{plural(count, 'session')}</span>
                  <IconButton label={`Rename ${tag}`} tone="muted" className="rounded-control group-hover:text-text-2" onClick={() => setRenaming(tag)}>
                    <Pencil size={14} aria-hidden />
                  </IconButton>
                  <IconButton label={`Delete ${tag}`} tone="muted" className="rounded-control group-hover:text-text-2" onClick={() => void remove(tag, count)}>
                    <Trash2 size={14} aria-hidden />
                  </IconButton>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {limited && (
        <div className="flex flex-col gap-1 rounded-b-card border-t border-border bg-bg-subtle px-4 pt-3 pb-3.5">
          <div className="flex items-center gap-3">
            <span className="flex-1 font-semibold">
              {Math.min(tags.length, limit)} of {limit} tags on Free
            </span>
            <button
              type="button"
              disabled={atLimit || !onNewTag}
              aria-describedby="tag-limit-note"
              onClick={() => {
                onClose();
                onNewTag?.();
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3 text-text hover:bg-hover disabled:cursor-not-allowed disabled:border-border disabled:text-text-3 disabled:hover:bg-surface"
            >
              <Plus size={14} aria-hidden />
              New tag
            </button>
          </div>
          <p id="tag-limit-note" className="text-small text-text-3">
            {atLimit
              ? 'Pro adds unlimited tags. To add one now, delete a tag you no longer use.'
              : onNewTag
                ? 'New tags go on the session that is open.'
                : 'Open a session to give it a new tag.'}
          </p>
        </div>
      )}
    </div>
  );
}
