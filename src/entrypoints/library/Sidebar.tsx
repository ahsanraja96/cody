import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Clock, History, Laptop, Layers, Lock, MoreHorizontal, Pin, Settings as SettingsIcon, Tag, Trash2, User } from 'lucide-react';
import { db } from '@/lib/db';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { listLiveSessions, tagCounts } from '@/lib/repo';
import type { SessionRecord } from '@/lib/types';
import { IconButton } from '@/ui/components/Button';
import { PlanBadge, ProLock, tagColor } from '@/ui/components/Chips';
import { Logo } from '@/ui/components/Logo';
import { showProInfo } from '@/ui/components/ProDialog';
import { cx } from '@/ui/cx';
import type { Route } from './router';
import { TagsDialog } from './TagsDialog';
import { ManageTags } from './views/ManageTags';
import { useDismiss, useMediaQuery } from './views/parts';

/** Below this width the sidebar folds into a 64px icon rail (Library-Narrow). */
const WIDE_QUERY = '(min-width: 1200px)';

function NavItem({
  active,
  icon,
  label,
  count,
  onClick,
  tag = false,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
  tag?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cx(
        'flex shrink-0 items-center gap-2.5 rounded-control text-left transition-colors duration-150',
        tag ? 'h-[30px] pr-2 pl-3' : 'h-8 px-2',
        active ? 'bg-accent-soft font-semibold text-accent-text' : 'text-text-2 hover:bg-hover hover:text-text',
      )}
    >
      {icon}
      <span dir="auto" className="min-w-0 flex-1 truncate">
        {label}
      </span>
      {count !== undefined && <span className={cx('text-meta', !active && 'text-text-3')}>{count.toLocaleString()}</span>}
    </button>
  );
}

function RailButton({
  label,
  count,
  active = false,
  icon,
  onClick,
  badge,
  expanded,
}: {
  label: string;
  count?: string;
  active?: boolean;
  icon: ReactNode;
  onClick: () => void;
  badge?: ReactNode;
  expanded?: boolean;
}) {
  return (
    <span className="group relative flex">
      <button
        type="button"
        aria-label={count ? `${label}, ${count}` : label}
        aria-current={active ? 'page' : undefined}
        aria-expanded={expanded}
        onClick={onClick}
        className={cx(
          'relative flex size-10 items-center justify-center rounded-control transition-colors duration-150',
          active ? 'bg-accent-soft text-accent-text' : 'text-text-2 hover:bg-hover hover:text-text',
        )}
      >
        {icon}
        {badge}
      </button>
      {!expanded && (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-1/2 left-[calc(100%+6px)] z-50 hidden h-7 -translate-y-1/2 items-center gap-1.5 rounded-md bg-inverse px-2.5 text-small whitespace-nowrap text-on-inverse shadow-pop group-hover:inline-flex group-has-[:focus-visible]:inline-flex"
        >
          {label}
          {count && <span className="opacity-70">{count}</span>}
        </span>
      )}
    </span>
  );
}

