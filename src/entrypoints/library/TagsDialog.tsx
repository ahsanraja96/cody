import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Plus, X } from 'lucide-react';
import { normalizeKeyword } from '@/lib/keywords';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { plural } from '@/lib/format';
import { LimitError, setSessionTags, tagCounts } from '@/lib/repo';
import type { SessionRecord } from '@/lib/types';
import { Banner } from '@/ui/components/Banner';
import { Button, IconButton } from '@/ui/components/Button';
import { tagColor } from '@/ui/components/Chips';
import { Dialog } from '@/ui/components/Dialog';
import { showProInfo } from '@/ui/components/ProDialog';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';

type State = boolean | 'mixed';

/**
 * Tags for one session, or for several at once (from the bulk bar). Every tag in use is a checkbox;
 * a new tag can be typed while the Free plan has room. Tags already in use can always be added or
 * removed; only a sixth tag needs Pro.
 */
export function TagsDialog({
  session,
  sessions,
  onClose,
  focusNew = false,
}: {
  session?: SessionRecord | null;
  sessions?: SessionRecord[] | null;
  onClose: () => void;
  /** Start in the "New tag" field. */
  focusNew?: boolean;
}) {
  const targets = useMemo(() => sessions ?? (session ? [session] : []), [session, sessions]);
  const open = targets.length > 0;
  const targetKey = targets.map((t) => t.id).join('|');
  const all = useLiveQuery(() => tagCounts(), []) ?? [];
  const limit = limitsFor(CURRENT_PLAN).tags;
  const [states, setStates] = useState<Map<string, State>>(new Map());
  const [created, setCreated] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Fresh state each time the dialog opens for a different set of sessions.
  useEffect(() => {
    const next = new Map<string, State>();
    const tags = new Set(targets.flatMap((t) => t.tags));
    for (const tag of tags) {
      const count = targets.filter((t) => t.tags.includes(tag)).length;
      next.set(tag, count === targets.length ? true : 'mixed');
    }
    setStates(next);
    setCreated([]);
    setText('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const counts = new Map(all.map((t) => [t.tag, t.count]));
  const rows = [...all.map((t) => t.tag), ...created.filter((t) => !counts.has(t))];
  for (const tag of states.keys()) if (!rows.includes(tag)) rows.push(tag);
  const inUse = new Set(rows).size;
  const atLimit = Number.isFinite(limit) && inUse >= limit;

  const set = (tag: string, value: State) => setStates((prev) => new Map(prev).set(tag, value));

  const addNew = () => {
    const tag = normalizeKeyword(text);
    setText('');
    if (!tag) return;
    if (!rows.includes(tag)) {
      if (atLimit) return;
      setCreated((prev) => [...prev, tag]);
    }
    set(tag, true);
  };

  const save = async () => {
    if (!open || saving) return;
    setSaving(true);
    setError(null);
    try {
      for (const target of targets) {
        const next = target.tags.filter((tag) => states.get(tag) !== false);
        for (const [tag, value] of states) if (value === true && !next.includes(tag)) next.push(tag);
        if (next.join('|') !== target.tags.join('|')) await setSessionTags(target.id, next);
      }
      if (targets.length > 1) toast(`Updated tags on ${plural(targets.length, 'session')}.`);
      onClose();
    } catch (e) {
      setError(e instanceof LimitError ? e.message : 'Could not save tags. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const title = targets.length > 1 ? `Tags for ${plural(targets.length, 'session')}` : `Tags for ${targets[0]?.name ?? ''}`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={400}
      title={
        <span className="flex min-h-7 items-center gap-2">
          <span dir="auto" className="min-w-0 flex-1 truncate">
            {title}
          </span>
          <IconButton label="Close" size="md" className="rounded-control" onClick={onClose}>
            <X size={16} aria-hidden />
          </IconButton>
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            Save tags
          </Button>
        </>
      }
    >
      {rows.length > 0 && (
        <div role="group" aria-label="Tags" className="flex flex-col rounded-control border border-border p-1">
          {rows.map((tag) => {
            const value = states.get(tag) ?? false;
            const count = counts.get(tag);
            return (
              <label key={tag} className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 hover:bg-hover">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={value === true}
                  ref={(el) => {
                    if (el) el.indeterminate = value === 'mixed';
                  }}
                  onChange={() => set(tag, value === true ? false : true)}
                />
                <span
                  aria-hidden
                  className={cx(
                    'inline-flex size-4 shrink-0 items-center justify-center rounded peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
                    value ? 'bg-accent text-on-accent' : 'border border-border-strong bg-surface',
                  )}
                >
                  {value === 'mixed' ? <span className="h-0.5 w-2 rounded bg-current" /> : value && <Check size={11} strokeWidth={3} />}
                </span>
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: tagColor(tag) }} />
                <span className="min-w-0 flex-1 truncate">{tag}</span>
                <span className="text-meta text-text-3">{count ? plural(count, 'session') : 'New'}</span>
              </label>
            );
          })}
        </div>
      )}
      <label
        className={cx(
          'flex h-9 items-center gap-2 rounded-control border px-2.5',
          atLimit
            ? 'cursor-not-allowed border-border bg-bg-subtle text-text-3'
            : 'border-border-strong bg-surface text-text-3 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]',
        )}
      >
        <Plus size={14} aria-hidden />
        <input
          autoFocus={focusNew || rows.length === 0}
          disabled={atLimit}
          value={text}
          placeholder="New tag"
          aria-label="New tag"
          aria-describedby="tags-limit-note"
          onChange={(e) => setText(e.target.value.replace(',', ''))}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && text.trim()) {
              e.preventDefault();
              addNew();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
          }}
          className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none disabled:cursor-not-allowed"
        />
      </label>
      {Number.isFinite(limit) && (
        <p id="tags-limit-note" className="text-small text-text-2">
          {Math.min(inUse, limit)} of {limit} tags on Free
          {atLimit && (
            <>
              {' · '}
              <button type="button" className="font-semibold text-accent-text hover:underline" onClick={() => showProInfo('Unlimited tags')}>
                Pro adds unlimited tags
              </button>
            </>
          )}
        </p>
      )}
      {error && (
        <Banner tone="warning" role="alert">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}
