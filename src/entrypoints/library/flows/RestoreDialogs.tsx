import { useEffect, useId, useState } from 'react';
import { browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Copy, ExternalLink } from 'lucide-react';
import { plural } from '@/lib/format';
import type { RestoreFailure, RestoreMode } from '@/lib/messages';
import { getSessionGraph } from '@/lib/repo';
import { windowNames } from '@/lib/state';
import { Button } from '@/ui/components/Button';
import { Checkbox } from '@/ui/components/Controls';
import { Favicon } from '@/ui/components/Favicon';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { copyText, useSettings } from '@/ui/hooks';
import { copyFailedLinks, restoreSession } from '../actions';
import { FlowDialog } from './FlowDialog';
import type { RestoreFailures } from './store';

/** "Docs, Dashboards and AI chats"; long lists end in "and 4 more". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Restore options (Library-Dialogs card e): as the original windows, into this window, or one
 * new window. Remembers the choice (settings.lastRestoreMode) and the keep/trash setting.
 */
export function RestoreOptionsDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const graph = useLiveQuery(() => getSessionGraph(sessionId), [sessionId]);
  const [settings, update, loaded] = useSettings();
  const [mode, setMode] = useState<RestoreMode>(settings.lastRestoreMode);
  const [keep, setKeep] = useState(settings.afterRestore === 'keep');
  const name = useId();

  useEffect(() => {
    if (!loaded) return;
    setMode(settings.lastRestoreMode);
    setKeep(settings.afterRestore === 'keep');
    // Only the stored values when the dialog opens; later changes are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (graph === null) {
    return (
      <FlowDialog open onClose={onClose} title="Restore" footer={<Button onClick={onClose}>Close</Button>}>
        <p className="text-text-2">This session no longer exists.</p>
      </FlowDialog>
    );
  }
  if (!graph) return null;

  const total = graph.session.tabCount;
  const windows = graph.windows;
  const names = windows.map((w, i) => w.name || `Window ${i + 1}`);
  const tabs = windows.flatMap((w) => w.tabs);
  const hasGroups = tabs.some((t) => t.groupName !== null);
  const hasPinned = tabs.some((t) => t.pinned);
  const extra = hasGroups
    ? windows.length === 1
      ? ', with its tab groups'
      : ', with their tab groups'
    : hasPinned
      ? ', with pinned tabs'
      : '';

  const options: Array<{ value: RestoreMode; title: string; hint: string }> = [
    {
      value: 'original',
      title: windows.length === 1 ? 'As the original window' : `As ${windows.length} original windows`,
      hint: `${listNames(names)}${extra}`,
    },
    {
      value: 'current',
      title: 'Into this window',
      hint: total === 1 ? 'Adds the tab to the window you are in' : `Adds the ${plural(total, 'tab')} to the window you are in`,
    },
    {
      value: 'new-window',
      title: 'One new window',
      hint: total === 1 ? 'The tab in a fresh window' : `All ${plural(total, 'tab')} together in a fresh window`,
    },
  ];

  const run = () => {
    update({ lastRestoreMode: mode, afterRestore: keep ? 'keep' : 'trash' });
    onClose();
    void restoreSession(sessionId, mode);
  };

  return (
    <FlowDialog
      open
      onClose={onClose}
      title={<>Restore {graph.session.name}</>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={run} data-autofocus>
            Restore {plural(total, 'tab')}
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="Restore as" className="flex flex-col gap-2">
        {options.map((option) => {
          const checked = mode === option.value;
          return (
            <label
              key={option.value}
              className={cx(
                'flex cursor-pointer gap-2.5 rounded-card border px-3 py-2.5',
                checked ? 'border-accent bg-accent-soft' : 'border-border-strong hover:bg-hover',
              )}
            >
              <input type="radio" name={name} className="peer sr-only" checked={checked} onChange={() => setMode(option.value)} />
              <span
                aria-hidden
                className={cx(
                  'mt-px size-4 shrink-0 rounded-full bg-surface peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
                  checked ? 'border-[5px] border-accent' : 'border border-border-strong',
                )}
              />
              <span className="min-w-0">
                <span className="block font-semibold">{option.title}</span>
                <span className="block text-small text-text-2" dir="auto">
                  {option.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <Checkbox checked={keep} onChange={setKeep}>
        <span className="text-text-2">Keep the session after restoring</span>
      </Checkbox>
    </FlowDialog>
  );
}

/** "Window 2", or the name the user gave that window in the popup. */
async function windowLabel(windowId: number): Promise<string> {
  const [all, names] = await Promise.all([browser.windows.getAll({ windowTypes: ['normal'] }), windowNames.get()]);
  const normal = all.filter((w) => !w.incognito);
  const index = normal.findIndex((w) => w.id === windowId);
  return names[windowId] ?? (index === -1 ? 'another window' : `Window ${index + 1}`);
}

/**
 * Shown instead of restoring when most of the session is already open (Edge-Pages, Popup-AlreadyOpen):
 * Switch to it / Open a copy / Cancel.
 */
export function AlreadyOpenDialog({
  sessionId,
  sessionName,
  mode,
  windowRecordId,
  windowIds,
  openTabs,
  totalTabs,
  onClose,
}: {
  sessionId: string;
  sessionName: string;
  mode: RestoreMode;
  windowRecordId?: string;
  windowIds: number[];
  openTabs: number;
  totalTabs: number;
  onClose: () => void;
}) {
  const [where, setWhere] = useState(windowIds.length > 1 ? `${windowIds.length} windows` : '');
  const fallbackTotal = useLiveQuery(async () => (totalTabs ? totalTabs : ((await getSessionGraph(sessionId))?.session.tabCount ?? 0)), [sessionId, totalTabs]) ?? totalTabs;
  useEffect(() => {
    if (windowIds.length === 1) windowLabel(windowIds[0]!).then(setWhere).catch(() => setWhere('another window'));
  }, [windowIds]);
  const total = totalTabs || fallbackTotal;
  const all = openTabs > 0 && openTabs >= total;
  const tabs = total === 1 ? 'tab' : `${plural(total, 'tab')}`;
  const body = all
    ? total === 1
      ? `Its tab is open in ${where}.`
      : `Its ${tabs} are open in ${where}.`
    : `Most of its ${tabs} are open in ${where}.`;

  return (
    <FlowDialog
      open
      onClose={onClose}
      title={<>{sessionName} is already open</>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} className="mr-auto">
            Cancel
          </Button>
          <Button
            onClick={() => {
              onClose();
              void restoreSession(sessionId, mode, windowRecordId, true);
            }}
          >
            Open a copy
          </Button>
          <Button
            variant="primary"
            data-autofocus
            onClick={async () => {
              onClose();
              const target = windowIds[0];
              if (target !== undefined) await browser.windows.update(target, { focused: true }).catch(() => undefined);
            }}
          >
            Switch to it
          </Button>
        </>
      }
    >
      <p className="text-text-2">{where ? body : ' '}</p>
    </FlowDialog>
  );
}

function fileName(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).at(-1) ?? url);
  } catch {
    return url;
  }
}

/**
 * Local files couldn't open because "Allow access to file URLs" is off (Edge-Pages card b): three
 * steps, a button to the extension's details page, or copy the file links instead.
 */
export function FileAccessDialog({
  sessionName,
  files,
  opened,
  onClose,
}: {
  sessionName: string;
  files: RestoreFailure[];
  opened: number;
  onClose: () => void;
}) {
  const bodyId = useId();
  const count = files.length;
  const example = files[0] ? fileName(files[0].url) : '';
  const where = sessionName ? ` in ${sessionName}` : '';
  const lead =
    count === 1
      ? `1 tab${where} is a file on this computer${example ? `: ${example}` : ''}.`
      : `${count > 0 ? plural(count, 'tab') : 'Some tabs'}${where} are files on this computer${example ? `, like ${example}` : ''}.`;
  const rest = opened === 0 ? '' : opened === 1 ? ' The other tab is open.' : ` The other ${plural(opened, 'tab')} are open.`;

  return (
    <FlowDialog open onClose={onClose} title="Allow Tabfold to open local files" showClose={false} describedBy={bodyId} width={420}>
      <p id={bodyId} className="text-text-2" dir="auto">
        {lead} Chrome only lets extensions open them if you allow it.{rest}
      </p>
      <ol className="flex flex-col gap-2.5">
        <Step n={1}>Open Tabfold's details page</Step>
        <Step n={2}>
          <span>Turn on "Allow access to file URLs"</span>
          <span aria-hidden className="mt-2 flex items-center gap-2.5 rounded-control border border-border bg-bg-subtle px-2.5 py-2 text-small text-text-2">
            <span className="flex-1">Allow access to file URLs</span>
            <span className="relative h-[18px] w-8 shrink-0 rounded-full bg-accent">
              <span className="absolute top-0.5 left-4 size-3.5 rounded-full bg-white" />
            </span>
          </span>
        </Step>
        <Step n={3}>Come back and restore</Step>
      </ol>
      <div className="mt-1 flex flex-col gap-2">
        <Button
          variant="primary"
          data-autofocus
          icon={<ExternalLink size={16} aria-hidden />}
          onClick={() => {
            void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` });
            onClose();
          }}
        >
          Open extension settings
        </Button>
        <Button
          icon={<Copy size={16} aria-hidden />}
          disabled={count === 0}
          onClick={async () => {
            if (await copyText(files.map((f) => f.url).join('\n'))) toast(count === 1 ? 'File link copied.' : 'File links copied.');
            onClose();
          }}
        >
          Copy file links instead
        </Button>
      </div>
    </FlowDialog>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-meta font-semibold text-accent-text">
        {n}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
    </li>
  );
}

/**
 * "Restored 21 of 24 tabs": the pages Chrome wouldn't let an extension reopen, as copyable text
 * (States board). Shown in the detail panel of that session, or floating when it isn't open.
 */
export function RestoreFailuresCard({
  failures,
  onDismiss,
  className,
}: {
  failures: RestoreFailures;
  onDismiss: () => void;
  className?: string;
}) {
  const shown = failures.failed.slice(0, 5);
  const more = failures.failed.length - shown.length;
  return (
    <div role="alert" className={cx('overflow-hidden rounded-card border border-amber-line bg-amber-soft', className)}>
      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <AlertTriangle size={16} aria-hidden className="mt-px shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-amber">
            Restored {failures.opened.toLocaleString()} of {failures.total.toLocaleString()} tabs
          </div>
          <div className="text-text-2">Chrome won't let extensions reopen these pages. Copy the links and paste them into the address bar.</div>
        </div>
      </div>
      <div className="border-t border-amber-line bg-surface">
        <ul>
          {shown.map((failure, index) => (
            <li key={`${failure.url}-${index}`} className="flex h-[30px] items-center gap-2.5 px-3.5">
              <Favicon url={failure.url} />
              <span className="min-w-0 flex-1 truncate font-mono text-small" title={failure.url}>
                {failure.url.replace(/^https:\/\//, '')}
              </span>
            </li>
          ))}
        </ul>
        {more > 0 && <div className="flex h-6 items-center px-3.5 text-meta text-text-3">and {more.toLocaleString()} more</div>}
        <div className="flex gap-2 border-t border-border px-3.5 py-2.5">
          <Button size="xs" icon={<Copy size={14} aria-hidden />} onClick={() => copyFailedLinks(failures.failed)}>
            Copy links
          </Button>
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
