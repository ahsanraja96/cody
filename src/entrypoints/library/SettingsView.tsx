import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Check, Download, ExternalLink, Info, Laptop, X } from 'lucide-react';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { listLiveSessions, tagCounts } from '@/lib/repo';
import { AUTO_SUSPEND_CHOICES, normalizeDomain } from '@/lib/settings';
import { Button } from '@/ui/components/Button';
import { Checkbox, RadioGroup, Segmented, Select, Switch } from '@/ui/components/Controls';
import { PlanBadge, ProLock } from '@/ui/components/Chips';
import { showProInfo } from '@/ui/components/ProDialog';
import { cx } from '@/ui/cx';
import { isMac, useSettings } from '@/ui/hooks';
import { exportSessions } from './actions';
import { PRO_EXPORT_FEATURE } from './flows/ExportDialog';
import { openClearDataDialog, openImportDialog } from './flows/index';
import { combo, COMMANDS, openShortcutsPage, useCommandShortcuts } from './flows/shortcuts';

const SECTIONS = [
  ['general', 'General'],
  ['memory', 'Memory'],
  ['shortcuts', 'Shortcuts'],
  ['data', 'Data & privacy'],
  ['plan', 'Plan & billing'],
] as const;

function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-8 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="text-section font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-card border border-border bg-surface', className)}>{children}</div>;
}

/** A setting: title (and hint) on the left, its control on the right. */
function Row({
  title,
  hint,
  control,
  strong,
  divider,
  tight,
  align = 'center',
}: {
  title: ReactNode;
  hint?: ReactNode;
  control: ReactNode;
  strong?: boolean;
  divider?: boolean;
  /** Rows inside a group use 10px padding; standalone rows 14px. */
  tight?: boolean;
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={cx(
        'flex flex-wrap gap-x-4 gap-y-2 px-4',
        tight ? 'py-2.5' : 'py-3.5',
        align === 'center' ? 'items-center' : 'items-start',
        divider && 'border-b border-border',
      )}
    >
      <div className="min-w-[220px] flex-1">
        <div className={strong ? 'font-semibold' : undefined}>{title}</div>
        {hint && <div className="text-small text-text-3">{hint}</div>}
      </div>
      {control}
    </div>
  );
}

function Group({ label }: { label: string }) {
  return <div className="px-4 pt-3.5 pb-1.5 label-caps">{label}</div>;
}

