import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Download, HardDriveDownload } from 'lucide-react';
import { backup, limitBanner } from '@/lib/state';
import { Button } from '@/ui/components/Button';
import { showProInfo } from '@/ui/components/ProDialog';
import { openExportDialog } from '../flows';

const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;
/** "Remind me next month" hides the reminder until this time (the worker's daily check should honour it too). */
export const BACKUP_SNOOZE_KEY = 'backupReminderSnoozedUntil';
const INSTALLED_AT = 'installedAt';

/** Monthly backup reminder (Library-List): days since the last HTML export, Export now, or snooze a month. */
export function BackupBanner() {
  const [state, setState] = useState<{ due: boolean; days: number | null; snoozedUntil: number }>({
    due: false,
    days: null,
    snoozedUntil: 0,
  });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [due, last, stored] = await Promise.all([
        backup.isDue(),
        backup.lastAt(),
        browser.storage.local.get([BACKUP_SNOOZE_KEY, INSTALLED_AT]),
      ]);
      if (!alive) return;
      const snoozedUntil = (stored[BACKUP_SNOOZE_KEY] as number | undefined) ?? 0;
      setState({ due, days: last ? Math.floor((Date.now() - last) / DAY) : null, snoozedUntil });
    };
    load().catch(() => undefined);
    const stop = backup.watchDue(() => void load().catch(() => undefined));
    return () => {
      alive = false;
      stop();
    };
  }, []);

  if (!state.due || state.snoozedUntil > Date.now()) return null;

  const snooze = async () => {
    const until = Date.now() + MONTH;
    setState((s) => ({ ...s, snoozedUntil: until }));
    await browser.storage.local.set({ [BACKUP_SNOOZE_KEY]: until });
    await backup.setDue(false);
  };

  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface py-3 pr-3 pl-3.5">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-control border border-border bg-bg-subtle text-text-2">
        <HardDriveDownload size={16} />
      </span>
      <div className="min-w-[220px] flex-1">
        <div className="font-semibold">
          {state.days !== null ? `It's been ${state.days} days since your last backup` : 'Time for your first backup'}
        </div>
        <div className="text-text-2">Export everything to one HTML file you can keep anywhere.</div>
      </div>
      <Button variant="accent-soft" size="sm" icon={<Download size={16} aria-hidden />} onClick={() => openExportDialog()}>
        Export now
      </Button>
      <Button variant="ghost" size="sm" className="px-2.5" onClick={() => void snooze()}>
        Remind me next month
      </Button>
    </div>
  );
}

/** Free limit reached (States board): friendly, non-blocking, dismissible for a week. */
export function LimitBanner({ named, limit }: { named: number; limit: number }) {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    limitBanner
      .dismissedAt()
      .then((at) => setDismissed(!!at && Date.now() - at < 7 * DAY))
      .catch(() => setDismissed(false));
  }, []);
  if (named < limit || dismissed) return null;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-card border border-border bg-bg-subtle px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-[22px] items-center rounded-full border border-border-strong px-2 text-meta font-semibold text-text-2">
          {named} of {limit}
        </span>
        <span className="font-semibold">You've reached {limit} named sessions</span>
      </div>
      <p className="text-text-2">
        Everything you've saved stays here and keeps working. New saves go into “Unsorted” until you merge or delete a session. Pro
        removes the limit.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="accent-soft" size="sm" onClick={() => showProInfo('Unlimited sessions')}>
          See what Pro adds
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void limitBanner.dismiss();
            setDismissed(true);
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
