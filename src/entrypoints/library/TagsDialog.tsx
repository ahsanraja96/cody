import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { normalizeKeyword } from '@/lib/keywords';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { LimitError, setSessionTags, tagCounts } from '@/lib/repo';
import type { SessionRecord } from '@/lib/types';
import { Banner } from '@/ui/components/Banner';
import { Button } from '@/ui/components/Button';
import { PickChip, TagChip } from '@/ui/components/Chips';
import { Dialog } from '@/ui/components/Dialog';

export function TagsDialog({ session, onClose }: { session: SessionRecord | null; onClose: () => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const all = useLiveQuery(() => tagCounts(), []) ?? [];
  const limit = limitsFor(CURRENT_PLAN).tags;

  useEffect(() => {
    setTags(session?.tags ?? []);
    setText('');
    setError(null);
  }, [session]);

  const add = (raw: string) => {
    const tag = normalizeKeyword(raw);
    if (tag && !tags.includes(tag)) setTags([...tags, tag]);
    setText('');
  };

  const save = async () => {
    if (!session) return;
    const pending = normalizeKeyword(text);
    const next = pending && !tags.includes(pending) ? [...tags, pending] : tags;
    try {
      await setSessionTags(session.id, next);
      onClose();
    } catch (e) {
      setError(e instanceof LimitError ? e.message : 'Could not save tags.');
    }
  };

  return (
    <Dialog
      open={!!session}
      onClose={onClose}
      title={`Tags for ${session?.name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save tags
          </Button>
        </>
      }
    >
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-control border border-border-strong px-2 py-1.5 focus-within:border-accent">
        {tags.map((tag) => (
          <TagChip key={tag} tag={tag} size="md" onRemove={() => setTags(tags.filter((t) => t !== tag))} />
        ))}
        <input
          autoFocus
          value={text}
          aria-label="Add a tag"
          placeholder={tags.length ? '' : 'Add a tag, e.g. client-x'}
          onChange={(e) => setText(e.target.value.replace(',', ''))}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && text.trim()) {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Backspace' && !text && tags.length) {
              setTags(tags.slice(0, -1));
            }
          }}
          className="h-6 min-w-[120px] flex-1 border-0 bg-transparent px-1 outline-none"
        />
      </div>
      {all.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {all.map(({ tag }) => (
            <PickChip
              key={tag}
              keyword={tag}
              picked={tags.includes(tag)}
              onToggle={() => setTags(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag])}
            />
          ))}
        </div>
      )}
      {Number.isFinite(limit) && (
        <p className="text-meta text-text-3">
          Free includes {limit} different tags across all sessions. You're using {all.length}.
        </p>
      )}
      {error && <Banner tone="warning">{error}</Banner>}
    </Dialog>
  );
}
