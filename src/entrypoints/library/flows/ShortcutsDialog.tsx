import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/ui/cx';
import { FlowDialog } from './FlowDialog';
import { APP_KEYS, COMMANDS, openShortcutsPage, PLATFORM_NOTE, SHORTCUTS_PAGE, useCommandShortcuts } from './shortcuts';

/** A key chip as on the boards: 22px, 12px text. */
export function KeyChip({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[5px] border border-border-strong bg-surface px-[7px] text-small whitespace-nowrap text-text-2">
      {children}
    </kbd>
  );
}

function Row({ label, keys, last }: { label: string; keys: ReactNode; last?: boolean }) {
  return (
    <div className={cx('flex h-9 items-center gap-3', !last && 'border-b border-border')}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="inline-flex shrink-0 gap-1">{keys}</span>
    </div>
  );
}

/** "?" in the library (Library-Shortcuts): Chrome-wide commands with their real bindings, and in-app keys. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { shortcuts } = useCommandShortcuts();
  return (
    <FlowDialog
      open
      onClose={onClose}
      title="Keyboard shortcuts"
      width={760}
      bodyClassName="pt-4"
      headerClassName="pr-3.5 pl-6"
      band={
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border bg-bg-subtle px-6 py-3">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              openShortcutsPage();
            }}
            className="inline-flex items-center gap-1.5 font-semibold whitespace-nowrap no-underline hover:underline"
          >
            Change shortcuts at {SHORTCUTS_PAGE}
            <ExternalLink size={14} aria-hidden />
          </a>
          <span className="text-meta text-text-3">{PLATFORM_NOTE}</span>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 px-6 pt-3 pb-6 min-[720px]:grid-cols-2">
        <section aria-labelledby="kb-chrome">
          <h3 id="kb-chrome" className="mb-0.5 label-caps">
            Anywhere in Chrome
          </h3>
          <p className="mb-1.5 text-meta text-text-3">Work even when Tabfold is closed.</p>
          {COMMANDS.map((command, index) => {
            const shortcut = shortcuts[command.name];
            return (
              <Row
                key={command.name}
                label={command.short}
                last={index === COMMANDS.length - 1}
                keys={shortcut ? <KeyChip>{shortcut}</KeyChip> : <span className="text-small text-text-3">Not set</span>}
              />
            );
          })}
        </section>
        <section aria-labelledby="kb-app">
          <h3 id="kb-app" className="mb-0.5 label-caps">
            In Tabfold
          </h3>
          <p className="mb-1.5 text-meta text-text-3">In the popup and the library.</p>
          {APP_KEYS.map((row, index) => (
            <Row
              key={row.label}
              label={row.label}
              last={index === APP_KEYS.length - 1}
              keys={row.keys.map((key) => (
                <KeyChip key={key}>{key}</KeyChip>
              ))}
            />
          ))}
        </section>
      </div>
    </FlowDialog>
  );
}
