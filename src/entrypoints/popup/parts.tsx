import { useState } from 'react';
import type { Browser } from 'wxt/browser';
import { Archive, Check, ChevronDown, ChevronRight, Pause, Pin, Volume2, X } from 'lucide-react';
import { extUrl } from '@/lib/extUrl';
import { plural } from '@/lib/format';
import { displayHost } from '@/lib/urls';
import { Favicon } from '@/ui/components/Favicon';
import { IconButton } from '@/ui/components/Button';
import { Badge } from '@/ui/components/Chips';
import { cx } from '@/ui/cx';
import type { OpenWindow } from '@/ui/hooks';

export function OpenTabRow({
  tab,
  selected,
  onActivate,
  onToggleSelect,
  onSuspend,
  onSave,
  onClose,
}: {
  tab: Browser.tabs.Tab;
  selected: boolean;
  onActivate: () => void;
  onToggleSelect: () => void;
  onSuspend: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const url = tab.url || tab.pendingUrl || '';
  const own = url.startsWith(extUrl('/'));
  const host = own ? 'Tabfold' : displayHost(url);
  const title = tab.title || host || url;
  const suspended = !!tab.discarded;
  return (
    <div
      className={cx(
        'group flex h-[30px] items-center gap-0.5 pr-1 pl-2.5 hover:bg-hover focus-within:bg-hover',
        selected && 'bg-accent-soft hover:bg-accent-soft',
      )}
    >
      <button
        type="button"
        aria-label={`${title}${suspended ? ', suspended' : ''}${tab.active ? ', active tab' : ''}`}
        aria-pressed={selected || undefined}
        title={`${title}\n${url}`}
        onClick={(e) => (e.metaKey || e.ctrlKey || e.shiftKey ? onToggleSelect() : onActivate())}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        {selected ? (
          <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center rounded bg-accent text-on-accent">
            <Check size={11} strokeWidth={3} />
          </span>
        ) : (
          <Favicon url={url} dim={suspended} />
        )}
        <span className={cx('min-w-0 flex-1 truncate', suspended && 'text-text-3', tab.active && 'font-semibold')}>
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-meta text-text-3 group-focus-within:hidden group-hover:hidden">
          {suspended && <Pause size={11} strokeWidth={2.2} aria-label="Suspended" />}
          {tab.audible && <Volume2 size={11} aria-label="Playing audio" />}
          {tab.pinned && <Pin size={11} aria-label="Pinned" />}
          {host}
        </span>
      </button>
      <span className="hidden shrink-0 group-focus-within:flex group-hover:flex">
        {!tab.active && !suspended && (
          <IconButton label="Suspend tab" size="sm" onClick={onSuspend}>
            <Pause size={14} aria-hidden />
          </IconButton>
        )}
        <IconButton label="Save and close tab" size="sm" onClick={onSave}>
          <Archive size={14} aria-hidden />
        </IconButton>
        <IconButton label="Close tab" size="sm" onClick={onClose}>
          <X size={14} aria-hidden />
        </IconButton>
      </span>
    </div>
  );
}

const COLLAPSED_ROWS = 6;

export function WindowCard({
  window,
  label,
  isCurrent,
  expanded,
  onToggle,
  onRename,
  selection,
  rowHandlers,
  onSaveWindow,
}: {
  window: OpenWindow;
  label: string;
  isCurrent: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  selection: Set<number>;
  rowHandlers: (tab: Browser.tabs.Tab) => Omit<Parameters<typeof OpenTabRow>[0], 'tab' | 'selected'>;
  onSaveWindow: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const visible = showAll ? window.tabs : window.tabs.slice(0, COLLAPSED_ROWS);
  const hidden = window.tabs.length - visible.length;

  const commitName = () => {
    setEditing(false);
    if (draft.trim() !== label) onRename(draft.trim());
  };

  return (
    <section
      aria-label={`${label}, ${window.tabs.length} tabs${isCurrent ? ', current window' : ''}`}
      className="overflow-hidden rounded-card border border-border bg-surface"
    >
      <div className="flex h-9 items-center gap-1.5 pr-1 pl-1.5">
        <IconButton
          label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={expanded}
          size="sm"
          tone="muted"
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        </IconButton>
        {editing ? (
          <input
            autoFocus
            value={draft}
            aria-label="Window name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setDraft(label);
                setEditing(false);
              }
            }}
            className="h-6 w-32 rounded-md border border-accent bg-surface px-1.5 font-semibold outline-none"
          />
        ) : (
          <button
            type="button"
            title="Click to rename"
            onClick={() => {
              setDraft(label);
              setEditing(true);
            }}
            className="max-w-[150px] cursor-text truncate font-semibold"
          >
            {label}
          </button>
        )}
        <span className="shrink-0 text-text-3">· {plural(window.tabs.length, 'tab')}</span>
        {isCurrent && <Badge>Current</Badge>}
        <span className="flex-1" />
        {!expanded && (
          <span aria-hidden className="mr-1 flex gap-[3px]">
            {window.tabs.slice(0, 5).map((t) => (
              <Favicon key={t.id} url={t.url || t.pendingUrl || ''} size={14} />
            ))}
          </span>
        )}
        <IconButton label={`Save ${label}`} onClick={onSaveWindow}>
          <Archive size={16} aria-hidden />
        </IconButton>
      </div>
      {expanded && (
        <div>
          {visible.map((tab) => (
            <OpenTabRow key={tab.id} tab={tab} selected={tab.id !== undefined && selection.has(tab.id)} {...rowHandlers(tab)} />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="flex h-[30px] w-full items-center border-t border-border pl-9 text-left text-small text-text-2 hover:bg-hover"
            >
              Show {hidden} more
            </button>
          )}
        </div>
      )}
    </section>
  );
}
