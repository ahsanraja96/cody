import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { resetGroupsFlagCache } from '@/lib/background/browserState';
import { handleFold } from '@/lib/background/fold';
import { MENU, onCommand, onMenuClicked } from '@/lib/background/menus';
import { countFoldedTabs, freeLimitsApply, listFullError, tabsToAdd } from '@/lib/background/room';
import { route } from '@/lib/background/router';
import { handleSave, handleUndo } from '@/lib/background/save';
import { resetTitleCache } from '@/lib/background/titles';
import { db } from '@/lib/db';
import { CommandError } from '@/lib/messages';
import { planState } from '@/lib/pro/state';
import { FREE_PLAN } from '@/lib/pro/types';
import { saveCapture } from '@/lib/repo';
import { activeFold, lastAction } from '@/lib/state';
import type { FolderRecord, SessionRecord } from '@/lib/types';
import { FakeChrome } from './chrome';
import { capturedWindow } from './fixtures';

vi.mock('@/lib/background/browserState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/background/browserState')>()),
  sleep: async () => undefined,
}));

let chrome: FakeChrome;

beforeEach(() => {
  chrome = new FakeChrome().install();
  resetTitleCache();
  resetGroupsFlagCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seed(name: string, urls: string[]) {
  return saveCapture([capturedWindow(urls)], { name, source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: false });
}

/** The list already holds this many tabs (a fold's count; its rows don't matter for the limit). */
async function fillList(tabs: number): Promise<void> {
  const now = Date.now() - 60_000;
  const session: SessionRecord = {
    id: `filler-${tabs}`,
    name: 'Old fold',
    tags: [],
    pinned: 0,
    color: null,
    kind: 'session',
    source: 'save-all',
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    deviceId: 'd',
    version: 1,
    tabCount: tabs,
    windowCount: 1,
    preview: [],
  };
  await db.sessions.add(session);
}

async function folder(id = 'clientsites1', name = 'Client sites'): Promise<FolderRecord> {
  const record: FolderRecord = { id, name, color: 'green', order: 0, createdAt: 1, updatedAt: 1, deletedAt: 0 };
  await db.folders.add(record);
  return record;
}

const urls = (n: number, prefix = 'site') => Array.from({ length: n }, (_, i) => `https://${prefix}${i}.com`);

async function failure(run: () => Promise<unknown>): Promise<CommandError> {
  try {
    await run();
  } catch (error) {
    return error as CommandError;
  }
  throw new Error('expected a failure');
}

describe('fold with options', () => {
  it('folds only the picked tabs, pinned or playing too, into a folder; Undo brings them back', async () => {
    const f = await folder();
    const { tabIds } = chrome.openWindow(
      ['https://a.com', { url: 'https://pinned.com', pinned: true }, { url: 'https://music.com', audible: true }, 'https://d.com'],
      { focused: true },
    );
    const outcome = await handleFold({ tabIds: [tabIds[1]!, tabIds[2]!], intoFolderId: f.id });
    expect(outcome).toMatchObject({ savedTabs: 2, closedTabs: 2, skippedDuplicates: 0 });
    expect(chrome.webTabs().map((t) => t.url)).toEqual(['https://a.com', 'https://d.com']);
    const saved = await db.tabs.toArray();
    expect(saved.map((t) => [t.url, t.folderId]).sort()).toEqual([
      ['https://music.com', f.id],
      ['https://pinned.com', f.id],
    ]);
    // A person's fold shows its progress like any other.
    expect((await activeFold.get())?.phase).toBe('done');

    expect(await handleUndo(outcome.actionId!)).toEqual({ undone: true });
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://a.com', 'https://d.com', 'https://music.com', 'https://pinned.com']);
    expect(await db.tabs.count()).toBe(0);
  });

  it('a tab already folded closes and its copy moves into the folder; Undo moves it back', async () => {
    const f = await folder();
    await seed('Earlier', ['https://a.com']);
    const { tabIds } = chrome.openWindow(['https://a.com/', 'https://b.com'], { focused: true });
    const outcome = await route({ type: 'fold', tabIds: [tabIds[0]!], intoFolderId: f.id });
    expect(outcome).toMatchObject({ ok: true, data: { savedTabs: 0, skippedDuplicates: 1, closedTabs: 1 } });
    const copy = (await db.tabs.where('url').equals('https://a.com').first())!;
    expect(copy.folderId).toBe(f.id);

    const actionId = (outcome as { data: { actionId: string } }).data.actionId;
    expect((await lastAction.get())?.patches).toEqual([{ id: copy.id, before: { folderId: undefined, snoozeUntil: undefined, snoozedOn: undefined } }]);
    await handleUndo(actionId);
    expect((await db.tabs.get(copy.id))!.folderId).toBeUndefined();
    expect(chrome.webTabs().map((t) => t.url).sort()).toEqual(['https://a.com/', 'https://b.com']);
  });

  it('a deleted folder leaves the tabs by kind of site', async () => {
    await db.folders.add({ id: 'gonefolder01', name: 'Gone', color: 'red', order: 0, createdAt: 1, updatedAt: 2, deletedAt: 2 });
    const { tabIds } = chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    await handleFold({ tabIds: [tabIds[0]!], intoFolderId: 'gonefolder01' });
    expect((await db.tabs.toArray()).map((t) => t.folderId)).toEqual([undefined]);
  });

  it('a rule folds quietly: no progress for the popup, still Undo-able', async () => {
    const { tabIds } = chrome.openWindow(['https://a.com', 'https://b.com'], { focused: true });
    const outcome = await handleFold({ tabIds: [tabIds[0]!], source: 'rule' });
    expect(outcome.savedTabs).toBe(1);
    expect(await activeFold.get()).toBeUndefined();
    expect(chrome.events('fold-progress')).toEqual([]);
    expect((await lastAction.get())?.id).toBe(outcome.actionId);
  });
});

describe('the free list’s 500 tabs', () => {
  it('counts every live fold’s tabs, and what a fold would add (not tabs already folded, nor repeats)', async () => {
    await fillList(10);
    await seed('Earlier', ['https://dup.com']);
    expect(await countFoldedTabs()).toBe(11);
    const window = capturedWindow(['https://dup.com/', 'https://new.com', 'https://new.com']);
    expect(await tabsToAdd([window], true)).toBe(1);
    expect(await tabsToAdd([window], false)).toBe(3);
    // An Incognito copy and a normal one are different tabs.
    expect(await tabsToAdd([capturedWindow(['https://dup.com'], { incognito: true })], true)).toBe(1);
  });

  it('a fold that fits exactly goes ahead; the next one is refused before anything closes', async () => {
    await fillList(497);
    chrome.openWindow(urls(3), { focused: true });
    expect((await handleFold()).savedTabs).toBe(3);
    expect(await countFoldedTabs()).toBe(500);

    const { tabIds } = chrome.openWindow(['https://one-more.com'], { focused: true });
    const error = await failure(() => handleFold());
    expect(error).toBeInstanceOf(CommandError);
    expect(error.code).toBe('list-full');
    expect(error.message).toBe('Your free list is full (500 tabs). Make room or upgrade for unlimited.');
    expect(error.details).toEqual({ room: 0, needed: 1, limit: 500 });
    expect(chrome.tab(tabIds[0]!)).toBeDefined();
    expect(await countFoldedTabs()).toBe(500);
    // A popup opened later shows why.
    expect(await activeFold.get()).toMatchObject({ phase: 'failed', code: 'list-full', details: { room: 0, needed: 1, limit: 500 } });
  });

  it('one over: "This fold needs room for 21 tabs", and nothing is saved or closed (never half a window)', async () => {
    await fillList(480);
    chrome.openWindow(urls(21), { focused: true });
    const response = await route({ type: 'fold' });
    expect(response).toEqual({
      ok: false,
      error: 'This fold needs room for 21 tabs; your free list has room for 20.',
      code: 'list-full',
      details: { room: 20, needed: 21, limit: 500 },
    });
    expect(chrome.webTabs()).toHaveLength(21);
    expect(await db.tabs.count()).toBe(0);
  });

  it('tabs already folded don’t count: they close without needing room', async () => {
    await fillList(498);
    await seed('Earlier', ['https://dup.com']);
    chrome.openWindow(['https://dup.com', 'https://new.com', 'https://new.com/'], { focused: true });
    const outcome = await handleFold();
    expect(outcome).toMatchObject({ savedTabs: 1, skippedDuplicates: 2 });
    expect(chrome.webTabs()).toHaveLength(0);
    expect(await countFoldedTabs()).toBe(500);
  });

  it('paid plans have no limit (Pro, Pro for life, a team)', async () => {
    await fillList(500);
    for (const plan of [
      { ...FREE_PLAN, tier: 'pro' as const },
      { ...FREE_PLAN, tier: 'pro' as const, lifetime: true },
      { ...FREE_PLAN, tier: 'pro-ai' as const, team: { id: 't', name: 'Truewidgets', role: 'member' as const, seats: 3 } },
    ]) {
      await planState.set(plan);
      expect(freeLimitsApply(plan)).toBe(false);
      chrome.openWindow(urls(2, `p${plan.tier}${plan.lifetime ? 'l' : ''}${plan.team ? 't' : ''}`), { focused: true });
      expect((await handleFold()).savedTabs).toBe(2);
    }
    expect(freeLimitsApply(FREE_PLAN)).toBe(true);
  });

  it('"Fold this tab" and saves are limited too; duplicates skipped don’t count', async () => {
    await fillList(499);
    await seed('Earlier', ['https://dup.com']);
    const { tabIds } = chrome.openWindow(['https://dup.com', 'https://new.com', 'https://other.com'], { focused: true });
    // Already folded: closes, needs no room.
    await handleSave({ type: 'save', scope: 'tabs', tabIds: [tabIds[0]!], close: true, duplicates: 'skip' });
    expect(chrome.tab(tabIds[0]!)).toBeUndefined();
    const error = await failure(() => handleSave({ type: 'save', scope: 'tabs', tabIds: [tabIds[1]!], close: true, duplicates: 'skip' }));
    expect(error.code).toBe('list-full');
    expect(chrome.tab(tabIds[1]!)).toBeDefined();
    expect(listFullError(5, 9).message).toBe('This fold needs room for 9 tabs; your free list has room for 5.');
  });

  it('the shortcut and the right-click menu tell open pages and open the popup on the card', async () => {
    await fillList(500);
    const openPopup = vi.spyOn(fakeBrowser.action, 'openPopup').mockResolvedValue(undefined as never);
    const { tabIds } = chrome.openWindow([{ url: 'https://a.com', active: true }, 'https://b.com'], { focused: true });

    await onCommand('fold');
    expect(chrome.events('limit-hit')).toEqual([{ type: 'limit-hit', code: 'list-full' }]);
    expect(openPopup).toHaveBeenCalledTimes(1);

    await onMenuClicked({ menuItemId: MENU.foldTab } as never, await fakeBrowser.tabs.get(tabIds[1]!));
    await onCommand('save-tab');
    expect(chrome.events('limit-hit')).toHaveLength(3);
    expect(openPopup).toHaveBeenCalledTimes(3);
    expect(chrome.webTabs()).toHaveLength(2);

    // Chrome won't open the popup: a small window instead.
    openPopup.mockRejectedValue(new Error('no window'));
    await onCommand('fold');
    expect(chrome.createdWindows.at(-1)).toMatchObject({ type: 'popup', url: expect.stringContaining('/popup.html?mode=window') });
  });
});
