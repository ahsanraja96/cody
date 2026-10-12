import { useId, useState, type ReactNode } from 'react';
import { ArrowRight, Plus, Sparkles, Trash2, Zap } from 'lucide-react';
import { FREE_LIMITS } from '@/lib/limits';
import type { PlanState } from '@/lib/pro/types';
import type { AutoFoldNotice, AutoFoldRuns } from '@/lib/state';
import type { AutoFoldInto, AutoFoldRule, AutoFoldWhen, Settings } from '@/lib/settings';
import { normalizeDomain } from '@/lib/settings';
import type { FolderRecord } from '@/lib/types';
import { Switch } from '@/ui/components/Controls';
import { ColorDot, FolderIcon } from '@/ui/components/FolderIcon';
import { ProTag } from '@/ui/components/ProBits';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { hasFreeLimits } from '@/ui/hooks';
import { count, foldTime } from './format';
import { PRIMARY, SECONDARY, SmallDialog } from './FolderDialogs';
import { goToPlans } from './router';

/**
 * Settings › Fold automatically (Mx-Auto): rules that fold tabs for you, each with a switch, and
 * "Add a rule" (When / Which / Into). Free runs one rule, the "not looked at for N days" kind into
 * their kind of site; times of day, sites and folders show a Pro chip and open the plans.
 */

const DAY_CHOICES = [1, 2, 3, 7, 14, 30];
const MINUTE_CHOICES = [15, 30, 60, 120, 240];
const WEEKDAYS = [1, 2, 3, 4, 5];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function minutesText(minutes: number): string {
  return minutes % 60 === 0 ? (minutes === 60 ? '1 hour' : `${minutes / 60} hours`) : `${minutes} min`;
}

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function daysText(weekdays: number[]): string {
  const set = [...new Set(weekdays)].sort();
  if (set.length === 7) return 'Every day';
  if (set.length === 5 && WEEKDAYS.every((d) => set.includes(d))) return 'Every weekday';
  if (set.length === 2 && set.includes(0) && set.includes(6)) return 'Every weekend';
  return set.map((d) => DAY_NAMES[d]).join(', ');
}

/** Free can run this rule: "not looked at for N days", into their kind of site. */
export function freeRule(rule: Pick<AutoFoldRule, 'when' | 'into'>): boolean {
  return rule.when.type === 'idle' && rule.into.type === 'site';
}

export function describeRule(rule: AutoFoldRule, folders: readonly FolderRecord[]): { when: string; which: string; into: ReactNode } {
  const folder = rule.into.type === 'folder' ? folders.find((f) => f.id === (rule.into as { folderId: string }).folderId) : undefined;
  const into =
    rule.into.type === 'folder' ? (
      <>
        <FolderIcon color={folder?.color ?? 'grey'} size={14} />
        {folder?.name ?? 'a deleted folder'}
      </>
    ) : rule.when.type === 'time' ? (
      'a new fold'
    ) : (
      <>
        <ColorDot color="grey" size={8} />
        their kind of site
      </>
    );
  switch (rule.when.type) {
    case 'idle':
      return { when: `Tabs I haven’t looked at for ${count(rule.when.days, 'day')}`, which: 'all sites', into };
    case 'time':
      return { when: `${daysText(rule.when.weekdays)} at ${clock(rule.when.hour, rule.when.minute)}`, which: 'everything open', into };
    case 'site-idle': {
      const hosts = rule.when.hosts;
      const first = hosts[0] ?? 'a site';
      return {
        when: `${first}${hosts.length > 1 ? ` +${hosts.length - 1}` : ''} idle for ${minutesText(rule.when.minutes)}`,
        which: hosts.length > 1 ? 'just those sites' : 'just that site',
        into,
      };
    }
    case 'window-cap':
      return { when: `A window has more than ${count(rule.when.max, 'tab')}`, which: 'the ones I haven’t looked at longest', into };
  }
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
}

