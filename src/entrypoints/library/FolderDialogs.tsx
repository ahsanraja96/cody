import { useId, useMemo, useState, type ReactNode } from 'react';
import { Folder, FolderPlus, LoaderCircle, Sparkles, X } from 'lucide-react';
import { FREE_LIMITS } from '@/lib/limits';
import type { FolderRecord, TabGroupColor, TabRecord } from '@/lib/types';
import { FolderIcon } from '@/ui/components/FolderIcon';
import { Modal } from '@/ui/components/Modal';
import { cx } from '@/ui/cx';
import { cleanFolderName, FOLDER_COLORS, FOLDER_NAME_MAX, nextFolderColor } from '@/ui/folders';
import { useFolders, usePlan } from '@/ui/hooks';
import { fromLocalInput, snoozeTime, toLocalInput } from '@/ui/snooze';
import { createFolder, deleteFolder, folderLimitReached, moveToFolder, snoozeTabs, startLive } from './folderActions';
import { count } from './format';
import { goToPlans } from './router';
import { openDialog, useLibraryUi, type LibraryDialog } from './uiStore';

export const PRIMARY =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-3.5 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent';
export const SECONDARY =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border border-border-strong bg-surface px-3.5 text-text hover:bg-hover disabled:opacity-50';
const DANGER = 'inline-flex h-8 shrink-0 items-center justify-center rounded-control bg-red-solid px-3.5 font-semibold text-white hover:brightness-95';
const CLOSE = 'inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text';

