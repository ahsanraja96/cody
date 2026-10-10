import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Shield } from 'lucide-react';
import { suggestKeywords } from '@/lib/keywords';
import { send, type DuplicateTab } from '@/lib/messages';
import { keywordVocabulary, listRecentSessions } from '@/lib/repo';
import { displayHost, displayUrl } from '@/lib/urls';
import { Banner } from '@/ui/components/Banner';
import { Button, IconButton } from '@/ui/components/Button';
import { Select } from '@/ui/components/Controls';
import { Favicon } from '@/ui/components/Favicon';
import { KeywordEditor } from '@/ui/components/KeywordEditor';
import { Kbd } from '@/ui/components/Chips';
import { Checkbox } from '@/ui/components/Controls';
import { useCommandShortcut, useSettings, type OpenWindow } from '@/ui/hooks';

const NEW_SESSION = '__new__';
const LAST_TARGET_KEY = 'lastKeywordTarget';

/** Save one or more tabs with keywords picked from their title and address, or typed. */
export function KeywordSave({
  tabIds,
  windows,
  onBack,
}: {
  tabIds: number[];
  windows: OpenWindow[];
  onBack: () => void;
}) {
  const [settings, updateSettings] = useSettings();
  const tabs = useMemo(
    () => windows.flatMap((w) => w.tabs).filter((t) => t.id !== undefined && tabIds.includes(t.id)),
    [windows, tabIds],
  );
  const [keywords, setKeywords] = useState<string[]>([]);
  const [target, setTarget] = useState<string>(NEW_SESSION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ close: boolean; duplicates: DuplicateTab[]; total: number } | null>(null);
  const [always, setAlways] = useState(false);
  const shortcut = useCommandShortcut('save-tab');
  const vocabulary = useLiveQuery(() => keywordVocabulary(16), []) ?? [];
  const sessions = useLiveQuery(() => listRecentSessions(12), []) ?? [];

  useEffect(() => {
    browser.storage.local.get(LAST_TARGET_KEY).then((r) => {
      const id = r[LAST_TARGET_KEY] as string | undefined;
      if (id) setTarget(id);
    });
  }, []);
  const targetValid = target === NEW_SESSION || sessions.some((s) => s.id === target);

  const suggestions = useMemo(() => {
    if (!settings.suggestKeywords) return [];
    const merged: string[] = [];
    for (const tab of tabs.slice(0, 5)) {
      for (const s of suggestKeywords(tab.title ?? '', tab.url || tab.pendingUrl || '', { limit: tabs.length > 1 ? 3 : 6 })) {
        if (!merged.includes(s)) merged.push(s);
      }
    }
    return merged.slice(0, 8);
  }, [tabs, settings.suggestKeywords]);

  const save = async (close: boolean, duplicates?: 'skip' | 'keep') => {
    setBusy(true);
    setError(null);
    setAsk(null);
    try {
      const chosen = targetValid ? target : NEW_SESSION;
      const targetSessionId = chosen === NEW_SESSION ? null : chosen;
      await browser.storage.local.set({ [LAST_TARGET_KEY]: chosen });
      const ids = tabs.map((t) => t.id!);
      // "Ask": tabs already saved get an inline question before anything is written or closed.
      if (!duplicates && settings.duplicates === 'ask') {
        const preflight = await send({ type: 'preflight-save', scope: 'tabs', tabIds: ids, targetSessionId });
        if (preflight.duplicates.length > 0) {
          setAsk({ close, duplicates: preflight.duplicates, total: ids.length });
          setBusy(false);
          return;
        }
      }
      const outcome = await send({
        type: 'save',
        scope: 'tabs',
        tabIds: ids,
        close,
        keywordsByTabId: Object.fromEntries(ids.map((id) => [id, keywords])),
        targetSessionId,
        duplicates,
      });
      const name = outcome.sessionName || 'a new session';
      setDone(
        outcome.savedTabs === 0 && outcome.skippedDuplicates > 0
          ? `Already in ${name}. Keywords added.`
          : `Saved to ${name}${keywords.length ? ` with ${keywords.length} keyword${keywords.length === 1 ? '' : 's'}` : ''}.`,
      );
      setTimeout(() => (close || document.documentElement.dataset.mode === 'window' ? window.close() : onBack()), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Saving failed. Nothing was closed.');
      setBusy(false);
    }
  };

  const title = tabs.length > 1 ? `Save ${tabs.length} tabs` : 'Save this tab';

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-border pr-3 pl-2">
        <IconButton label="Back" size="lg" onClick={onBack}>
          <ChevronLeft size={18} aria-hidden />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate text-section font-semibold">{title}</h1>
        {tabs.length === 1 && shortcut && (
          <span className="flex shrink-0 items-center gap-1.5 text-meta text-text-3 max-[360px]:hidden">
            <Kbd>{shortcut}</Kbd> from any tab
          </span>
        )}
      </header>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-3.5 pb-4">
        {tabs.length === 0 ? (
          <Banner tone="neutral">That tab is no longer open.</Banner>
        ) : (
          <div className="flex flex-col gap-2 rounded-card border border-border bg-bg-subtle p-3">
            {tabs.slice(0, 3).map((tab) => (
              <div key={tab.id} className="flex gap-3">
                <Favicon url={tab.url || tab.pendingUrl || ''} size={20} className="mt-px" />
                <div className="min-w-0 flex-1">
                  <div className={tabs.length > 1 ? 'truncate font-semibold' : 'line-clamp-2 font-semibold'}>
                    {tab.title || displayHost(tab.url || tab.pendingUrl || '')}
                  </div>
                  <div className="truncate text-meta text-text-3">{displayUrl(tab.url || tab.pendingUrl || '')}</div>
                </div>
              </div>
            ))}
            {tabs.length > 3 && <div className="text-meta text-text-3">and {tabs.length - 3} more</div>}
          </div>
        )}

        {tabs.length > 0 && (
          <>
            <KeywordEditor
              value={keywords}
              onChange={setKeywords}
              suggestions={suggestions}
              vocabulary={vocabulary}
              autoFocus
              onSubmit={() => save(true)}
            />
            <div className="flex items-center gap-2.5">
              <span className="text-small text-text-2">Save to</span>
              <Select
                label="Save to"
                className="min-w-0 flex-1"
                value={targetValid ? target : NEW_SESSION}
                onChange={setTarget}
                options={[
                  { value: NEW_SESSION, label: 'A new session' },
                  ...sessions.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </div>
            <p className="flex gap-1.5 text-meta text-text-3">
              <Shield size={13} aria-hidden className="mt-px shrink-0" />
              Suggestions come from the title and address only. Tabfold never reads the page.
            </p>
          </>
        )}
        {ask && (
          <DuplicatesPrompt
            ask={ask}
            sessionName={sessions.find((s) => s.id === target)?.name}
            always={always}
            onAlways={setAlways}
            onAnswer={(choice) => {
              if (always) updateSettings({ duplicates: choice });
              save(ask.close, choice);
            }}
            onCancel={() => setAsk(null)}
          />
        )}
        {error && <Banner tone="error" role="alert">{error}</Banner>}
        {done && <Banner tone="success" role="status">{done}</Banner>}
      </div>

      {tabs.length > 0 && (
        <footer className="grid shrink-0 grid-cols-2 gap-2 border-t border-border bg-bg-subtle p-3">
          <Button size="md" className="h-[38px]" disabled={busy || !!ask} onClick={() => save(false)}>
            Save, keep open
          </Button>
          <Button size="md" variant="primary" className="h-[38px]" disabled={busy || !!ask} onClick={() => save(true)}>
            Save &amp; close {tabs.length > 1 ? 'tabs' : 'tab'}
          </Button>
        </footer>
      )}
    </div>
  );
}

/** "2 of 5 tabs are already in Checkout app": skip them (keywords still land there) or keep both. */
function DuplicatesPrompt({
  ask,
  sessionName,
  always,
  onAlways,
  onAnswer,
  onCancel,
}: {
  ask: { duplicates: DuplicateTab[]; total: number };
  sessionName?: string;
  always: boolean;
  onAlways: (value: boolean) => void;
  onAnswer: (choice: 'skip' | 'keep') => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ block: 'end' }), []);
  const dups = ask.duplicates;
  const places = [...new Set(dups.map((d) => d.sessionName))];
  const where = places.length === 1 ? places[0] : sessionName;
  const first = dups[0]?.title || displayHost(dups[0]?.url ?? '');
  const title =
    ask.total === 1
      ? `This tab is already ${where ? `in ${where}` : 'saved'}`
      : `${dups.length} of ${ask.total} tabs are already ${where ? `in ${where}` : 'saved'}`;
  const detail =
    dups.length === 1
      ? `${first} is saved ${places.length === 1 ? 'there' : `in ${places[0]}`}. Skipping it still adds your keywords to it.`
      : `${first} and ${dups.length - 1} more are saved ${places.length === 1 ? 'there' : 'already'}.`;
  return (
    <div ref={ref} role="alert" className="flex shrink-0 flex-col gap-3 rounded-card border border-border-strong bg-bg-subtle p-3.5">
      <div>
        <div dir="auto" className="font-semibold">
          {title}
        </div>
        <div dir="auto" className="text-text-2">
          {detail}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" autoFocus onClick={() => onAnswer('skip')}>
          {dups.length === 1 ? 'Skip it' : `Skip those ${dups.length}`}
        </Button>
        <Button size="sm" onClick={() => onAnswer('keep')}>
          Keep both
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <span className="text-small text-text-2">
        <Checkbox checked={always} onChange={onAlways}>
          Always do this (changes the setting)
        </Checkbox>
      </span>
    </div>
  );
}
