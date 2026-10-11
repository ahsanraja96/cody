import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { route } from '@/lib/background/router';
import { nextMondayMorning, onTidyAlarm, TIDY_ALARM } from '@/lib/background/tidy';
import { db } from '@/lib/db';
import { markOpened } from '@/lib/folders';
import type { Command, CommandResponse, CommandResults } from '@/lib/messages';
import { askScore, pickAskTabs, queryWords, readAskMatches, readTidyGroups } from '@/lib/pro/ai';
import { listFoldedTabs, saveCapture } from '@/lib/repo';
import { updateSettings } from '@/lib/settings';
import { tidyState } from '@/lib/state';
import type { TabRecord } from '@/lib/types';
import { FakeChrome } from './chrome';
import { capturedWindow } from './fixtures';
import { installPro, signedIn, type FakeServer } from './proServer';

const DAY = 24 * 60 * 60 * 1000;

let pro: ReturnType<typeof installPro>;
let server: FakeServer;

beforeEach(() => {
  pro = installPro();
  server = pro.server;
});

afterEach(() => {
  pro.restore();
  vi.restoreAllMocks();
});

async function send<C extends Command>(command: C): Promise<CommandResponse<CommandResults[C['type']]>> {
  return (await route(command)) as CommandResponse<CommandResults[C['type']]>;
}

async function ok<C extends Command>(command: C): Promise<CommandResults[C['type']]> {
  const response = await send(command);
  if (!response.ok) throw new Error(`${command.type}: ${response.code} ${response.error}`);
  return response.data;
}

async function fold(urls: string[], now: number, titles: Record<string, string> = {}, incognito = false) {
  const window = capturedWindow(urls, incognito ? { incognito: true } : {});
  for (const tab of window.tabs) if (titles[tab.url]) tab.title = titles[tab.url]!;
  return saveCapture([window], { source: 'save-all', deviceId: 'd', now }, { dedupe: false });
}

/** What the AI was sent (the fake server types only the 0.5 tasks). */
type Sent = { task: string; query?: string; tabs: Array<{ id: string; title: string; host: string }>; folders?: Array<{ id: string; name: string }> };
const sent = () => server.aiRequests.map((r) => r as unknown as Sent);

describe('Ask your tabs: what is sent', () => {
  function row(n: number, title: string, url: string, extra: Partial<TabRecord> = {}): TabRecord {
    return {
      id: `t${n}`,
      sessionId: 's',
      windowId: 'w',
      url,
      title,
      favIconUrl: '',
      pinned: false,
      groupName: null,
      groupColor: null,
      groupCollapsed: false,
      order: n,
      savedAt: 1000 * n,
      keywords: [],
      urlTruncated: false,
      ...extra,
    };
  }

  it('the question’s words, without the common ones', () => {
    expect(queryWords('The pricing page I looked at last week?')).toEqual(['pricing', 'page', 'looked']);
    expect(queryWords('Préços — München 2026')).toEqual(['préços', 'münchen', '2026']);
  });

  it('tabs whose title or site match come first (best first), then the newest fill up to the limit; never Incognito', () => {
    const tabs = [
      row(1, 'Pricing & fees | Stripe', 'https://stripe.com/pricing'),
      row(2, 'Plans', 'https://notion.so/pricing'),
      row(3, 'Unrelated', 'https://a.com'),
      row(4, 'Pricing page draft', 'https://docs.google.com/x'),
      row(5, 'Newest unrelated', 'https://b.com'),
      row(6, 'Pricing secret', 'https://secret.com', { incognito: true }),
    ];
    expect(askScore(tabs[0]!, ['pricing', 'stripe'])).toBe(2 + 2 + 1);
    const picked = pickAskTabs(tabs, 'pricing page', 4);
    expect(picked.map((t) => t.id)).toEqual(['t4', 't1', 't5', 't3']);
    expect(Object.keys(picked[0]!).sort()).toEqual(['host', 'id', 'title']);
    expect(pickAskTabs(tabs, 'zzz', 10).map((t) => t.id)).toEqual(['t5', 't4', 't3', 't2', 't1']);
  });

  it('keeps only matches for tabs that were sent, each once, at most 8, with short reasons', () => {
    const raw = [
      { id: 'a', reason: 'Folded 6 days ago · pricing page' },
      { id: 'a', reason: 'again' },
      { id: 'zzz', reason: 'not sent' },
      { id: 'b', reason: 'x'.repeat(200) },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, reason: '' })),
    ];
    const matches = readAskMatches(raw, ['a', 'b', ...Array.from({ length: 10 }, (_, i) => `n${i}`)]);
    expect(matches).toHaveLength(8);
    expect(matches[0]).toEqual({ tabRecordId: 'a', reason: 'Folded 6 days ago · pricing page' });
    expect(matches[1]!.reason).toHaveLength(80);
    expect(readAskMatches('nope', ['a'])).toEqual([]);
  });
});