/** A small dialog with the boards' look: title (and ×), body, buttons on the right. */
export function SmallDialog({
  open,
  onClose,
  title,
  icon,
  width = 360,
  closeButton = false,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: ReactNode;
  width?: number;
  closeButton?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <Modal open={open} onClose={onClose} labelledBy={id} width={width}>
      <div className={cx('flex flex-col p-[18px]', className)}>
        <div className="flex items-start gap-2">
          {icon}
          <h2 id={id} className="m-0 min-w-0 flex-1 text-section font-semibold">
            {title}
          </h2>
          {closeButton && (
            <button type="button" aria-label="Close" title="Close" onClick={onClose} className={cx(CLOSE, '-mt-1.5 -mr-1.5')}>
              <X size={18} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
        {children}
        {footer && <div className="mt-3.5 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </Modal>
  );
}

/** Nine round swatches as a radio group. */
export function ColourPicker({ value, onChange }: { value: TabGroupColor; onChange: (color: TabGroupColor) => void }) {
  return (
    <div role="radiogroup" aria-label="Colour" className="flex gap-2">
      {FOLDER_COLORS.map((color) => {
        const on = color === value;
        const name = color[0]!.toUpperCase() + color.slice(1);
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={name}
            title={name}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(color)}
            onKeyDown={(e) => {
              const i = FOLDER_COLORS.indexOf(color);
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = FOLDER_COLORS[(i + step + FOLDER_COLORS.length) % FOLDER_COLORS.length]!;
              onChange(next);
              (e.currentTarget.parentElement?.querySelector(`[aria-label="${next[0]!.toUpperCase() + next.slice(1)}"]`) as HTMLElement | null)?.focus();
            }}
            className={cx(`tf-cg-${color}`, 'size-[18px] rounded-full')}
            style={{ background: 'var(--tf-cg)', boxShadow: on ? '0 0 0 2px var(--tf-surface), 0 0 0 3.5px var(--tf-cg)' : undefined }}
          />
        );
      })}
    </div>
  );
}

function NewFolderDialog({ tabRecordIds, onClose }: { tabRecordIds?: string[]; onClose: () => void }) {
  const folders = useFolders() ?? [];
  const plan = usePlan();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TabGroupColor>(() => nextFolderColor(folders));
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const submit = async () => {
    if (!cleanFolderName(name) || busy) return;
    if (folderLimitReached(plan, folders)) {
      openDialog({ kind: 'folder-limit' });
      return;
    }
    setBusy(true);
    const folder = await createFolder(name, color, tabRecordIds);
    setBusy(false);
    // A limit answer replaced this dialog with "Free has 3 folders"; otherwise it's done.
    if (folder) onClose();
  };
  return (
    <SmallDialog
      open
      onClose={onClose}
      title="New folder"
      closeButton
      footer={
        <>
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          <button type="button" disabled={!cleanFolderName(name) || busy} onClick={() => void submit()} className={PRIMARY}>
            {busy && <LoaderCircle size={14} aria-hidden className="tf-spin" />}
            {tabRecordIds?.length ? 'Create and move' : 'Create folder'}
          </button>
        </>
      }
    >
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Folder name
        </label>
        <div className="flex h-9 items-center gap-2.5 rounded-control border border-border-strong bg-surface px-2.5 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]">
          <FolderIcon color={color} />
          <input
            id={inputId}
            data-autofocus
            value={name}
            maxLength={FOLDER_NAME_MAX}
            placeholder="Folder name"
            onChange={(e) => setName(e.target.value)}
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none"
          />
        </div>
        <ColourPicker value={color} onChange={setColor} />
        <p className="m-0 text-small text-text-3">
          {tabRecordIds?.length ? `${count(tabRecordIds.length, 'tab')} will move into it. ` : ''}“Open all” opens a Chrome tab group in this colour.
        </p>
      </form>
    </SmallDialog>
  );
}

/** "Free has 3 folders" (Fo-Folders-States): the 4th folder on Free. */
function FolderLimitDialog({ onClose }: { onClose: () => void }) {
  return (
    <SmallDialog
      open
      onClose={onClose}
      width={340}
      icon={<Folder size={18} strokeWidth={1.75} aria-hidden className="mt-px shrink-0 text-accent-text" />}
      title={`Free has ${FREE_LIMITS.folders} folders`}
      footer={
        <>
          <button type="button" onClick={onClose} className={SECONDARY}>
            Not now
          </button>
          <button
            type="button"
            data-autofocus
            onClick={() => {
              onClose();
              goToPlans();
            }}
            className={PRIMARY}
          >
            <Sparkles size={14} strokeWidth={1.75} aria-hidden />
            Upgrade
          </button>
        </>
      }
    >
      <p className="m-0 mt-1.5 text-text-2">Upgrade for as many folders as you like, every tab on every computer, and a daily backup.</p>
    </SmallDialog>
  );
}

function DeleteFolderDialog({ folder, tabs, onClose }: { folder: FolderRecord; tabs: number; onClose: () => void }) {
  return (
    <SmallDialog
      open
      onClose={onClose}
      width={360}
      title={`Delete “${folder.name}”?`}
      footer={
        <>
          {/* Destructive: focus stays on Cancel, so Enter never deletes by accident. */}
          <button type="button" data-autofocus onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              void deleteFolder(folder);
            }}
            className={DANGER}
          >
            Delete folder
          </button>
        </>
      }
    >
      <p className="m-0 mt-1.5 text-text-2">
        {tabs > 0
          ? `Its ${count(tabs, 'tab')} stay in your list, back with their kind of site. Only the folder goes.`
          : 'It has no tabs. Only the folder goes.'}
      </p>
    </SmallDialog>
  );
}

