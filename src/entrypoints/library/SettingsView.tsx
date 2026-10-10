import { useEffect, useState, type ReactNode } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Download, ExternalLink, Shield, X } from 'lucide-react';
import { CURRENT_PLAN, limitsFor } from '@/lib/limits';
import { clearAllData, listLiveSessions, tagCounts } from '@/lib/repo';
import { AUTO_SUSPEND_CHOICES, DEFAULT_SETTINGS, normalizeDomain } from '@/lib/settings';
import { Button } from '@/ui/components/Button';
import { Checkbox, RadioGroup, Segmented, Select, Switch } from '@/ui/components/Controls';
import { Kbd, PlanBadge } from '@/ui/components/Chips';
import { confirmAction } from '@/ui/components/Dialog';
import { toast } from '@/ui/components/Toast';
import { ImportPanel } from '@/ui/ImportPanel';
import { useSettings } from '@/ui/hooks';
import { exportSessions } from './actions';

function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-section font-semibold">{title}</h2>
        {aside}
      </div>
      <div className="rounded-card border border-border bg-surface">{children}</div>
    </section>
  );
}

function Row({ title, hint, control, last }: { title: ReactNode; hint?: ReactNode; control: ReactNode; last?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${last ? '' : 'border-b border-border'}`}>
      <div className="min-w-[220px] flex-1">
        <div>{title}</div>
        {hint && <div className="text-small text-text-3">{hint}</div>}
      </div>
      {control}
    </div>
  );
}

function Group({ label }: { label: string }) {
  return <div className="px-4 pt-3.5 pb-1 label-caps">{label}</div>;
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
        className={`flex flex-wrap items-center gap-1.5 rounded-control border bg-surface p-1.5 ${error ? 'border-red' : 'border-border-strong focus-within:border-accent'}`}
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
              <X size={12} aria-hidden />
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

export function SettingsView({ section }: { section?: string }) {
  const [settings, update] = useSettings();
  const [commands, setCommands] = useState<Browser.commands.Command[]>([]);
  const sessions = useLiveQuery(() => listLiveSessions(), []) ?? [];
  const tags = useLiveQuery(() => tagCounts(), []) ?? [];
  const limits = limitsFor(CURRENT_PLAN);

  useEffect(() => {
    browser.commands.getAll().then(setCommands).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ block: 'start' });
  }, [section]);

  const named = sessions.filter((s) => s.kind !== 'unsorted').length;

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-bg-subtle">
      <div className="mx-auto flex max-w-[760px] flex-col gap-9 px-6 pt-6 pb-16">
        <div>
          <h1 className="text-page font-semibold">Settings</h1>
          <nav aria-label="Settings sections" className="mt-3 flex flex-wrap gap-1.5">
            {[
              ['general', 'General'],
              ['memory', 'Memory'],
              ['shortcuts', 'Shortcuts'],
              ['data', 'Data & privacy'],
              ['plan', 'Plan'],
            ].map(([id, label]) => (
              <a key={id} href={`#/settings/${id}`} className="rounded-full border border-border bg-surface px-3 py-1 text-small text-text-2 no-underline hover:bg-hover">
                {label}
              </a>
            ))}
          </nav>
        </div>

        <Section id="general" title="General">
          <Row
            title={<span className="font-semibold">Theme</span>}
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
            title="Keep pinned tabs open"
            control={<Switch label="Keep pinned tabs open" checked={settings.keepPinnedOpen} onChange={(v) => update({ keepPinnedOpen: v })} />}
            last
          />
          <Row
            title="Include every window"
            hint="Off: only the window you're in."
            control={<Switch label="Include every window" checked={settings.includeAllWindows} onChange={(v) => update({ includeAllWindows: v })} />}
            last
          />
          <Row
            title="Skip new tab and blank pages"
            control={<Switch label="Skip new tab and blank pages" checked={settings.skipBlankPages} onChange={(v) => update({ skipBlankPages: v })} />}
            last
          />
          <Row
            title="Same page already in the session"
            control={
              <Select
                label="Same page already in the session"
                value={settings.duplicates}
                onChange={(duplicates) => update({ duplicates })}
                options={[
                  { value: 'skip', label: 'Skip the duplicate' },
                  { value: 'keep', label: 'Keep both' },
                ]}
              />
            }
          />
          <Group label="Restoring" />
          <Row
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
            last
          />
          <Row
            title="Lazy restore"
            hint="Tabs open unloaded and load when you click them, so restoring 200 tabs won't spike memory."
            control={<Switch label="Lazy restore" checked={settings.lazyRestore} onChange={(v) => update({ lazyRestore: v })} />}
          />
          <Group label="Keywords" />
          <Row
            title="Suggest keywords from each tab's title and address"
            hint="Worked out on this device. The page itself is never read."
            control={<Switch label="Suggest keywords" checked={settings.suggestKeywords} onChange={(v) => update({ suggestKeywords: v })} />}
            last
          />
          <Row
            title="Ask for keywords when I save a single tab"
            hint="Off: the tab saves straight away; add keywords later in the library."
            control={
              <Switch
                label="Ask for keywords when saving a single tab"
                checked={settings.askKeywordsOnSingleSave}
                onChange={(v) => update({ askKeywordsOnSingleSave: v })}
              />
            }
            last
          />
        </Section>

        <Section id="memory" title="Memory">
          <Row
            title={<span className="font-semibold">Suspend inactive tabs automatically</span>}
            hint="Uses Chrome's own tab discarding. The tab stays in its place with its real address."
            control={
              <div className="flex items-center gap-3">
                <Select
                  label="Suspend after"
                  value={settings.autoSuspendMinutes}
                  onChange={(autoSuspendMinutes) => update({ autoSuspendMinutes })}
                  options={AUTO_SUSPEND_CHOICES.map((m) => ({ value: m, label: m < 60 ? `After ${m} minutes` : `After ${m / 60} ${m === 60 ? 'hour' : 'hours'}` }))}
                />
                <Switch label="Suspend inactive tabs automatically" checked={settings.autoSuspend} onChange={(v) => update({ autoSuspend: v })} />
              </div>
            }
          />
          <Group label="Never suspend" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-2.5 px-4 pt-2 pb-4">
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
          <p className="flex gap-2 rounded-b-card border-t border-border bg-bg-subtle px-4 py-3 text-small text-text-2">
            Video-call sites are on the list by default. Tabfold can't see camera or microphone use without reading pages, so
            add any other call tools you use.
          </p>
        </Section>

        <Section
          id="shortcuts"
          title="Shortcuts"
          aside={
            <Button
              size="xs"
              variant="ghost"
              className="text-accent-text"
              trailing={<ExternalLink size={13} aria-hidden />}
              onClick={() => browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}
            >
              Change in Chrome
            </Button>
          }
        >
          {commands.map((command) => (
            <Row
              key={command.name}
              title={command.name === '_execute_action' ? 'Open Tabfold' : command.description}
              control={command.shortcut ? <Kbd className="h-[22px] px-2 text-small">{command.shortcut}</Kbd> : <span className="text-small text-text-3">Not set</span>}
            />
          ))}
          <Row title="Focus search" control={<Kbd className="h-[22px] px-2 text-small">/</Kbd>} />
          <Row
            title="Move · open · remove"
            control={
              <span className="flex gap-1">
                <Kbd className="h-[22px] px-2 text-small">↑ ↓</Kbd>
                <Kbd className="h-[22px] px-2 text-small">↵</Kbd>
                <Kbd className="h-[22px] px-2 text-small">Delete</Kbd>
              </span>
            }
            last
          />
        </Section>

        <Section id="data" title="Data & privacy">
          <div className="border-b border-border p-4">
            <div className="mb-3 font-semibold">Import</div>
            <ImportPanel />
          </div>
          <Row
            title={<span className="font-semibold">Export everything</span>}
            hint="An HTML page with every session and link. UTF-8, so emoji and every language survive. JSON, Markdown and CSV come with Pro."
            control={
              <Button size="sm" icon={<Download size={14} aria-hidden />} onClick={() => exportSessions()}>
                Export HTML
              </Button>
            }
          />
          <Row
            title={<span className="font-semibold">Monthly backup reminder</span>}
            hint="Chrome deletes extension data if Tabfold is removed. A file backup keeps your sessions safe."
            control={<Switch label="Monthly backup reminder" checked={settings.backupReminder} onChange={(v) => update({ backupReminder: v })} />}
          />
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4 border-b border-border p-4">
            <div>
              <div className="flex items-center gap-1.5 font-semibold">
                <Check size={14} aria-hidden className="text-green" />
                What we store
              </div>
              <p className="mt-1 text-small text-text-2">Addresses, titles, favicon links, keywords, pinned state, tab groups and window layout.</p>
            </div>
            <div>
              <div className="flex items-center gap-1.5 font-semibold">
                <Shield size={14} aria-hidden className="text-text-2" />
                Where
              </div>
              <p className="mt-1 text-small text-text-2">Only on this device, in your browser's own storage. Nothing is sent anywhere.</p>
            </div>
            <div>
              <div className="flex items-center gap-1.5 font-semibold">
                <X size={14} aria-hidden className="text-red" />
                Never
              </div>
              <p className="mt-1 text-small text-text-2">Page content, form data or browsing history. Tabfold has no access to web pages at all.</p>
            </div>
          </div>
          <Row
            title={<span className="font-semibold text-red">Clear all data</span>}
            hint="Deletes every session, snapshot and setting on this device."
            last
            control={
              <Button
                size="sm"
                variant="danger-soft"
                onClick={async () => {
                  const ok = await confirmAction({
                    title: 'Clear all Tabfold data?',
                    body: `This deletes ${sessions.length} sessions, every snapshot and your settings on this device. It can't be undone. Export first if you might want them back.`,
                    confirmLabel: 'Clear all data',
                    danger: true,
                  });
                  if (!ok) return;
                  await clearAllData();
                  await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
                  toast('All data cleared.');
                }}
              >
                Clear all data…
              </Button>
            }
          />
        </Section>

        <Section id="plan" title="Plan">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
            <PlanBadge plan={CURRENT_PLAN} />
            <div className="min-w-[220px] flex-1">
              <div className="font-semibold">Free stays genuinely useful.</div>
              <div className="text-small text-text-3">
                Unlimited saved tabs · {named} of {limits.namedSessions} sessions · {tags.length} of {limits.tags} tags
              </div>
            </div>
            <span className="text-small text-text-3">Pro with sync and cloud backup is on the way.</span>
          </div>
        </Section>
      </div>
    </div>
  );
}