export function AutoFoldSection({
  settings,
  update,
  plan,
  folders,
  notice,
  runs,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  plan: PlanState;
  folders: readonly FolderRecord[];
  notice: AutoFoldNotice | undefined;
  /** When each rule last ran (`autoFoldLast`). */
  runs: AutoFoldRuns;
}) {
  const [adding, setAdding] = useState(false);
  const free = hasFreeLimits(plan);
  const rules = settings.autoFold;

  const setRules = (next: AutoFoldRule[]) => update({ autoFold: next });
  const toggle = (rule: AutoFoldRule, on: boolean) => {
    if (on && free && !freeRule(rule)) {
      goToPlans();
      return;
    }
    if (on && free && rules.filter((r) => r.enabled && r.id !== rule.id).length >= FREE_LIMITS.rules) {
      toast(`Free runs ${FREE_LIMITS.rules} rule at a time. Switch the other off, or upgrade for as many as you like.`, {
        action: { label: 'Upgrade', onClick: goToPlans },
      });
      return;
    }
    setRules(rules.map((r) => (r.id === rule.id ? { ...r, enabled: on } : r)));
  };

  const add = (when: AutoFoldWhen, into: AutoFoldInto) => {
    const room = !free || rules.filter((r) => r.enabled).length < FREE_LIMITS.rules;
    const rule: AutoFoldRule = { id: newId(), enabled: room, when, into, createdAt: Date.now() };
    setRules([...rules, rule]);
    if (!room) toast('Saved, switched off: Free runs one rule at a time.', { action: { label: 'Upgrade', onClick: goToPlans } });
  };

  return (
    <section aria-labelledby="auto-h" className="border-b border-border py-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="auto-h" className="m-0 text-body font-semibold">
            Fold automatically
          </h2>
          <p className="mt-1 mb-0 text-small text-text-3">Rules that fold tabs for you. Pinned and playing tabs always stay.</p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3 text-small font-semibold text-text hover:bg-hover"
        >
          <Plus size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
          Add a rule
        </button>
      </div>
      {rules.length === 0 ? (
        <p className="mt-3 mb-0 rounded-control border border-dashed border-border-strong px-3.5 py-3 text-small text-text-2">
          No rules yet. For example: fold tabs you haven’t looked at for 3 days.
        </p>
      ) : (
        <ul className="m-0 mt-2 list-none p-0">
          {rules.map((rule) => {
            const d = describeRule(rule, folders);
            const pro = free && !freeRule(rule);
            const last = runs[rule.id] ?? (notice && notice.ruleId === rule.id ? { at: notice.at, folded: notice.folded } : undefined);
            const ran = last ? `Last ran ${foldTime(last.at).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())} · folded ${count(last.folded, 'tab')}` : null;
            return (
              <li key={rule.id} className="group/rule flex items-start gap-3.5 border-t border-border py-3.5 first:border-t-0 pl-1">
                <Zap size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-accent-text" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <b className="font-semibold">{d.when}</b>
                    <span className="text-text-2">{d.which}</span>
                    <ArrowRight size={13} strokeWidth={1.75} aria-hidden className="text-text-3" />
                    <span className="inline-flex items-center gap-1.5">{d.into}</span>
                    {pro && <ProTag />}
                  </div>
                  {ran && <div className="mt-0.5 text-small text-text-3">{ran}</div>}
                </div>
                <button
                  type="button"
                  aria-label="Remove rule"
                  title="Remove rule"
                  onClick={() => setRules(rules.filter((r) => r.id !== rule.id))}
                  className="invisible inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 group-focus-within/rule:visible group-hover/rule:visible hover:bg-hover hover:text-text"
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                </button>
                <span className="mt-px">
                  <Switch checked={rule.enabled && !pro} onChange={(on) => toggle(rule, on)} label={`${d.when}, ${d.which}`} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {adding && <RuleDialog folders={folders} free={free} onClose={() => setAdding(false)} onSave={add} />}
    </section>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <>
      <label htmlFor={id} className="text-text-2">
        {label}
      </label>
      <div className="flex min-w-0 gap-2">{children}</div>
    </>
  );
}

const SELECT =
  'h-8 min-w-0 flex-1 appearance-none rounded-control border border-border-strong bg-surface bg-[length:14px] bg-[right_8px_center] bg-no-repeat py-0 pr-7 pl-2.5 text-text';
const CHEVRON = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e8e98' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
};

/** "New rule" (Mx-Auto "Adding a rule"): When, Which, Into. */
function RuleDialog({
  folders,
  free,
  onClose,
  onSave,
}: {
  folders: readonly FolderRecord[];
  free: boolean;
  onClose: () => void;
  onSave: (when: AutoFoldWhen, into: AutoFoldInto) => void;
}) {
  const [kind, setKind] = useState<AutoFoldWhen['type']>('idle');
  const [days, setDays] = useState(3);
  const [time, setTime] = useState('18:00');
  const [weekdays, setWeekdays] = useState<number[]>(WEEKDAYS);
  const [minutes, setMinutes] = useState(60);
  const [hosts, setHosts] = useState('');
  const [into, setInto] = useState<string>('site');
  const ids = { when: useId(), param: useId(), which: useId(), into: useId() };

  const hostList = hosts
    .split(/[\s,]+/)
    .map((h) => normalizeDomain(h))
    .filter((h): h is string => !!h);
  const needsPro = free && (kind !== 'idle' || into !== 'site');
  const valid = kind !== 'site-idle' || hostList.length > 0;

  const save = () => {
    if (needsPro) {
      onClose();
      goToPlans();
      return;
    }
    let when: AutoFoldWhen;
    if (kind === 'idle') when = { type: 'idle', days };
    else if (kind === 'time') {
      const [h, m] = time.split(':').map(Number);
      when = { type: 'time', hour: h ?? 18, minute: m ?? 0, weekdays: weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6] };
    } else when = { type: 'site-idle', hosts: [...new Set(hostList)], minutes };
    onSave(when, into === 'site' ? { type: 'site' } : { type: 'folder', folderId: into });
    onClose();
  };

  return (
    <SmallDialog
      open
      onClose={onClose}
      width={420}
      title="New rule"
      closeButton
      footer={
        <>
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          <button type="button" disabled={!valid} onClick={save} className={PRIMARY}>
            {needsPro && <Sparkles size={14} strokeWidth={1.75} aria-hidden />}
            {needsPro ? 'Upgrade to save' : 'Save rule'}
          </button>
        </>
      }
    >
      <div className="mt-4 grid grid-cols-[56px_minmax(0,1fr)] items-center gap-3">
        <Field label="When" id={ids.when}>
          <select id={ids.when} value={kind} onChange={(e) => setKind(e.target.value as AutoFoldWhen['type'])} className={SELECT} style={CHEVRON}>
            <option value="idle">Not looked at for</option>
            <option value="time">Every day at{free ? ' (Pro)' : ''}</option>
            <option value="site-idle">A site is idle for{free ? ' (Pro)' : ''}</option>
          </select>
          {kind === 'idle' && (
            <select aria-label="Days" value={days} onChange={(e) => setDays(Number(e.target.value))} className={cx(SELECT, 'max-w-[104px]')} style={CHEVRON}>
              {DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {count(d, 'day')}
                </option>
              ))}
            </select>
          )}
          {kind === 'time' && (
            <input
              aria-label="Time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-8 w-[104px] shrink-0 rounded-control border border-border-strong bg-surface px-2 text-text"
            />
          )}
          {kind === 'site-idle' && (
            <select aria-label="Idle for" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={cx(SELECT, 'max-w-[104px]')} style={CHEVRON}>
              {MINUTE_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {minutesText(m)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {kind === 'time' && (
          <>
            <span className="text-text-2">Days</span>
            <div role="group" aria-label="Days" className="flex flex-wrap gap-1">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const on = weekdays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setWeekdays((w) => (on ? w.filter((x) => x !== d) : [...w, d]))}
                    className={cx(
                      'h-7 rounded-md px-2 text-small',
                      on ? 'border border-accent-line bg-accent-soft font-semibold text-accent-text' : 'border border-border-strong text-text-2 hover:bg-hover',
                    )}
                  >
                    {DAY_NAMES[d]}
                  </button>
                );
              })}
            </div>
          </>
        )}
        <Field label="Which" id={ids.which}>
          {kind === 'site-idle' ? (
            <input
              id={ids.which}
              value={hosts}
              placeholder="youtube.com, reddit.com"
              onChange={(e) => setHosts(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-control border border-border-strong bg-surface px-2.5 text-text outline-none focus:border-accent"
            />
          ) : (
            <select id={ids.which} disabled value="all" className={SELECT} style={CHEVRON}>
              <option value="all">{kind === 'time' ? 'Everything open' : 'All sites'}</option>
            </select>
          )}
        </Field>
        <Field label="Into" id={ids.into}>
          <select id={ids.into} value={into} onChange={(e) => setInto(e.target.value)} className={SELECT} style={CHEVRON}>
            <option value="site">{kind === 'time' ? 'A new fold' : 'Their kind of site'}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {free ? ' (Pro)' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {needsPro && (
        <p role="status" className="mt-3.5 mb-0 flex items-center gap-2 rounded-control bg-accent-soft px-3 py-2 text-small text-text-2">
          <Sparkles size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-text" />
          Free has one rule: tabs you haven’t looked at for a few days. Times of day, sites and folders are part of Pro.
        </p>
      )}
    </SmallDialog>
  );
}