/** "Move all 6 tabs to a folder…": one of the folders, or a new one. */
function PickFolderDialog({ tabRecordIds, title, onClose }: { tabRecordIds: string[]; title: string; onClose: () => void }) {
  const folders = useFolders() ?? [];
  const plan = usePlan();
  const [choice, setChoice] = useState<string>(() => folders[0]?.id ?? 'new');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const groupId = useId();
  const fake = useMemo(() => tabRecordIds.map((id) => ({ id }) as TabRecord), [tabRecordIds]);
  const canNew = !folderLimitReached(plan, folders);
  const submit = async () => {
    setBusy(true);
    if (choice === 'new') {
      if (!canNew) {
        openDialog({ kind: 'folder-limit' });
        return;
      }
      const folder = await createFolder(name, nextFolderColor(folders), tabRecordIds);
      setBusy(false);
      if (folder) onClose();
      return;
    }
    const folder = folders.find((f) => f.id === choice);
    onClose();
    if (folder) await moveToFolder(fake, folder);
  };
  const row = 'flex h-9 cursor-pointer items-center gap-2.5 rounded-control px-2.5 hover:bg-hover has-[:focus-visible]:bg-hover';
  return (
    <SmallDialog
      open
      onClose={onClose}
      width={380}
      title={title}
      closeButton
      footer={
        <>
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || (choice === 'new' && !cleanFolderName(name) && canNew)}
            onClick={() => void submit()}
            className={PRIMARY}
          >
            {choice === 'new' && !canNew ? 'Upgrade for more folders' : 'Move'}
          </button>
        </>
      }
    >
      <div role="radiogroup" aria-labelledby={groupId} className="mt-3 flex max-h-[320px] flex-col gap-0.5 overflow-y-auto">
        <span id={groupId} className="sr-only">
          Folder
        </span>
        {folders.map((folder) => (
          <label key={folder.id} className={row}>
            <input type="radio" name={groupId} checked={choice === folder.id} onChange={() => setChoice(folder.id)} className="accent-[var(--tf-accent)]" />
            <FolderIcon color={folder.color} />
            <span dir="auto" className="min-w-0 flex-1 truncate">
              {folder.name}
            </span>
          </label>
        ))}
        <label className={row}>
          <input type="radio" name={groupId} checked={choice === 'new'} onChange={() => setChoice('new')} className="accent-[var(--tf-accent)]" />
          <FolderPlus size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-2" />
          <span className="flex-1">New folder…</span>
          {!canNew && <span className="text-small text-text-3">Free has {FREE_LIMITS.folders}</span>}
        </label>
        {choice === 'new' && canNew && (
          <input
            autoFocus
            aria-label="New folder name"
            value={name}
            maxLength={FOLDER_NAME_MAX}
            placeholder="Folder name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && cleanFolderName(name)) {
                e.preventDefault();
                void submit();
              }
            }}
            className="mt-1 ml-8 h-8 rounded-control border border-border-strong bg-surface px-2.5 text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-soft)]"
          />
        )}
      </div>
    </SmallDialog>
  );
}

/** "Pick a date and time…" from a tab's Snooze menu. */
function SnoozeAtDialog({ tabRecordIds, title, onClose }: { tabRecordIds: string[]; title: string; onClose: () => void }) {
  const [value, setValue] = useState(() => {
    const d = new Date(Date.now() + 24 * 3_600_000);
    d.setHours(9, 0, 0, 0);
    return toLocalInput(d.getTime());
  });
  const inputId = useId();
  const until = fromLocalInput(value);
  const valid = until !== null && until > Date.now() + 60_000;
  return (
    <SmallDialog
      open
      onClose={onClose}
      title="Snooze until…"
      closeButton
      footer={
        <>
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid}
            onClick={() => {
              onClose();
              if (until) void snoozeTabs(tabRecordIds.map((id) => ({ id }) as TabRecord), until);
            }}
            className={PRIMARY}
          >
            Snooze
          </button>
        </>
      }
    >
      <p dir="auto" className="m-0 mt-1 truncate text-small text-text-3">
        {title}
      </p>
      <label htmlFor={inputId} className="mt-3 mb-1.5 text-small font-semibold">
        Comes back
      </label>
      <input
        id={inputId}
        data-autofocus
        type="datetime-local"
        value={value}
        min={toLocalInput(Date.now())}
        onChange={(e) => setValue(e.target.value)}
        className="h-9 rounded-control border border-border-strong bg-surface px-2.5 text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-soft)]"
      />
      <p role="status" className="m-0 mt-2 text-small text-text-2">
        {valid ? `It reopens in the background ${snoozeTime(until!).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}.` : 'Pick a time in the future.'}
      </p>
    </SmallDialog>
  );
}