function DomainList({ domains, onChange }: { domains: string[]; onChange: (domains: string[]) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  const add = () => {
    const domain = normalizeDomain(text);
    if (!domain) {
      setError(!!text.trim());
      return;
    }
    if (!domains.includes(domain)) onChange([...domains, domain]);
    setText('');
    setError(false);
  };
  return (
    <div className="px-4 pb-4">
      <div className="mb-2 text-small text-text-2">Sites to never suspend</div>
      <div
        className={cx(
          'flex flex-wrap items-center gap-1.5 rounded-control border bg-surface p-1.5',
          error ? 'border-red' : 'border-border-strong focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]',
        )}
      >
        {domains.map((domain) => (
          <span key={domain} className="inline-flex h-[26px] items-center gap-1 rounded-md bg-hover pr-1 pl-2.5 text-small">
            {domain}
            <button
              type="button"
              aria-label={`Remove ${domain}`}
              onClick={() => onChange(domains.filter((d) => d !== domain))}
              className="inline-flex size-5 items-center justify-center rounded text-text-3 hover:bg-border"
            >
              <X size={12} strokeWidth={2} aria-hidden />
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            } else if (e.key === 'Backspace' && !text && domains.length) {
              onChange(domains.slice(0, -1));
            }
          }}
          onBlur={() => text.trim() && add()}
          placeholder="Add a site, e.g. notion.so"
          aria-label="Add a site to never suspend"
          aria-invalid={error}
          className="h-[26px] min-w-[160px] flex-1 border-0 bg-transparent px-1.5 outline-none"
        />
      </div>
      {error && <p className="mt-1.5 text-small text-red">Enter a site like figma.com</p>}
    </div>
  );
}

/** "⌥ ⇧ F" on a Mac (Chrome gives "⌥⇧F"); "Alt+Shift+F" elsewhere. */
function spaced(shortcut: string): string {
  return isMac && !shortcut.includes('+') ? [...shortcut].join(' ') : shortcut;
}

function SettingsKey({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[22px] items-center rounded-[5px] border border-border-strong bg-bg-subtle px-[7px] text-small whitespace-nowrap text-text-2">
      {children}
    </kbd>
  );
}

function KeyRow({ label, keys, last }: { label: string; keys: ReactNode; last?: boolean }) {
  return (
    <div className={cx('flex h-11 items-center gap-3 px-4', !last && 'border-b border-border')}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="inline-flex shrink-0 gap-1">{keys}</span>
    </div>
  );
}

/** The section in view, for the nav highlight. */
function useActiveSection(root: React.RefObject<HTMLElement | null>, initial: string): string {
  const [active, setActive] = useState(initial);
  useEffect(() => {
    const scroller = root.current;
    if (!scroller) return;
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top;
      let current: string = SECTIONS[0][0];
      for (const [id] of SECTIONS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top - top <= 80) current = id;
      }
      if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = SECTIONS.at(-1)![0];
      setActive(current);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [root]);
  return active;
}

export function SettingsView({ section, onBack }: { section?: string; onBack?: () => void }) {
  const [settings, update] = useSettings();
  const { shortcuts } = useCommandShortcuts();
  const sessions = useLiveQuery(() => listLiveSessions(), []) ?? [];
  const tags = useLiveQuery(() => tagCounts(), []) ?? [];
  const limits = limitsFor(CURRENT_PLAN);
  const scrollRef = useRef<HTMLDivElement>(null);
  const active = useActiveSection(scrollRef, section ?? 'general');

  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ block: 'start' });
  }, [section]);

  const named = sessions.filter((s) => s.kind !== 'unsorted').length;

  return (
    <div className="flex h-full overflow-hidden bg-bg-subtle">
      <nav aria-label="Settings sections" className="hidden w-60 shrink-0 flex-col gap-0.5 border-r border-border bg-bg-subtle px-3 py-3.5 min-[900px]:flex">
        <a
          href="#/all"
          onClick={(e) => {
            if (!onBack) return;
            e.preventDefault();
            onBack();
          }}
          className="mb-2.5 flex h-9 items-center gap-2 rounded-control px-2 font-semibold text-text-2 no-underline hover:bg-hover hover:text-text"
        >
          <ArrowLeft size={16} aria-hidden />
          Back to library
        </a>
        {SECTIONS.map(([id, label]) => (
          <a
            key={id}
            href={`#/settings/${id}`}
            aria-current={active === id ? 'location' : undefined}
            onClick={(e) => {
              e.preventDefault();
              history.replaceState(null, '', `#/settings/${id}`);
              document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }}
            className={cx(
              'flex h-8 items-center rounded-control px-2 no-underline',
              active === id ? 'bg-accent-soft font-semibold text-accent-text' : 'text-text-2 hover:bg-hover hover:text-text',
            )}
          >
            {label}
          </a>
        ))}
      </nav>

      <div ref={scrollRef} className="scroll-thin relative min-w-0 flex-1 overflow-y-auto">
        <main className="px-6 pt-8 pb-16 min-[900px]:px-10">
          <div className="flex max-w-[760px] flex-col gap-9">
            <div className="flex flex-col gap-3">
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  className="-ml-2 flex h-8 w-fit items-center gap-2 rounded-control px-2 font-semibold text-text-2 hover:bg-hover min-[900px]:hidden"
                >
                  <ArrowLeft size={16} aria-hidden />
                  Back to library
                </button>
              )}
              <h1 className="text-page font-semibold">Settings</h1>
            </div>

            <Section id="general" title="General">
              <Card>
                <Row
                  strong
                  divider
                  title="Theme"
                  hint="Follows your system unless you pick one."
                  control={
                    <Segmented
                      label="Theme"
                      value={settings.theme}
                      onChange={(theme) => update({ theme })}
                      options={[
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                        { value: 'system', label: 'System' },
                      ]}
                    />
                  }
                />
                <Group label='When I "Save all"' />
                <Row
                  tight
                  title="Keep pinned tabs open"
                  control={<Switch label="Keep pinned tabs open" checked={settings.keepPinnedOpen} onChange={(v) => update({ keepPinnedOpen: v })} />}
                />
                <Row
                  tight
                  title="Include every window"
                  hint="Off: only the window you're in."
                  control={<Switch label="Include every window" checked={settings.includeAllWindows} onChange={(v) => update({ includeAllWindows: v })} />}
                />
                <Row
                  tight
                  title="Skip new tab and blank pages"
                  control={<Switch label="Skip new tab and blank pages" checked={settings.skipBlankPages} onChange={(v) => update({ skipBlankPages: v })} />}
                />
                <Row
                  tight
                  title="Warn before closing tabs playing audio"
                  hint={<span className="text-meta">Asks whether to keep them open. Tabfold can't see unsaved form text, so save typed work first.</span>}
                  control={
                    <Switch
                      label="Warn before closing tabs playing audio"
                      checked={settings.warnAudioBeforeClose}
                      onChange={(v) => update({ warnAudioBeforeClose: v })}
                    />
                  }
                />
                <div className="border-b border-border pb-1">
                  <Row
                    tight
                    title="Tabs that are already saved"
                    hint={<span className="text-meta">Skip them, save them again, or ask each time.</span>}
                    control={
                      <Segmented
                        label="Tabs that are already saved"
                        value={settings.duplicates}
                        onChange={(duplicates) => update({ duplicates })}
                        options={[
                          { value: 'skip', label: 'Skip', title: 'Not saved again; they still close and stay saved where they are' },
                          { value: 'keep', label: 'Keep both', title: 'Saved again in the new session' },
                          { value: 'ask', label: 'Ask', title: 'The popup asks each time' },
                        ]}
                      />
                    }
                  />
                </div>
                <Group label="Restoring" />
                <Row
                  tight
                  align="start"
                  title="After restoring a session"
                  control={
                    <RadioGroup
                      label="After restoring a session"
                      value={settings.afterRestore}
                      onChange={(afterRestore) => update({ afterRestore })}
                      options={[
                        { value: 'keep', label: 'Keep it in the library' },
                        { value: 'trash', label: 'Move it to Trash' },
                      ]}
                    />
                  }
                />
                <div className="border-b border-border pb-1">
                  <Row
                    tight
                    title="Lazy restore"
                    hint="Tabs open unloaded and load when you click them, so restoring 200 tabs won't spike memory."
                    control={<Switch label="Lazy restore" checked={settings.lazyRestore} onChange={(v) => update({ lazyRestore: v })} />}
                  />
                </div>
                <Group label="Keywords" />
                <Row
                  tight
                  title="Suggest keywords from each tab's title and address"
                  hint="Worked out on this device. The page itself is never read."
                  control={<Switch label="Suggest keywords" checked={settings.suggestKeywords} onChange={(v) => update({ suggestKeywords: v })} />}
                />
                <div className="pb-1">
                  <Row
                    tight
                    title="Ask for keywords when I save a single tab"
                    hint="Off: the tab saves straight away; add keywords later in the library."
                    control={
                      <Switch
                        label="Ask for keywords when saving a single tab"
                        checked={settings.askKeywordsOnSingleSave}
                        onChange={(v) => update({ askKeywordsOnSingleSave: v })}
                      />
                    }
                  />
                </div>
              </Card>
            </Section>

            <Section id="memory" title="Memory">
              <Card>
                <Row
                  strong
                  divider
                  title="Suspend inactive tabs automatically"
                  hint="Uses Chrome's own tab discarding. The tab stays in its place with its real address."
                  control={
                    <div className="flex items-center gap-4">
                      <Select
                        label="Suspend after"
                        value={settings.autoSuspendMinutes}
                        onChange={(autoSuspendMinutes) => update({ autoSuspendMinutes })}
                        options={AUTO_SUSPEND_CHOICES.map((m) => ({
                          value: m,
                          label: m < 60 ? `After ${m} minutes` : `After ${m / 60} ${m === 60 ? 'hour' : 'hours'}`,
                        }))}
                      />
                      <Switch label="Suspend inactive tabs automatically" checked={settings.autoSuspend} onChange={(v) => update({ autoSuspend: v })} />
                    </div>
                  }
                />
                <Group label="Never suspend" />
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-2.5 px-4 pt-2 pb-3.5">
                  <Checkbox checked={settings.neverSuspendPinned} onChange={(v) => update({ neverSuspendPinned: v })}>
                    Pinned tabs
                  </Checkbox>
                  <Checkbox checked={settings.neverSuspendAudible} onChange={(v) => update({ neverSuspendAudible: v })}>
                    Tabs playing audio
                  </Checkbox>
                  <Checkbox checked disabled onChange={() => undefined}>
                    The tab you're looking at · always
                  </Checkbox>
                </div>
                <DomainList domains={settings.neverSuspendDomains} onChange={(neverSuspendDomains) => update({ neverSuspendDomains })} />
                <p className="flex items-center gap-2.5 rounded-b-card border-t border-border bg-bg-subtle px-4 py-3 text-small text-text-2">
                  <Info size={16} aria-hidden className="shrink-0 text-text-3" />
                  Chrome's Memory Saver is also on. We work alongside it and never fight over the same tabs.
                </p>
              </Card>
              <div className="flex flex-wrap items-center gap-3 rounded-card border border-dashed border-border-strong px-4 py-3.5">
                <div className="min-w-[240px] flex-1">
                  <div className="flex items-center gap-1.5 font-semibold">
                    Rules
                    <ProLock />
                  </div>
                  <div className="text-small text-text-3">"Always suspend YouTube after 10 min" · "Save all tabs every evening at 18:00"</div>
                </div>
                <button type="button" onClick={() => showProInfo('Rules')} className="font-semibold text-accent-text hover:underline">
                  See Pro
                </button>
              </div>
            </Section>

            <Section
              id="shortcuts"
              title="Shortcuts"
              aside={
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    openShortcutsPage();
                  }}
                  className="inline-flex items-center gap-1.5 font-semibold no-underline hover:underline"
                >
                  Change in Chrome
                  <ExternalLink size={14} strokeWidth={2} aria-hidden />
                </a>
              }
            >
              <Card>
                {COMMANDS.map((command) => {
                  const shortcut = shortcuts[command.name];
                  return (
                    <KeyRow
                      key={command.name}
                      label={command.long}
                      keys={shortcut ? <SettingsKey>{spaced(shortcut)}</SettingsKey> : <span className="text-small text-text-3">Not set</span>}
                    />
                  );
                })}
                <KeyRow label="Focus search" keys={<SettingsKey>/</SettingsKey>} />
                <KeyRow
                  label="Move · open · remove"
                  keys={
                    <>
                      <SettingsKey>↑ ↓</SettingsKey>
                      <SettingsKey>↵</SettingsKey>
                      <SettingsKey>{isMac ? '⌫' : 'Delete'}</SettingsKey>
                    </>
                  }
                />
                <KeyRow label="Undo" keys={<SettingsKey>{isMac ? '⌘ Z' : combo('Ctrl', 'Z')}</SettingsKey>} last />
              </Card>
            </Section>

            <Section id="data" title="Data & privacy">
              <Card>
                <Row
                  strong
                  divider
                  title="Import"
                  hint="Bad lines are skipped and counted, never fatal."
                  control={
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => openImportDialog('onetab')}>
                        OneTab
                      </Button>
                      <Button size="sm" onClick={() => openImportDialog('session-buddy')}>
                        Session Buddy
                      </Button>
                      <Button size="sm" onClick={() => openImportDialog('bookmarks')}>
                        Bookmarks
                      </Button>
                    </div>
                  }
                />
                <Row
                  strong
                  divider
                  title="Export everything"
                  hint="UTF-8, so emoji and every language come through intact."
                  control={
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" className="font-semibold" icon={<Download size={14} aria-hidden />} onClick={() => exportSessions()}>
                        HTML
                      </Button>
                      <button
                        type="button"
                        onClick={() => showProInfo(PRO_EXPORT_FEATURE)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-control border border-dashed border-border-strong px-3 text-text-3 hover:bg-hover"
                      >
                        JSON · Markdown · CSV
                        <ProLock />
                      </button>
                    </div>
                  }
                />
                <Row
                  strong
                  divider
                  title="Monthly backup reminder"
                  hint="Chrome deletes extension data if you uninstall. A file backup keeps your sessions safe."
                  control={<Switch label="Monthly backup reminder" checked={settings.backupReminder} onChange={(v) => update({ backupReminder: v })} />}
                />
                <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4 border-b border-border p-4">
                  <div>
                    <div className="flex items-center gap-1.5 font-semibold">
                      <Check size={14} strokeWidth={2} aria-hidden className="text-green" />
                      What we store
                    </div>
                    <p className="mt-1 text-small text-text-2">Addresses, titles, favicon links, pinned state, tab groups and window layout.</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 font-semibold">
                      <Laptop size={14} aria-hidden className="text-text-2" />
                      Where
                    </div>
                    <p className="mt-1 text-small text-text-2">On this device. In your private cloud backup only if you sign in to Pro.</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 font-semibold">
                      <X size={14} strokeWidth={2} aria-hidden className="text-red" />
                      Never
                    </div>
                    <p className="mt-1 text-small text-text-2">Page content, form data or browsing history. We have no access to web pages at all.</p>
                  </div>
                </div>
                <Row
                  strong
                  title={<span className="text-red">Clear all data</span>}
                  hint="Deletes every session, snapshot and setting on this device. We'll ask you to confirm."
                  control={
                    <Button size="sm" variant="danger-soft" onClick={openClearDataDialog}>
                      Clear all data…
                    </Button>
                  }
                />
              </Card>
            </Section>

            <Section id="plan" title="Plan & billing">
              <Card className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
                <PlanBadge plan={CURRENT_PLAN} />
                <div className="min-w-[220px] flex-1">
                  <div className="font-semibold">Free stays genuinely useful.</div>
                  <div className="text-small text-text-3">
                    Unlimited saved tabs · {named} of {limits.namedSessions} sessions · {tags.length} of {limits.tags} tags
                  </div>
                </div>
                <Button size="sm" variant="primary" onClick={() => showProInfo()}>
                  Compare plans
                </Button>
              </Card>
            </Section>
          </div>
        </main>
      </div>
    </div>
  );
}
