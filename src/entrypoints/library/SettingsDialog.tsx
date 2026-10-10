import { useEffect, useRef, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { ChevronDown, Download, TriangleAlert, Trash, Upload, X } from 'lucide-react';
import type { SyncStatus } from '@/lib/state';
import { Kbd } from '@/ui/components/Chips';
import { Segmented, Switch } from '@/ui/components/Controls';
import { confirmAction } from '@/ui/components/Dialog';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { useIncognitoAccess, useSettings } from '@/ui/hooks';
import { clearEverything, errorText, exportAll } from './actions';
import { count } from './format';
import { SyncLine } from './SyncLine';

const SLEEP_CHOICES: Array<{ value: number; label: string }> = [
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 240, label: '4 hours' },
];

function minutesLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} min`;
}

/** The fold shortcut as Chrome shows it ("⌘⇧S"), or '' when it was removed. */
export function useFoldShortcut(): string {
  const [shortcut, setShortcut] = useState('');
  useEffect(() => {
    const load = () =>
      browser.commands
        .getAll()
        .then((commands) => {
          const fold = commands.find((c) => c.name === 'fold') ?? commands.find((c) => c.name === 'save-all');
          setShortcut(fold?.shortcut ?? '');
        })
        .catch(() => undefined);
    void load();
    // Shortcuts change on Chrome's page; pick them up when the person comes back.
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  return shortcut;
}

function SettingRow({
  title,
  description,
  control,
  last,
  center,
}: {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  last?: boolean;
  center?: boolean;
}) {
  return (
    <div className={cx('flex gap-8 py-6', center ? 'items-center' : 'items-start', !last && 'border-b border-border')}>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-[22px] flex-wrap items-center gap-2 font-semibold">{title}</div>
        {description && <div className="mt-1 text-small text-text-3">{description}</div>}
      </div>
      <div className="flex min-h-[22px] shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

/** Opens Tabfold's page in chrome://extensions, where "Allow in Incognito" is. */
function openExtensionDetails() {
  void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` }).catch(() => undefined);
}

/**
 * Chrome hides Incognito windows from extensions until "Allow in Incognito" is on. With the switch
 * on, this is a warning (folds still skip Incognito); with it off, a hint.
 */
function IncognitoHelp({ warn }: { warn: boolean }) {
  const link = (
    <a
      href={`chrome://extensions/?id=${browser.runtime.id}`}
      onClick={(e) => {
        e.preventDefault();
        openExtensionDetails();
      }}
      className="font-semibold text-accent-text no-underline hover:underline"
    >
      Open Tabfold’s details
    </a>
  );
  if (!warn) {
    return (
      <div className="mt-1">
        Also needs “Allow in Incognito” for Tabfold in Chrome. {link}
      </div>
    );
  }
  return (
    <div role="status" className="mt-2.5 flex items-start gap-2 rounded-control border border-amber-line bg-amber-soft px-3 py-2 text-text-2">
      <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="mt-[3px] shrink-0 text-amber" />
      <div>
        Chrome hasn’t let Tabfold into Incognito yet, so folds still skip it. Turn on “Allow in Incognito” in Tabfold’s details. {link}
      </div>
    </div>
  );
}

const SECONDARY =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3.5 text-text hover:bg-hover';

/**
 * Settings (Min-Settings), over the list: the few choices the minimal Tabfold has. Everything
 * else keeps its default.
 */
