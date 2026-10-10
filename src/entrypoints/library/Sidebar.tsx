import type { ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Clock, History, Layers, Pin, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { listLiveSessions, listSnapshots, listTrash, tagCounts } from '@/lib/repo';
import { PlanBadge, tagColor } from '@/ui/components/Chips';
import { Logo } from '@/ui/components/Logo';
import { cx } from '@/ui/cx';
import type { Route } from './router';

function NavItem({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cx(
        'flex h-8 items-center gap-2.5 rounded-control px-2 text-left',
        active ? 'bg-accent-soft font-semibold text-accent-text' : 'text-text-2 hover:bg-hover hover:text-text',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className={cx('text-meta', active ? '' : 'text-text-3')}>{count.toLocaleString()}</span>}
    </button>
  );
}

export function Sidebar({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  const live = useLiveQuery(() => listLiveSessions(), []) ?? [];
  const tags = useLiveQuery(() => tagCounts(), []) ?? [];
  const trash = useLiveQuery(() => listTrash(), []) ?? [];
  const snapshots = useLiveQuery(() => listSnapshots(), []) ?? [];
  const pinned = live.filter((s) => s.pinned).length;
  const tabTotal = live.reduce((n, s) => n + s.tabCount, 0);
  const named = live.filter((s) => s.kind !== 'unsorted').length;
  const limits = limitsFor(CURRENT_PLAN);

  return (
    <nav aria-label="Library" className="flex w-60 shrink-0 flex-col gap-0.5 border-r border-border bg-bg-subtle px-3 pt-3.5 pb-3">
      <div className="mb-2.5 flex h-9 items-center gap-2.5 px-2">
        <Logo size={24} />
        <span className="text-section font-semibold">Tabfold</span>
      </div>
      <NavItem
        active={route.view === 'all' || route.view === 'search'}
        icon={<Layers size={16} aria-hidden />}
        label="All sessions"
        count={live.length}
        onClick={() => navigate({ view: 'all' })}
      />
      <NavItem active={route.view === 'pinned'} icon={<Pin size={16} aria-hidden />} label="Pinned" count={pinned} onClick={() => navigate({ view: 'pinned' })} />
      <NavItem active={route.view === 'recent'} icon={<Clock size={16} aria-hidden />} label="Recent" onClick={() => navigate({ view: 'recent' })} />
      <NavItem
        active={route.view === 'snapshots'}
        icon={<History size={16} aria-hidden />}
        label="Snapshots"
        count={snapshots.length}
        onClick={() => navigate({ view: 'snapshots' })}
      />
      <NavItem active={route.view === 'trash'} icon={<Trash2 size={16} aria-hidden />} label="Trash" count={trash.length} onClick={() => navigate({ view: 'trash' })} />

      <div className="mt-4 flex h-8 items-center justify-between px-2">
        <h2 className="label-caps">Tags</h2>
        {Number.isFinite(limits.tags) && <span className="text-meta text-text-3">{tags.length} of {limits.tags}</span>}
      </div>
      {tags.length === 0 && <p className="px-2 text-small text-text-3">Tag sessions from their menu.</p>}
      {tags.map(({ tag, count }) => (
        <NavItem
          key={tag}
          active={route.view === 'tag' && route.tag === tag}
          icon={<span aria-hidden className="mx-1 size-2 rounded-full" style={{ background: tagColor(tag) }} />}
          label={tag}
          count={count}
          onClick={() => navigate({ view: 'tag', tag })}
        />
      ))}

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <PlanBadge plan={CURRENT_PLAN} />
          <span className="text-meta text-text-3">{tabTotal.toLocaleString()} tabs saved</span>
        </div>
        {Number.isFinite(limits.namedSessions) && (
          <>
            <div className="h-1 overflow-hidden rounded-full bg-hover">
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
      <NavItem
        active={route.view === 'settings'}
        icon={<SettingsIcon size={16} aria-hidden />}
        label="Settings"
        onClick={() => navigate({ view: 'settings' })}
      />
    </nav>
  );
}
