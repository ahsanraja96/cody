import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { Browser } from 'wxt/browser';
import { Archive, Check, ChevronDown, ChevronRight, HatGlasses, Pause, Pin, Volume2, X } from 'lucide-react';
import { extUrl } from '@/lib/extUrl';
import { plural } from '@/lib/format';
import { classifyUrl, displayHost } from '@/lib/urls';
import { Favicon } from '@/ui/components/Favicon';
import { Button, IconButton } from '@/ui/components/Button';
import { Badge } from '@/ui/components/Chips';
import { cx } from '@/ui/cx';
import type { OpenWindow } from '@/ui/hooks';

export interface RowHandlers {
  onActivate: () => void;
  /** Cmd/Ctrl-click (or Space) toggles one tab; Shift-click selects a range. */
  onSelect?: (mode: 'toggle' | 'range') => void;
  onSuspend?: () => void;
  onSave?: () => void;
  onClose: () => void;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    return path === '/' ? '' : path;
  } catch {
    return '';
  }
}

export function tabUrl(tab: Browser.tabs.Tab): string {
  return tab.url || tab.pendingUrl || '';
}

export function OpenTabRow({
  tab,
  selected,
  skipBlank,
  handlers,
}: {
  tab: Browser.tabs.Tab;
  selected: boolean;
  /** New tab pages are skipped when saving (setting): show them as such. */
  skipBlank: boolean;
  handlers: RowHandlers;
}) {
  const url = tabUrl(tab);
  const own = url.startsWith(extUrl('/'));
  const blank = !own && classifyUrl(url) === 'blank';
  const host = own ? 'Tabfold' : displayHost(url);
  const rawTitle = (tab.title ?? '').trim();
  // A tab still loading has no title yet: the host stands in, in grey, and the path shows on the right.
  const loading = !blank && (!rawTitle || rawTitle === url);
  const title = blank ? rawTitle || 'New Tab' : loading ? host || url : rawTitle;
  const skipped = blank && skipBlank;
  const suspended = !!tab.discarded;
  const right = skipped ? 'Skipped' : loading ? pathOf(url) : blank ? '' : host;
  const state = [suspended && 'suspended', tab.audible && 'playing audio', tab.pinned && 'pinned', skipped && 'skipped when saving', selected && 'selected']
    .filter(Boolean)
    .join(', ');

  const onClick = (e: MouseEvent) => {
    if (handlers.onSelect && e.shiftKey) handlers.onSelect('range');
    else if (handlers.onSelect && (e.metaKey || e.ctrlKey)) handlers.onSelect('toggle');
    else handlers.onActivate();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== ' ' || !handlers.onSelect) return;
    e.preventDefault();
    if (e.type === 'keydown' && !e.repeat) handlers.onSelect(e.shiftKey ? 'range' : 'toggle');
  };

  return (
    <div
      role="group"
      aria-label={title}
      className={cx(
        'group flex h-[30px] items-center gap-0.5 pr-2.5 pl-2.5 focus-within:pr-1 hover:pr-1',
        selected ? 'bg-accent-soft' : 'focus-within:bg-hover hover:bg-hover',
      )}
    >
      <button
        type="button"
        dir="auto"
        aria-label={state ? `${title}, ${state}` : title}
        aria-pressed={handlers.onSelect ? selected : undefined}
        title={`${title}\n${url}`}
        onClick={onClick}
        onKeyDown={onKey}
        onKeyUp={onKey}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-offset-[-2px]"
      >
        {selected ? (
          <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center rounded bg-accent text-on-accent">
            <Check size={12} strokeWidth={3} />
          </span>
        ) : blank ? (
          <span aria-hidden className="size-4 shrink-0 rounded border border-dashed border-border-strong bg-bg-subtle" />
        ) : (
          <Favicon url={url} dim={suspended} />
        )}
        <span dir="auto" className={cx('min-w-0 flex-1 truncate', (suspended || loading || blank) && 'text-text-3')}>
          {title}
        </span>
        {(right || suspended || tab.audible || tab.pinned) && (
          <span
            className={cx(
              'flex max-w-[55%] shrink-0 items-center gap-1 text-meta group-focus-within:hidden group-hover:hidden',
              selected ? 'text-accent-text' : 'text-text-3',
            )}
          >
            {suspended && <Pause size={11} strokeWidth={2.2} aria-hidden className="shrink-0" />}
            {tab.audible && <Volume2 size={11} aria-hidden className="shrink-0" />}
            {tab.pinned && <Pin size={11} aria-hidden className="shrink-0" />}
            <span className="truncate">{right}</span>
          </span>
        )}
      </button>
      <span className="hidden shrink-0 group-focus-within:flex group-hover:flex">
        {handlers.onSuspend && !tab.active && !suspended && !blank && (
          <IconButton label="Suspend tab" size="sm" onClick={handlers.onSuspend}>
            <Pause size={14} aria-hidden />
          </IconButton>
        )}
        {handlers.onSave && !blank && !own && (
          <IconButton label="Save and close tab" size="sm" onClick={handlers.onSave}>
            <Archive size={14} aria-hidden />
          </IconButton>
        )}
        <IconButton label="Close tab" size="sm" onClick={handlers.onClose}>
          <X size={14} aria-hidden />
        </IconButton>
      </span>
    </div>
  );
}