export function SettingsDialog({
  open,
  onClose,
  onHow,
  onImport,
  syncStatus,
  foldedCount,
}: {
  open: boolean;
  onClose: () => void;
  onHow: () => void;
  onImport: () => void;
  syncStatus: SyncStatus | undefined;
  foldedCount: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [settings, update] = useSettings();
  const shortcut = useFoldShortcut();
  const incognitoAccess = useIncognitoAccess();
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Start on the dialog itself (not the close button), so nothing looks pressed on open.
      dialog.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const sleepChoices = SLEEP_CHOICES.some((c) => c.value === settings.autoSuspendMinutes)
    ? SLEEP_CHOICES
    : [...SLEEP_CHOICES, { value: settings.autoSuspendMinutes, label: minutesLabel(settings.autoSuspendMinutes) }].sort((a, b) => a.value - b.value);

  const clear = async () => {
    const ok = await confirmAction({
      title: 'Clear everything?',
      body: `${foldedCount > 0 ? `All ${count(foldedCount, 'folded tab')}` : 'Everything Tabfold keeps'} will be removed from this computer and from Chrome sync, and settings go back to their defaults. This can’t be undone.`,
      confirmLabel: 'Clear everything',
      danger: true,
    });
    if (!ok) return;
    setClearing(true);
    try {
      await clearEverything();
      toast('Everything was cleared.');
      onClose();
    } catch (error) {
      toast(`Couldn’t clear everything: ${errorText(error)}`, { tone: 'error' });
    } finally {
      setClearing(false);
    }
  };

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto max-h-[min(760px,calc(100vh-32px))] overflow-hidden rounded-card border border-border bg-surface p-0 text-text shadow-pop outline-none"
      style={{ width: 'min(720px, calc(100vw - 32px))' }}
    >
      {open && (
        <div className="flex max-h-[min(760px,calc(100vh-32px))] flex-col">
          <header className="flex h-[72px] shrink-0 items-center gap-3 border-b border-border pr-6 pl-10 max-[560px]:pl-5">
            <h1 id="settings-title" className="m-0 flex-1 text-page font-semibold">
              Settings
            </h1>
            <button
              type="button"
              aria-label="Close settings"
              title="Close settings"
              onClick={onClose}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
            >
              <X size={18} strokeWidth={1.75} aria-hidden />
            </button>
          </header>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-10 py-1 max-[560px]:px-5">
            <SettingRow
              title="Keep pinned tabs open"
              description="Fold skips them. Tabs playing sound always stay open too."
              control={<Switch checked={settings.keepPinnedOpen} onChange={(v) => update({ keepPinnedOpen: v })} label="Keep pinned tabs open" />}
            />
            <SettingRow
              title={
                <>
                  Put idle tabs to sleep after
                  <span className="relative inline-flex items-center font-normal">
                    <select
                      aria-label="Idle time before a tab goes to sleep"
                      value={settings.autoSuspendMinutes}
                      disabled={!settings.autoSuspend}
                      onChange={(e) => update({ autoSuspendMinutes: Number(e.target.value) })}
                      className="h-7 appearance-none rounded-control border border-border-strong bg-surface py-0 pr-7 pl-2.5 text-body text-text disabled:text-text-3"
                    >
                      {sleepChoices.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} strokeWidth={2} aria-hidden className="pointer-events-none absolute right-2 text-text-3" />
                  </span>
                </>
              }
              description={
                <>
                  Sleeping tabs stay in your tab bar and use almost no memory.{' '}
                  <a
                    href="#/how"
                    onClick={(e) => {
                      e.preventDefault();
                      onHow();
                    }}
                    className="font-semibold text-accent-text no-underline hover:underline"
                  >
                    How it works
                  </a>
                </>
              }
              control={<Switch checked={settings.autoSuspend} onChange={(v) => update({ autoSuspend: v })} label="Put idle tabs to sleep" />}
            />
            <SettingRow
              title="Sync folded tabs with Chrome"
              description={
                <>
                  Uses Chrome’s own sync, no account needed. Your latest ~500 folded tabs show up on your other computers; older ones stay on
                  this one.
                  {settings.syncWithChrome && syncStatus && (
                    <div className="mt-2.5">
                      <SyncLine status={syncStatus} enabled />
                    </div>
                  )}
                </>
              }
              control={<Switch checked={settings.syncWithChrome} onChange={(v) => update({ syncWithChrome: v })} label="Sync folded tabs with Chrome" />}
            />
            <SettingRow
              title="Fold Incognito windows too"
              description={
                <>
                  Their tabs stay on this computer, never go to Chrome sync, and reopen only in Incognito.
                  {incognitoAccess === false && (
                    <IncognitoHelp warn={settings.foldIncognito} />
                  )}
                </>
              }
              control={<Switch checked={settings.foldIncognito} onChange={(v) => update({ foldIncognito: v })} label="Fold Incognito windows too" />}
            />
            <SettingRow
              center
              title="Theme"
              control={
                <Segmented
                  label="Theme"
                  value={settings.theme}
                  onChange={(theme) => update({ theme })}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                />
              }
            />
            <SettingRow
              center
              title="Your tabs"
              control={
                <>
                  <button type="button" className={SECONDARY} onClick={onImport}>
                    <Upload size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
                    Import from OneTab…
                  </button>
                  <button type="button" className={SECONDARY} onClick={() => void exportAll()}>
                    <Download size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
                    Export…
                  </button>
                </>
              }
            />
            <SettingRow
              last
              title="Keyboard shortcut"
              description={
                <>
                  Change it in{' '}
                  <a
                    href="chrome://extensions/shortcuts"
                    onClick={(e) => {
                      e.preventDefault();
                      void browser.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => undefined);
                    }}
                    className="text-accent-text no-underline hover:underline"
                  >
                    Chrome’s shortcut settings
                  </a>
                  .
                </>
              }
              control={
                <>
                  <span className="text-text-2">Fold tabs</span>
                  {shortcut ? <Kbd className="px-[5px]">{shortcut}</Kbd> : <span className="text-small text-text-3">Not set</span>}
                </>
              }
            />
          </div>

          <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-10 pt-5 pb-6 max-[560px]:px-5">
            <button
              type="button"
              disabled={clearing}
              onClick={() => void clear()}
              className="-ml-2.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2.5 font-semibold text-red hover:bg-red-soft disabled:opacity-60"
            >
              <Trash size={16} strokeWidth={1.75} aria-hidden />
              Clear everything…
            </button>
            <span className="text-small text-text-3">
              Removes {foldedCount > 0 ? `all ${count(foldedCount, 'folded tab')}` : 'everything'} here and from Chrome sync. Asks first.
            </span>
          </footer>
        </div>
      )}
    </dialog>
  );
}
