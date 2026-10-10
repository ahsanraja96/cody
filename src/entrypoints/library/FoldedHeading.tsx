import { Sparkles } from 'lucide-react';
import type { ProjectsState } from '@/lib/pro/types';
import type { TabRecord } from '@/lib/types';
import { cx } from '@/ui/cx';
import { count } from './format';
import type { GroupBy } from './GroupedList';

const TOGGLE_ON = 'border border-border bg-surface font-semibold text-text';
const TOGGLE_OFF = 'text-text-2 hover:text-text';

/** Tabs folded after the last Organise that are in no project ("8 tabs folded since you organised…"). */
export function newSinceOrganised(tabs: TabRecord[], projects: ProjectsState): number {
  if (!projects.organisedAt || projects.projects.length === 0) return 0;
  const names = new Set(projects.projects.map((p) => p.name));
  return tabs.filter((t) => t.savedAt > projects.organisedAt && (t.project === undefined || !names.has(t.project))).length;
}

/**
 * The "Folded" heading row (Min-List, Pro-List-Projects): the count, the "By site / By project"
 * switch once the list has been organised, and the quiet "Organise with AI" button. By project, a
 * line says when newer tabs aren't in a project yet.
 */
export function FoldedHeading({
  tabs,
  spaced,
  groupBy,
  projects,
  onGroupBy,
  onOrganise,
}: {
  tabs: TabRecord[];
  /** Recent folds sit above it. */
  spaced: boolean;
  groupBy: GroupBy;
  projects: ProjectsState;
  onGroupBy: (by: GroupBy) => void;
  onOrganise: () => void;
}) {
  const hasProjects = projects.projects.length > 0;
  const byProject = groupBy === 'project' && hasProjects;
  const fresh = byProject ? newSinceOrganised(tabs, projects) : 0;
  // Projects whose tabs were all removed or reopened don't count.
  const inUse = new Set(tabs.map((t) => t.project));
  const projectCount = projects.projects.filter((p) => inUse.has(p.name)).length;
  const options: Array<{ value: GroupBy; label: string }> = [
    { value: 'site', label: 'By site' },
    { value: 'project', label: 'By project' },
  ];
  const current: GroupBy = byProject ? 'project' : 'site';
  return (
    <>
      <div className={cx('mb-1 flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-2 px-0.5', spaced && 'mt-7')}>
        <h1 className="m-0 text-page leading-[1.45] font-semibold">Folded</h1>
        <span className="text-text-3">
          {count(tabs.length, 'tab')} · {byProject ? count(projectCount, 'project') : 'newest first'}
        </span>
        <span className="min-w-0 flex-1" />
        {hasProjects && (
          <div role="radiogroup" aria-label="Group folded tabs" className="inline-flex h-8 items-center rounded-control border border-border-strong bg-bg-subtle p-0.5">
            {options.map((option) => {
              const on = current === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  data-value={option.value}
                  onClick={() => onGroupBy(option.value)}
                  onKeyDown={(e) => {
                    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                    e.preventDefault();
                    const next: GroupBy = option.value === 'site' ? 'project' : 'site';
                    onGroupBy(next);
                    e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
                  }}
                  className={cx('inline-flex h-[26px] items-center gap-[5px] rounded-md px-2.5 text-small', on ? TOGGLE_ON : TOGGLE_OFF)}
                >
                  {option.value === 'project' && <Sparkles size={12} strokeWidth={2} aria-hidden className="text-accent-text" />}
                  {option.label}
                </button>
              );
            })}
          </div>
        )}
        <button
          type="button"
          onClick={onOrganise}
          title="Groups your folded tabs by project. You see the groups first and choose."
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3.5 text-small font-semibold text-text hover:bg-hover"
        >
          <Sparkles size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
          Organise with AI
        </button>
      </div>
      {fresh > 0 && (
        <div
          role="status"
          className="mt-2 mb-1 flex items-center gap-2 rounded-control border border-accent-line bg-accent-soft px-3 py-2 text-small text-text-2"
        >
          <Sparkles size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-text" />
          <span className="min-w-0 flex-1">
            {count(fresh, 'tab')} folded since you organised {fresh === 1 ? 'isn’t' : 'aren’t'} in a project yet.
          </span>
          <a
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              onOrganise();
            }}
            className="shrink-0 font-semibold no-underline hover:underline"
          >
            Organise again
          </a>
        </div>
      )}
    </>
  );
}
