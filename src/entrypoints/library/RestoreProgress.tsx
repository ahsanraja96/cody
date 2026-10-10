import { Button } from '@/ui/components/Button';

export function RestoreProgress({ done, total, onCancel }: { done: number; total: number; onCancel: () => void }) {
  if (total < 20) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <div role="status" className="fixed right-6 bottom-6 z-40 w-80 rounded-card border border-border bg-surface p-4 shadow-pop">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">
          Restoring {done.toLocaleString()} of {total.toLocaleString()} tabs
        </span>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-hover">
        <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-meta text-text-3">Tabs open unloaded and load when you click them.</p>
    </div>
  );
}