describe('Ask your tabs', () => {
  it('needs Pro AI', async () => {
    await signedIn(server, 'pro');
    expect(await send({ type: 'ai-ask', query: 'pricing' })).toMatchObject({ ok: false, code: 'needs-pro-ai' });
  });

  it('sends the question with likely tabs (titles and sites only) and returns the matches', async () => {
    await signedIn(server, 'pro-ai');
    const now = Date.now();
    const saved = await fold(['https://stripe.com/pricing', 'https://example.com/'], now, { 'https://stripe.com/pricing': 'Pricing & fees | Stripe' });
    await fold(['https://secret.com/pricing'], now, {}, true);
    server.ai = () => ({ status: 200, body: { matches: [{ id: saved.savedTabIds[0], reason: 'Folded today · pricing page' }, { id: 'made-up', reason: '?' }] } });
    const result = await ok({ type: 'ai-ask', query: '  the pricing page I looked at  ' });
    expect(result).toEqual({ matches: [{ tabRecordId: saved.savedTabIds[0], reason: 'Folded today · pricing page' }] });
    const request = sent()[0]!;
    expect(request.task).toBe('ask');
    expect(request.query).toBe('the pricing page I looked at');
    expect(request.tabs.map((t) => t.id)).toEqual([saved.savedTabIds[0], saved.savedTabIds[1]]);
    expect(JSON.stringify(request)).not.toContain('secret');
    expect(await ok({ type: 'ai-ask', query: '   ' })).toEqual({ matches: [] });
  });
});