export function Sidebar({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  const live = useLiveQuery(() => listLiveSessions(), []) ?? [];
  const tags = useLiveQuery(() => tagCounts(), []) ?? [];
  const trashCount = useLiveQuery(() => db.sessions.where('deletedAt').above(0).count(), []) ?? 0;
  // Every snapshot, including the rolling automatic one.
  const snapshotCount = useLiveQuery(() => db.snapshots.count(), []) ?? 0;
  const openSession = useLiveQuery(async () => (route.sessionId ? ((await db.sessions.get(route.sessionId)) ?? null) : null), [route.sessionId]);
  const wide = useMediaQuery(WIDE_QUERY);
  const [panel, setPanel] = useState<null | 'manage' | 'tags'>(null);
  const [newTagFor, setNewTagFor] = useState<SessionRecord | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closePanel = useCallback(() => setPanel(null), []);
  useDismiss(panelRef, panel !== null, closePanel);

  const pinned = live.filter((s) => s.pinned).length;
  const named = live.filter((s) => s.kind !== 'unsorted').length;
  const limits = limitsFor(CURRENT_PLAN);
  const limitedTags = Number.isFinite(limits.tags);
  const limitedSessions = Number.isFinite(limits.namedSessions);
  const go = (next: Route) => {
    setPanel(null);
    navigate(next);
  };
  const canAddTag = openSession && openSession.deletedAt === 0 ? () => setNewTagFor(openSession) : undefined;

  const manage = panel === 'manage' && (
    <ManageTags
      tags={tags}
      route={route}
      navigate={go}
      onClose={closePanel}
      onNewTag={canAddTag}
      className={wide ? '-top-2 left-[calc(100%+4px)]' : '-top-2 left-[calc(100%+12px)]'}
    />
  );

  const dialogs = <TagsDialog session={newTagFor} focusNew onClose={() => setNewTagFor(null)} />;

  if (!wide) {
    return (
      <nav aria-label="Library" className="relative z-40 flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-bg-subtle py-3">
        <span className="mb-2 flex size-10 items-center justify-center">
          <Logo size={24} />
        </span>
        <RailButton
          label="All sessions"
          count={live.length.toLocaleString()}
          active={route.view === 'all' || route.view === 'search'}
          icon={<Layers size={20} aria-hidden />}
          onClick={() => go({ view: 'all' })}
        />
        <RailButton label="Pinned" count={String(pinned)} active={route.view === 'pinned'} icon={<Pin size={20} aria-hidden />} onClick={() => go({ view: 'pinned' })} />
        <RailButton label="Recent" active={route.view === 'recent'} icon={<Clock size={20} aria-hidden />} onClick={() => go({ view: 'recent' })} />
        <RailButton
          label="Snapshots"
          count={String(snapshotCount)}
          active={route.view === 'snapshots'}
          icon={<History size={20} aria-hidden />}
          onClick={() => go({ view: 'snapshots' })}
        />
        <RailButton label="Trash" count={String(trashCount)} active={route.view === 'trash'} icon={<Trash2 size={20} aria-hidden />} onClick={() => go({ view: 'trash' })} />
        <span aria-hidden className="my-2 h-px w-6 bg-border" />
        <div ref={panelRef} className="relative flex">
          <RailButton
            label="Tags"
            count={limitedTags ? `${tags.length} of ${limits.tags}` : String(tags.length)}
            active={route.view === 'tag' || panel !== null}
            expanded={panel !== null}
            icon={<Tag size={20} aria-hidden />}
            onClick={() => setPanel(panel ? null : 'tags')}
          />
          {panel === 'tags' && (
            <div role="menu" aria-label="Tags" className="anim-in absolute top-0 left-[calc(100%+12px)] z-50 w-60 rounded-card border border-border bg-surface py-1.5 shadow-pop">
              <div className="flex h-8 items-center justify-between px-3">
                <span className="label-caps">Tags</span>
                {limitedTags && (
                  <span className="text-meta text-text-3">
                    {tags.length} of {limits.tags}
                  </span>
                )}
              </div>
              {tags.length === 0 && <p className="px-3 pb-2 text-small text-text-3">Tag sessions from their menu.</p>}
              {tags.map(({ tag, count }) => (
                <button
                  key={tag}
                  type="button"
                  role="menuitem"
                  onClick={() => go({ view: 'tag', tag })}
                  className={cx(
                    'flex h-[30px] w-full items-center gap-2.5 px-3 text-left hover:bg-hover',
                    route.view === 'tag' && route.tag === tag ? 'font-semibold text-accent-text' : 'text-text-2',
                  )}
                >
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: tagColor(tag) }} />
                  <span className="min-w-0 flex-1 truncate">{tag}</span>
                  <span className="text-meta text-text-3">{count}</span>
                </button>
              ))}
              <div className="my-1.5 h-px bg-border" />
              <button type="button" role="menuitem" onClick={() => setPanel('manage')} className="flex h-[30px] w-full items-center px-3 text-left hover:bg-hover">
                Manage tags…
              </button>
            </div>
          )}
          {manage}
        </div>
        <RailButton
          label="Devices, a Pro feature"
          icon={<Laptop size={20} aria-hidden />}
          onClick={() => showProInfo('Sync across devices')}
          badge={
            <span aria-hidden className="absolute right-[3px] bottom-[3px] flex size-3.5 items-center justify-center rounded-full bg-accent-soft text-accent-text">
              <Lock size={8} strokeWidth={2.5} />
            </span>
          }
        />
        <span className="flex-1" />
        <button
          type="button"
          title={limitedSessions ? `Free plan · ${named} of ${limits.namedSessions} sessions` : undefined}
          aria-label={limitedSessions ? `Free plan, ${named} of ${limits.namedSessions} sessions. Compare plans` : 'Compare plans'}
          onClick={() => showProInfo()}
          className="mb-1 rounded-full hover:brightness-95"
        >
          <PlanBadge plan={CURRENT_PLAN} />
        </button>
        <RailButton label="Settings" active={route.view === 'settings'} icon={<SettingsIcon size={20} aria-hidden />} onClick={() => go({ view: 'settings' })} />
        {dialogs}
      </nav>
    );
  }

  return (
    <nav aria-label="Library" className="relative z-40 flex w-60 shrink-0 flex-col gap-0.5 border-r border-border bg-bg-subtle px-3 pt-3.5 pb-3">
      <div className="mb-2.5 flex h-9 shrink-0 items-center gap-2.5 px-2">
        <Logo size={24} />
        <span className="text-section font-semibold">Tabfold</span>
      </div>
      <NavItem
        active={route.view === 'all' || route.view === 'search'}
        icon={<Layers size={16} aria-hidden />}
        label="All sessions"
        count={live.length}
        onClick={() => go({ view: 'all' })}
      />
      <NavItem active={route.view === 'pinned'} icon={<Pin size={16} aria-hidden />} label="Pinned" count={pinned} onClick={() => go({ view: 'pinned' })} />
      <NavItem active={route.view === 'recent'} icon={<Clock size={16} aria-hidden />} label="Recent" onClick={() => go({ view: 'recent' })} />
      <NavItem
        active={route.view === 'snapshots'}
        icon={<History size={16} aria-hidden />}
        label="Snapshots"
        count={snapshotCount}
        onClick={() => go({ view: 'snapshots' })}
      />
      <NavItem active={route.view === 'trash'} icon={<Trash2 size={16} aria-hidden />} label="Trash" count={trashCount} onClick={() => go({ view: 'trash' })} />

      <div ref={panelRef} className="relative mt-4 flex h-8 shrink-0 items-center gap-1.5 pr-1 pl-2">
        <h2 className="label-caps flex-1">Tags</h2>
        {limitedTags && (
          <span className="text-meta text-text-3">
            {tags.length} of {limits.tags}
          </span>
        )}
        <IconButton
          label="Manage tags"
          size="sm"
          tone="muted"
          aria-haspopup="dialog"
          aria-expanded={panel === 'manage'}
          className={panel === 'manage' ? 'bg-hover text-text' : undefined}
          onClick={() => setPanel(panel === 'manage' ? null : 'manage')}
        >
          <MoreHorizontal size={16} aria-hidden />
        </IconButton>
        {manage}
      </div>
      {tags.length === 0 && <p className="px-2 text-small text-text-3">Tag sessions from their menu.</p>}
      <div className="scroll-thin flex min-h-0 shrink flex-col gap-0.5 overflow-y-auto">
        {tags.map(({ tag, count }) => (
          <NavItem
            key={tag}
            tag
            active={route.view === 'tag' && route.tag === tag}
            icon={<span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: tagColor(tag) }} />}
            label={tag}
            count={count}
            onClick={() => go({ view: 'tag', tag })}
          />
        ))}
      </div>

      <button
        type="button"
        aria-label="Devices: sync sessions across up to 5 devices. A Pro feature"
        onClick={() => showProInfo('Sync across devices')}
        className="mt-4 flex shrink-0 flex-col items-stretch rounded-control pb-1.5 text-left hover:bg-hover"
      >
        <span className="flex h-8 items-center gap-2 px-2">
          <span className="label-caps">Devices</span>
          <ProLock />
        </span>
        <span className="px-2 text-meta text-text-3">Sync sessions across up to 5 devices.</span>
      </button>

      <div className="min-h-6 flex-1" />

      <div className="flex shrink-0 flex-col gap-2 rounded-card border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <PlanBadge plan={CURRENT_PLAN} />
          <button type="button" className="text-meta font-semibold text-accent-text hover:underline" onClick={() => showProInfo()}>
            Compare plans
          </button>
        </div>
        {limitedSessions && (
          <>
            <div
              role="progressbar"
              aria-label="Named sessions used"
              aria-valuemin={0}
              aria-valuemax={limits.namedSessions}
              aria-valuenow={Math.min(named, limits.namedSessions)}
              className="h-1 overflow-hidden rounded-full bg-hover"
            >
              <div
                className={cx('h-full', named >= limits.namedSessions ? 'bg-amber' : 'bg-accent')}
                style={{ width: `${Math.min(100, (named / limits.namedSessions) * 100)}%` }}
              />
            </div>
            <span className="text-meta text-text-3">
              {named} of {limits.namedSessions} sessions · unlimited tabs
            </span>
          </>
        )}
      </div>
      <div className="mt-1.5 flex h-11 shrink-0 items-center gap-2.5 pr-1 pl-2">
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-hover text-text-2">
          <User size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">Not signed in</div>
          <div className="truncate text-meta text-text-3">Saved on this device</div>
        </div>
        <IconButton
          label="Settings"
          size="lg"
          aria-current={route.view === 'settings' ? 'page' : undefined}
          className={route.view === 'settings' ? 'bg-accent-soft text-accent-text' : undefined}
          onClick={() => go({ view: 'settings' })}
        >
          <SettingsIcon size={18} aria-hidden />
        </IconButton>
      </div>
      {dialogs}
    </nav>
  );
}