const MIN_ROWS = 4;
const MIN_ROWS_NARROW = 2;

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
  saveDisabled,
  skipBlank,
  narrow,
  sessionTag,
  suspendedNote,
  closing,
}: {
  window: OpenWindow;
  label: string;
  isCurrent: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  selection: Set<number>;
  rowHandlers: (tab: Browser.tabs.Tab) => RowHandlers;
  /** Absent when the window holds nothing to save (only pinned or new tab pages). */
  onSaveWindow?: () => void;
  saveDisabled?: boolean;
  skipBlank: boolean;
  narrow: boolean;
  /** The saved session this window is an open copy of (the "already open" prompt). */
  sessionTag?: string;
  /** Show how many tabs are suspended (right after "Suspend inactive"). */
  suspendedNote?: boolean;
  closing?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const tabs = window.tabs;
  const selectedHere = tabs.filter((t) => t.id !== undefined && selection.has(t.id)).length;
  const lastSelected = tabs.reduce((last, t, i) => (t.id !== undefined && selection.has(t.id) ? i : last), -1);
  const rows = Math.max(narrow ? MIN_ROWS_NARROW : MIN_ROWS, lastSelected + 1);
  // "Show 1 more" is silly: show the last row instead.
  const visible = showAll || tabs.length <= rows + 1 ? tabs : tabs.slice(0, rows);
  const hidden = tabs.length - visible.length;
  const suspended = tabs.filter((t) => t.discarded).length;

  const commitName = () => {
    setEditing(false);
    if (draft.trim() !== label) onRename(draft.trim());
  };

  const description = [
    label,
    isCurrent && 'current window',
    plural(tabs.length, 'tab'),
    selectedHere > 0 && `${selectedHere} selected`,
    sessionTag && `from ${sessionTag}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <section
      aria-label={description}
      className={cx(
        'overflow-hidden rounded-card border bg-surface',
        sessionTag ? 'border-accent-line' : 'border-border',
        closing && 'tf-fade-out',
      )}
    >
      <div className="flex h-9 items-center gap-1.5 pr-1 pl-1.5">
        <IconButton
          label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={expanded}
          size="sm"
          tone="muted"
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={14} strokeWidth={2} aria-hidden /> : <ChevronRight size={14} strokeWidth={2} aria-hidden />}
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
                e.preventDefault();
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
            dir="auto"
            title="Click to rename"
            aria-label={`${label}, rename`}
            onClick={() => {
              setDraft(label);
              setEditing(true);
            }}
            className="min-w-0 max-w-[150px] cursor-text truncate font-semibold"
          >
            {label}
          </button>
        )}
        <span className="shrink-0 text-text-3">· {plural(tabs.length, 'tab')}</span>
        {isCurrent && <Badge>Current</Badge>}
        <span className="min-w-0 flex-1" />
        {sessionTag ? (
          <span dir="auto" className="mr-1 min-w-0 truncate text-meta font-semibold text-accent-text">
            {sessionTag}
          </span>
        ) : suspendedNote && suspended > 0 ? (
          <span className="mr-1 shrink-0 text-meta text-text-3">{suspended} suspended</span>
        ) : (
          !expanded && (
            <span aria-hidden className="mr-1 flex min-w-0 gap-[3px] overflow-hidden">
              {tabs
                .filter((t) => classifyUrl(tabUrl(t)) !== 'blank')
                .slice(0, 5)
                .map((t) => (
                  <Favicon key={t.id} url={tabUrl(t)} size={14} />
                ))}
            </span>
          )
        )}
        {onSaveWindow ? (
          <IconButton label={`Save ${label}`} disabled={saveDisabled} onClick={onSaveWindow}>
            <Archive size={16} aria-hidden />
          </IconButton>
        ) : (
          <span aria-hidden className="w-1" />
        )}
      </div>
      {expanded && (
        <div>
          {visible.map((tab) => (
            <OpenTabRow
              key={tab.id}
              tab={tab}
              selected={tab.id !== undefined && selection.has(tab.id)}
              skipBlank={skipBlank}
              handlers={rowHandlers(tab)}
            />
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

/** The Incognito window the popup was opened in. Never saved without asking. */
export function IncognitoWindowCard({
  window,
  expanded,
  onToggle,
  rowHandlers,
  onSave,
  saveDisabled,
  skipBlank,
}: {
  window: OpenWindow;
  expanded: boolean;
  onToggle: () => void;
  rowHandlers: (tab: Browser.tabs.Tab) => RowHandlers;
  onSave: () => void;
  saveDisabled?: boolean;
  skipBlank: boolean;
}) {
  return (
    <section
      aria-label={`Incognito window, ${plural(window.tabs.length, 'tab')}, current window`}
      className="overflow-hidden rounded-card border border-border-strong bg-bg-subtle"
    >
      <div className="flex h-10 items-center gap-1.5 px-1.5">
        <IconButton
          label={expanded ? 'Collapse Incognito window' : 'Expand Incognito window'}
          aria-expanded={expanded}
          size="sm"
          tone="muted"
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={14} strokeWidth={2} aria-hidden /> : <ChevronRight size={14} strokeWidth={2} aria-hidden />}
        </IconButton>
        <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-inverse text-on-inverse">
          <HatGlasses size={14} />
        </span>
        <span className="shrink-0 font-semibold">Incognito</span>
        <span className="shrink-0 text-text-3">· {plural(window.tabs.length, 'tab')}</span>
        <span className="min-w-0 flex-1" />
        <Button size="xs" disabled={saveDisabled} onClick={onSave}>
          Save this window…
        </Button>
      </div>
      {expanded && (
        <div className="border-t border-border bg-surface">
          {window.tabs.map((tab) => (
            <OpenTabRow key={tab.id} tab={tab} selected={false} skipBlank={skipBlank} handlers={rowHandlers(tab)} />
          ))}
        </div>
      )}
    </section>
  );
}
