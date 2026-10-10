import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Building2, RefreshCw, X } from 'lucide-react';
import { db } from '@/lib/db';
import { listTrash } from '@/lib/repo';
import { Button, IconButton } from '@/ui/components/Button';
import { useGroupsUnavailable } from '@/ui/hooks';
import { emptyTrash } from '../actions';
import { openExportDialog } from './index';

function readNumber(key: string): number | null {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : Number(value);
  } catch {
    return null;
  }
}

function writeValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A convenience only: the banner may show again.
  }
}

/** "1.9 GB", "412 MB", "640 KB". */
export function formatStorage(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1000) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb).toLocaleString()} MB`;
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
}

/**
 * Tabfold was updated while the library is open (Edge-Data): the page has lost its link to the new
 * background, so actions pause (the rest of the page is dimmed) until Reload.
 */
export function UpdateBanner() {
  return (
    <div role="alert" className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-accent-line bg-accent-soft py-1.5 pr-1.5 pl-3">
      <RefreshCw size={16} aria-hidden className="shrink-0 text-accent-text" />
      <span className="min-w-0 flex-1">Tabfold was updated. Reload this page to keep going.</span>
      <Button
        size="sm"
        variant="primary"
        className="h-[30px]"
        onClick={() => {
          try {
            browser.runtime.reload();
          } catch {
            location.reload();
          }
        }}
      >
        Reload
      </Button>
    </div>
  );
}

const GROUPS_DISMISSED = 'tabfold.groupsBannerDismissed';

/** A policy turned off tab groups: a neutral note, shown once (dismissible). */
export function GroupsUnavailableBanner() {
  const unavailable = useGroupsUnavailable();
  const [dismissed, setDismissed] = useState(() => readNumber(GROUPS_DISMISSED) !== null);
  if (!unavailable || dismissed) return null;
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-card border border-border-strong bg-bg-subtle py-2.5 pr-2 pl-3">
      <Building2 size={16} aria-hidden className="mt-px shrink-0 text-text-2" />
      <p className="min-w-0 flex-1 text-text-2">Your organisation has turned off tab groups in Chrome. Groups are saved as plain windows.</p>
      <IconButton
        label="Dismiss"
        size="sm"
        tone="muted"
        onClick={() => {
          writeValue(GROUPS_DISMISSED, String(Date.now()));
          setDismissed(true);
        }}
      >
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  );
}

const STORAGE_DISMISSED = 'tabfold.storageWarningDismissedAt';
const WARN_FROM = 0.8;

/** Rough bytes the Trash takes: each saved tab's text plus row overhead. */
async function estimateTrashBytes(): Promise<number> {
  const trash = await listTrash();
  if (trash.length === 0) return 0;
  let bytes = 0;
  await db.tabs
    .where('sessionId')
    .anyOf(trash.map((s) => s.id))
    .each((tab) => {
      bytes += (tab.url.length + tab.title.length + tab.favIconUrl.length + tab.keywords.join(' ').length) * 2 + 240;
    });
  return bytes;
}

/**
 * Browser storage nearly full (Edge-Data): from 80% of what Chrome allows. Saving still works;
 * dismissing hides it until usage grows another 5 points.
 */
export function StorageWarning() {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [dismissedAt, setDismissedAt] = useState(() => readNumber(STORAGE_DISMISSED));
  const trashCount = useLiveQuery(async () => (await listTrash()).length, []) ?? 0;
  const ratio = estimate && estimate.quota > 0 ? estimate.usage / estimate.quota : 0;
  const show = ratio >= WARN_FROM && (dismissedAt === null || ratio * 100 >= dismissedAt + 5);
  const trashBytes = useLiveQuery(async () => (show && trashCount > 0 ? estimateTrashBytes() : 0), [show, trashCount]) ?? 0;

  useEffect(() => {
    let alive = true;
    const check = () =>
      navigator.storage
        ?.estimate()
        .then((e) => {
          if (alive && e.quota) setEstimate({ usage: e.usage ?? 0, quota: e.quota });
        })
        .catch(() => undefined);
    void check();
    const id = setInterval(check, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!estimate || !show) return null;
  const pct = Math.min(100, Math.round(ratio * 100));
  return (
    <div role="status" className="flex flex-col gap-2.5 rounded-card border border-amber-line bg-amber-soft px-3.5 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} aria-hidden className="mt-px shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-amber">Browser storage is nearly full</div>
          <div className="text-text-2">Tabfold uses {formatStorage(estimate.usage)}. Empty Trash or export old sessions.</div>
        </div>
        <IconButton
          label="Dismiss"
          size="sm"
          className="-mt-0.5 text-amber hover:text-amber"
          onClick={() => {
            writeValue(STORAGE_DISMISSED, String(pct));
            setDismissedAt(pct);
          }}
        >
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      <div className="pl-6">
        <div role="meter" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1 overflow-hidden rounded-full bg-surface">
          <div className="h-full bg-amber" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 text-meta text-text-2">{pct}% of the space Chrome allows</div>
      </div>
      <div className="flex flex-wrap gap-2 pl-6">
        {trashCount > 0 && (
          <button
            type="button"
            onClick={() => void emptyTrash()}
            className="h-7 rounded-control border border-amber-line bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover"
          >
            Empty Trash{trashBytes > 0 ? ` (${formatStorage(trashBytes)})` : ''}
          </button>
        )}
        <button type="button" onClick={() => openExportDialog()} className="h-7 rounded-control px-1.5 text-small font-semibold text-amber hover:underline">
          Export sessions…
        </button>
      </div>
    </div>
  );
}