/** "Free has 3 snoozed tabs at a time" (Mx-Auto). */
function SnoozeLimitDialog({ onClose }: { onClose: () => void }) {
  return (
    <SmallDialog
      open
      onClose={onClose}
      width={360}
      title={`Free has ${FREE_LIMITS.snoozes} snoozed tabs at a time`}
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              onClose();
              useLibraryUi.getState().setJumpTo('snoozed');
            }}
            className={SECONDARY}
          >
            See snoozed tabs
          </button>
          <button
            type="button"
            data-autofocus
            onClick={() => {
              onClose();
              goToPlans();
            }}
            className={PRIMARY}
          >
            <Sparkles size={14} strokeWidth={1.75} aria-hidden />
            Upgrade
          </button>
        </>
      }
    >
      <p className="m-0 mt-1.5 text-text-2">Wake one, or upgrade to snooze as many as you like.</p>
    </SmallDialog>
  );
}

/** "Switch to “Truewidgets”?" when another folder is already live (Mx-Live-States). */
function LiveSwitchDialog({ from, to, onClose }: { from: FolderRecord; to: FolderRecord; onClose: () => void }) {
  const [foldFirst, setFoldFirst] = useState(true);
  const name = useId();
  const option = (value: boolean, title: string, sub: string) => (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="radio" name={name} checked={foldFirst === value} onChange={() => setFoldFirst(value)} className="peer sr-only" />
      <span
        aria-hidden
        className={cx(
          'mt-0.5 size-4 shrink-0 rounded-full bg-surface peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          foldFirst === value ? 'border-[5px] border-accent' : 'border-[1.5px] border-border-strong',
        )}
      />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="block text-small text-text-3">{sub}</span>
      </span>
    </label>
  );
  return (
    <SmallDialog
      open
      onClose={onClose}
      width={380}
      title={`Switch to “${to.name}”?`}
      closeButton
      footer={
        <>
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          <button
            type="button"
            data-autofocus
            onClick={() => {
              onClose();
              void startLive(to, foldFirst);
            }}
            className={PRIMARY}
          >
            Switch
          </button>
        </>
      }
    >
      <div role="radiogroup" aria-label="Switching folders" className="mt-3.5 flex flex-col gap-2.5">
        {option(true, `Fold “${from.name}” and open “${to.name}”`, `Frees memory; ${from.name} waits in its folder.`)}
        {option(false, 'Keep both open', 'Two live groups side by side.')}
      </div>
    </SmallDialog>
  );
}

/** The one place these dialogs open (from menus, the left column, toasts and the palette). */
export function FolderDialogHost({ render }: { render?: (dialog: LibraryDialog, close: () => void) => ReactNode }) {
  const dialog = useLibraryUi((s) => s.dialog);
  const close = useLibraryUi((s) => s.close);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'new-folder':
      return <NewFolderDialog key="new" tabRecordIds={dialog.tabRecordIds} onClose={close} />;
    case 'folder-limit':
      return <FolderLimitDialog key="limit" onClose={close} />;
    case 'delete-folder':
      return <DeleteFolderDialog key="delete" folder={dialog.folder} tabs={dialog.tabs} onClose={close} />;
    case 'pick-folder':
      return <PickFolderDialog key="pick" tabRecordIds={dialog.tabRecordIds} title={dialog.title} onClose={close} />;
    case 'snooze-at':
      return <SnoozeAtDialog key="snooze-at" tabRecordIds={dialog.tabRecordIds} title={dialog.title} onClose={close} />;
    case 'snooze-limit':
      return <SnoozeLimitDialog key="snooze-limit" onClose={close} />;
    case 'live-switch':
      return <LiveSwitchDialog key="switch" from={dialog.from} to={dialog.to} onClose={close} />;
    default:
      return <>{render?.(dialog, close) ?? null}</>;
  }
}
