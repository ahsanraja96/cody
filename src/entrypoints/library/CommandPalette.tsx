import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Command, CopyX, FolderPlus, Settings, Sparkles, Trash2, Upload } from 'lucide-react';
import type { PlanState } from '@/lib/pro/types';
import type { LiveFolder } from '@/lib/state';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { Kbd } from '@/ui/components/Chips';
import { Favicon } from '@/ui/components/Favicon';
import { FolderIcon } from '@/ui/components/FolderIcon';
import { Modal } from '@/ui/components/Modal';
import { cx } from '@/ui/cx';
import { hasFreeLimits, useTabSearch } from '@/ui/hooks';
import { openFolded, openGroup } from './actions';
import { folderLimitReached, openLive } from './folderActions';
import { openDialog } from './uiStore';

interface Option {
  id: string;
  section: 'Folders' | 'Actions' | 'Folded tabs';
  label: string;
  icon: ReactNode;
  run: () => void;
}

function matches(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = text.toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

const ICON = { size: 15, strokeWidth: 1.75, 'aria-hidden': true, className: 'shrink-0 text-text-2' } as const;

/**
 * Ctrl+K / ⌘K in the full list (Mx-Ask): open a folder (live on Pro), run an action, or jump to
 * a folded tab. ↑↓ move, ↵ runs, Esc closes.
 */
export function CommandPalette({
  onClose,
  folders,
  tabs,
  plan,
  liveFolders,
  actions,
}: {
  onClose: () => void;
  folders: FolderRecord[];
  tabs: TabRecord[];
  plan: PlanState;
  liveFolders: Record<string, LiveFolder>;
  actions: { settings: () => void; importer: () => void; makeRoom: () => void; organise: () => void };
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const free = hasFreeLimits(plan);
  const { result } = useTabSearch(query, [], { limit: 6 });
  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    for (const folder of folders) {
      if (!matches(folder.name, query)) continue;
      const items = tabs.filter((t) => t.folderId === folder.id && !t.snoozeUntil);
      out.push({
        id: `f:${folder.id}`,
        section: 'Folders',
        label: free ? `${folder.name} · open all` : liveFolders[folder.id] ? `${folder.name} · go to the live group` : `${folder.name} · open live`,
        icon: <FolderIcon color={folder.color} size={15} />,
        run: () => (free ? void openGroup(items, folder) : void openLive(folder, liveFolders, folders, plan)),
      });
      if (out.length >= 6) break;
    }
    const acts: Array<Omit<Option, 'section'> & { keywords: string }> = [
      {
        id: 'a:new',
        label: 'New folder',
        icon: <FolderPlus {...ICON} />,
        keywords: 'new folder create add',
        run: () => openDialog(folderLimitReached(plan, folders) ? { kind: 'folder-limit' } : { kind: 'new-folder' }),
      },
      ...(free ? [{ id: 'a:room', label: 'Make room', icon: <Trash2 {...ICON} />, keywords: 'make room free space limit full remove old', run: actions.makeRoom }] : []),
      { id: 'a:dups', label: 'Find duplicates', icon: <CopyX {...ICON} />, keywords: 'find duplicates same page twice copies', run: () => openDialog({ kind: 'duplicates' }) },
      { id: 'a:organise', label: 'Organise with AI', icon: <Sparkles {...ICON} />, keywords: 'organise organize ai folders sort', run: actions.organise },
      { id: 'a:import', label: 'Import…', icon: <Upload {...ICON} />, keywords: 'import onetab toby workona session buddy bookmarks links', run: actions.importer },
      { id: 'a:settings', label: 'Settings', icon: <Settings {...ICON} />, keywords: 'settings preferences options', run: actions.settings },
    ];
    for (const act of acts) if (matches(`${act.label} ${act.keywords}`, query)) out.push({ ...act, section: 'Actions' });
    if (query.trim() && result) {
      for (const hit of result.saved.slice(0, 6)) {
        const tab = hit.doc.tabRecordId ? tabs.find((t) => t.id === hit.doc.tabRecordId) : undefined;
        if (!tab) continue;
        out.push({
          id: `t:${tab.id}`,
          section: 'Folded tabs',
          label: tab.title || tab.url,
          icon: <Favicon url={tab.url} size={16} />,
          run: () => void openFolded(tab, true),
        });
      }
    }
    return out;
  }, [folders, tabs, query, free, liveFolders, plan, result, actions]);

  useEffect(() => setActive(0), [query]);
  const current = options[Math.min(active, options.length - 1)];

  useEffect(() => {
    listRef.current?.querySelector(`[data-option="${current?.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current?.id]);

  const run = (option: Option | undefined) => {
    if (!option) return;
    onClose();
    option.run();
  };

  let lastSection = '';
  return (
    <Modal open onClose={onClose} labelledBy={`${listId}-label`} width={520} className="mt-[12vh] mb-auto">
      <div className="flex h-[46px] items-center gap-2.5 border-b border-border px-3.5">
        <Command size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
        <span id={`${listId}-label`} className="sr-only">
          Jump to a folder, an action or a folded tab
        </span>
        <input
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
          aria-labelledby={`${listId}-label`}
          value={query}
          placeholder="Folders, actions, folded tabs"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (options.length) setActive((a) => (Math.min(a, options.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(current);
            }
          }}
          className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none"
        />
        <Kbd>esc</Kbd>
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="scroll-thin max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
        {options.length === 0 && <p className="m-0 px-2 py-3 text-text-3">Nothing matches “{query.trim()}”.</p>}
        {options.map((option) => {
          const heading = option.section !== lastSection ? option.section : null;
          lastSection = option.section;
          const on = option === current;
          return (
            <div key={option.id}>
              {heading && (
                <div role="presentation" className="px-2 pt-2 pb-1 text-meta font-semibold tracking-[.04em] text-text-3 uppercase">
                  {heading}
                </div>
              )}
              <div
                id={`${listId}-${option.id}`}
                data-option={option.id}
                role="option"
                aria-selected={on}
                onMouseMove={() => setActive(options.indexOf(option))}
                onClick={() => run(option)}
                className={cx('flex h-[34px] cursor-pointer items-center gap-2.5 rounded-md px-2', on && 'bg-hover')}
              >
                {option.icon}
                <span dir="auto" className="min-w-0 flex-1 truncate">
                  {option.label}
                </span>
                {on && <Kbd>↵</Kbd>}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
