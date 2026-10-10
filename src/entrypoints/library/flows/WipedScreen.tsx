import { useState } from 'react';
import { AlertTriangle, History, Upload } from 'lucide-react';
import { acknowledgeWipe, type WipeCheck } from '@/lib/dataGuard';
import { plural } from '@/lib/format';
import { send } from '@/lib/messages';
import { Button } from '@/ui/components/Button';
import { toast } from '@/ui/components/Toast';
import { openImportDialog } from './index';

function snapshotTime(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * The database is empty but Tabfold's own record (outside IndexedDB) remembers sessions: Chrome's
 * site data was cleared (Edge-Data). Offer the mirrored snapshot, a backup file, and an explanation.
 */
export function WipedScreen({
  check,
  onRecovered,
  onDismissed,
}: {
  check: WipeCheck;
  onRecovered: (sessionId: string) => void;
  onDismissed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState(false);
  const sessions = check.guard?.sessions ?? 0;
  const mirror = check.mirror;

  const restore = async () => {
    setBusy(true);
    try {
      const { sessionId } = await send({ type: 'recover-from-mirror' });
      if (!sessionId) {
        toast("Couldn't restore the snapshot. Import a backup file instead.", { tone: 'error' });
        return;
      }
      await acknowledgeWipe();
      toast('The snapshot is back as a session. Nothing opens until you restore it.');
      onRecovered(sessionId);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't restore the snapshot.", { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scroll-thin flex h-full overflow-y-auto bg-bg-subtle">
      <div role="alert" className="m-auto flex max-w-[560px] flex-col items-center gap-3 px-6 py-12 text-center">
        <div aria-hidden className="relative mb-2 h-[84px] w-[120px]">
          <div className="absolute top-0 left-[22px] h-3 w-[76px] rounded-t-md border border-b-0 border-dashed border-border-strong" />
          <div className="absolute top-2 left-3 h-3 w-24 rounded-t-md border border-b-0 border-dashed border-border-strong" />
          <div className="absolute top-[18px] left-0 flex h-[66px] w-[120px] items-center justify-center rounded-card border border-dashed border-border-strong bg-surface text-amber">
            <AlertTriangle size={24} />
          </div>
        </div>
        <h1 className="text-hero font-semibold">Your saved sessions were cleared</h1>
        <p className="max-w-[500px] text-text-2">
          Chrome's site data for Tabfold was erased, so your {sessions === 1 ? 'saved session is' : `${plural(sessions, 'saved session')} are`} gone
          from this device.
          {mirror &&
            ` We found a snapshot from ${snapshotTime(mirror.createdAt)} with ${plural(mirror.windowCount, 'window')} and ${plural(mirror.tabCount, 'tab')}.`}
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {mirror && (
            <Button variant="primary" size="lg" className="h-11 px-5" icon={<History size={16} aria-hidden />} disabled={busy} onClick={restore}>
              Restore from snapshot
            </Button>
          )}
          <Button size="lg" className="h-11" icon={<Upload size={16} aria-hidden className="text-text-2" />} onClick={() => openImportDialog()}>
            Import a backup file
          </Button>
        </div>
        <button
          type="button"
          aria-expanded={explain}
          onClick={() => setExplain((v) => !v)}
          className="text-small font-semibold text-accent-text hover:underline"
        >
          What happened?
        </button>
        {explain && (
          <div className="anim-in mt-1 flex max-w-[500px] flex-col gap-2 rounded-card border border-border bg-surface px-4 py-3 text-left text-text-2">
            <p>
              Chrome's "Clear browsing data" with "Cookies and other site data" ticked, a cleanup tool or a profile reset erases what
              extensions store, including Tabfold's sessions. Tabfold keeps a small record and its latest snapshot outside that storage,
              which is how it noticed.
            </p>
            <p>
              An exported file is the one copy Chrome can't erase. Keep the monthly backup reminder on in Settings › Data & privacy and
              export when it asks.
            </p>
            <button
              type="button"
              onClick={async () => {
                await acknowledgeWipe();
                onDismissed();
              }}
              className="self-start text-small font-semibold text-accent-text hover:underline"
            >
              Start with an empty library
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