describe('the weekly tidy-up', () => {
  it('reads the AI’s groups: only tabs sent, an existing folder or a new name, the count matching', () => {
    const groups = readTidyGroups(
      [
        { summary: '38 tabs about Lisbon', folderId: 'f1', folderName: 'ignored', tabIds: ['a', 'b', 'c', 'zzz'] },
        { summary: 'Recipes', folderId: 'unknown', folderName: 'Recipes to try', tabIds: ['d', 'e', 'a'] },
        { summary: 'Too few', folderId: null, folderName: 'One', tabIds: ['f'] },
        { summary: 'No name', folderId: null, folderName: '', tabIds: ['g', 'h'] },
      ],
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      [{ id: 'f1', name: 'Holiday' }],
    );
    expect(groups).toEqual([
      { summary: '3 tabs about Lisbon', folderId: 'f1', folderName: 'Holiday', tabIds: ['a', 'b', 'c'] },
      { summary: '2 tabs about Recipes to try', folderId: null, folderName: 'Recipes to try', tabIds: ['d', 'e'] },
    ]);
  });

  it('suggests folding tabs nobody opened in a month and removing duplicates, and each is one click with Undo', async () => {
    await signedIn(server, 'pro-ai');
    const now = Date.now();
    const old = await fold(
      ['https://lisbon1.com', 'https://lisbon2.com', 'https://lisbon3.com', 'https://lisbon4.com', 'https://lisbon5.com', 'https://recipe1.com', 'https://recipe2.com'],
      now - 45 * DAY,
    );
    // Opened from Tabfold last week: not stale.
    await markOpened([old.savedTabIds[4]!], now - 7 * DAY);
    await fold(['https://dup.com', 'https://fresh.com'], now - 2 * DAY);
    await fold(['https://dup.com'], now - DAY);
    const holiday = (await ok({ type: 'folder-create', name: 'Holiday' })).folder;

    server.ai = (request) => {
      const r = request as unknown as Sent;
      if (r.task !== 'tidy') return { status: 400, body: {} };
      const ids = r.tabs.map((t) => t.id);
      return {
        status: 200,
        body: {
          suggestions: [
            { summary: '4 tabs about Lisbon', folderId: holiday.id, folderName: 'Holiday', tabIds: ids.filter((id) => old.savedTabIds.slice(0, 5).includes(id)) },
            { summary: '2 tabs about recipes', folderId: null, folderName: 'Recipes to try', tabIds: old.savedTabIds.slice(5) },
          ],
        },
      };
    };
    const state = await ok({ type: 'tidy-run' });
    const request = sent().find((r) => r.task === 'tidy')!;
    expect(request.tabs).toHaveLength(6);
    expect(request.folders).toEqual([{ id: holiday.id, name: 'Holiday' }]);
    expect(state.suggestions.map((s) => [s.id, s.kind, s.text, s.action])).toEqual([
      ['fold-1', 'fold-into', '4 tabs about Lisbon haven’t been opened in a month', 'Fold into Holiday'],
      ['fold-2', 'fold-into', '2 tabs about recipes haven’t been opened in a month', 'Make a folder ‘Recipes to try’'],
      ['duplicates', 'duplicates', '1 tab is the same page twice', 'Remove duplicates'],
    ]);
    expect(await tidyState.get()).toEqual(state);

    const into = await ok({ type: 'tidy-apply', suggestionId: 'fold-1' });
    expect(into.done).toBe(4);
    expect((await db.tabs.bulkGet(old.savedTabIds.slice(0, 4))).map((t) => t!.folderId)).toEqual(Array(4).fill(holiday.id));
    expect((await tidyState.get())!.suggestions.map((s) => s.id)).toEqual(['fold-2', 'duplicates']);
    await ok({ type: 'undo', actionId: into.actionId! });
    expect((await db.tabs.bulkGet(old.savedTabIds.slice(0, 4))).every((t) => !t!.folderId)).toBe(true);

    const made = await ok({ type: 'tidy-apply', suggestionId: 'fold-2' });
    const recipes = (await db.folders.where('deletedAt').equals(0).toArray()).find((f) => f.name === 'Recipes to try')!;
    expect(recipes.source).toBe('ai');
    expect((await db.tabs.get(old.savedTabIds[5]!))!.folderId).toBe(recipes.id);
    await ok({ type: 'undo', actionId: made.actionId! });
    expect((await db.folders.get(recipes.id))!.deletedAt).toBeGreaterThan(0);
    expect((await db.tabs.get(old.savedTabIds[5]!))!.folderId).toBeUndefined();

    const dups = await ok({ type: 'tidy-apply', suggestionId: 'duplicates' });
    expect(dups.done).toBe(1);
    expect((await listFoldedTabs()).filter((t) => t.url === 'https://dup.com')).toHaveLength(1);
    await ok({ type: 'undo', actionId: dups.actionId! });
    expect((await listFoldedTabs()).filter((t) => t.url === 'https://dup.com')).toHaveLength(2);

    expect(await send({ type: 'tidy-apply', suggestionId: 'duplicates' })).toMatchObject({ ok: false, code: 'not-found' });
    await ok({ type: 'tidy-dismiss' });
    expect((await tidyState.get())!.dismissedAt).toBeGreaterThan(0);
  });

  it('runs on Monday’s alarm only for Pro AI with the tidy-up on, once a week; an AI failure still leaves the duplicates', async () => {
    const now = Date.now();
    await fold(['https://dup.com'], now - 2 * DAY);
    await fold(['https://dup.com'], now - DAY);
    await onTidyAlarm(TIDY_ALARM, now);
    expect(await tidyState.get()).toBeUndefined();

    await signedIn(server, 'pro-ai');
    await updateSettings({ tidyUp: false });
    await onTidyAlarm(TIDY_ALARM, now);
    expect(await tidyState.get()).toBeUndefined();

    await updateSettings({ tidyUp: true });
    await fold(Array.from({ length: 6 }, (_, i) => `https://stale${i}.com`), now - 60 * DAY);
    server.ai = () => ({ status: 502, body: { error: 'ai-failed' } });
    await onTidyAlarm('some-other-alarm', now);
    expect(await tidyState.get()).toBeUndefined();
    await onTidyAlarm(TIDY_ALARM, now);
    expect((await tidyState.get())!.suggestions.map((s) => s.kind)).toEqual(['duplicates']);
    // A missed alarm that fires again at the next start doesn't run it twice in a week.
    await tidyState.set({ at: now, suggestions: [] });
    await onTidyAlarm(TIDY_ALARM, now + DAY);
    expect((await tidyState.get())!.suggestions).toEqual([]);
    // Asked for on the page, an AI failure is reported.
    expect(await send({ type: 'tidy-run' })).toMatchObject({ ok: false, code: 'ai-failed' });
  });

  it('next Monday at 9:00, local time', () => {
    const wednesday = new Date(2026, 9, 14, 15, 0).getTime();
    expect(new Date(nextMondayMorning(wednesday))).toEqual(new Date(2026, 9, 19, 9, 0));
    const mondayEarly = new Date(2026, 9, 19, 8, 0).getTime();
    expect(new Date(nextMondayMorning(mondayEarly))).toEqual(new Date(2026, 9, 19, 9, 0));
    const mondayLate = new Date(2026, 9, 19, 10, 0).getTime();
    expect(new Date(nextMondayMorning(mondayLate))).toEqual(new Date(2026, 9, 26, 9, 0));
  });
});

describe('opening a folded tab from Tabfold', () => {
  it('remembers when, for the tidy-up', async () => {
    const chrome = new FakeChrome().install();
    chrome.openWindow(['https://open.com'], { focused: true });
    const saved = await fold(['https://a.com', 'https://b.com'], Date.now() - 40 * DAY);
    expect((await ok({ type: 'open-saved-tab', tabRecordId: saved.savedTabIds[0]!, active: false })).opened).toBe(true);
    expect((await db.tabs.get(saved.savedTabIds[0]!))!.lastOpenedAt).toBeGreaterThan(Date.now() - 60_000);
    await ok({ type: 'open-tabs', tabRecordIds: [saved.savedTabIds[1]!] });
    expect((await db.tabs.get(saved.savedTabIds[1]!))!.lastOpenedAt).toBeGreaterThan(Date.now() - 60_000);
  });
});
