import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { route } from '@/lib/background/router';
import {
  fromShareSite,
  handleExternalMessage,
  onFoldsChanged,
  pushLiveShares,
  resetShareRuntime,
  SHARE_ALARM,
  SHARE_ORIGIN,
  SHARE_PUSH_DELAY_MS,
} from '@/lib/background/share';
import { db } from '@/lib/db';
import { PRO_CONFIG } from '@/lib/pro/config';
import { resetPlanRuntime } from '@/lib/pro/plan';
import { planState } from '@/lib/pro/state';
import { FREE_PLAN } from '@/lib/pro/types';
import { saveCapture } from '@/lib/repo';
import type { FolderRecord, SessionRecord } from '@/lib/types';
import { capturedWindow } from './fixtures';

const API = 'https://api.tabfold.test/functions/v1/tabfold';

interface StoredShare {
  name: string;
  color: string;
  note?: string;
  tabs: Array<{ title: string; url: string }>;
  live: boolean;
  views: number;
}

/** The server's shares (server/API.md "Share a folder"), as a fake fetch. */
class FakeShares {
  shares = new Map<string, StoredShare>();
  requests: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  next = 1;

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname.slice(new URL(API).pathname.length);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    this.requests.push({ method, path, auth: new Headers(init.headers).get('Authorization'), body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    const pub = path.match(/^\/public\/shares\/(\w+)$/);
    if (pub && method === 'GET') {
      const share = this.shares.get(pub[1]!);
      if (!share) return json(404, { error: 'server' });
      share.views += 1;
      return json(200, { name: share.name, color: share.color, note: share.note ?? '', tabs: share.tabs, updatedAt: 1 });
    }
    if (path === '/shares' && method === 'POST') {
      const id = `share${String(this.next++).padStart(5, '0')}`;
      this.shares.set(id, { ...body, views: 0 });
      return json(200, { id, url: `https://tabfold.truewidgets.com/s/${id}` });
    }
    const own = path.match(/^\/shares\/(\w+)$/);
    const share = own ? this.shares.get(own[1]!) : undefined;
    if (own && !share) return json(404, { error: 'server', message: 'No such share.' });
    if (own && method === 'PUT') {
      Object.assign(share!, body);
      return json(200, { id: own[1], url: `https://tabfold.truewidgets.com/s/${own[1]}`, views: share!.views, live: share!.live });
    }
    if (own && method === 'GET') return json(200, { id: own[1], url: `https://tabfold.truewidgets.com/s/${own[1]}`, views: share!.views, live: share!.live, updatedAt: 1 });
    if (own && method === 'DELETE') {
      this.shares.delete(own[1]!);
      return json(200, { ok: true });
    }
    return json(404, { error: 'server' });
  };

  count(method: string, prefix = '/shares') {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix)).length;
  }
}

let server: FakeShares;
const before = { ...PRO_CONFIG };

beforeEach(async () => {
  server = new FakeShares();
  PRO_CONFIG.apiUrl = API;
  vi.stubGlobal('fetch', server.fetch);
  resetPlanRuntime();
  resetShareRuntime();
  await planState.set({ ...FREE_PLAN, tier: 'pro', email: 'ada@example.com', status: 'active', checkedAt: Date.now() });
});

afterEach(() => {
  Object.assign(PRO_CONFIG, before);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPlanRuntime();
});

const FOLDER: FolderRecord = { id: 'clientsites1', name: 'Client sites', color: 'green', order: 0, createdAt: 1, updatedAt: 1, deletedAt: 0 };

async function folderWith(urls: string[], extra: { incognito?: boolean } = {}) {
  await db.folders.put(FOLDER);
  const window = capturedWindow(urls, extra.incognito ? { incognito: true } : {});
  const result = await saveCapture([window], { name: 'Fold', source: 'save-all', deviceId: 'd', now: Date.now() }, { dedupe: false });
  await db.tabs.where('id').anyOf(result.savedTabIds).modify({ folderId: FOLDER.id });
  return result;
}

describe('share a folder', () => {
  it('creates a link with the folder’s pages (never Incognito ones), updates it, says how many viewed it, and stops', async () => {
    await folderWith(['https://a.com', 'https://b.com']);
    await folderWith(['https://secret.com'], { incognito: true });
    const created = await route({ type: 'share-create', folderId: FOLDER.id, live: true });
    expect(created).toEqual({ ok: true, data: { url: 'https://tabfold.truewidgets.com/s/share00001', shareId: 'share00001' } });
    const post = server.requests.find((r) => r.method === 'POST')!;
    expect(post.auth).toMatch(/^Bearer /);
    expect(post.body).toEqual({
      name: 'Client sites',
      color: 'green',
      note: '',
      live: true,
      tabs: expect.arrayContaining([
        { title: 'Title of https://a.com', url: 'https://a.com' },
        { title: 'Title of https://b.com', url: 'https://b.com' },
      ]),
    });
    expect((post.body as { tabs: unknown[] }).tabs).toHaveLength(2);
    expect(await db.folders.get(FOLDER.id)).toMatchObject({ shareId: 'share00001', shareLive: true });

    server.shares.get('share00001')!.views = 4;
    expect(await route({ type: 'share-update', folderId: FOLDER.id, live: false })).toEqual({
      ok: true,
      data: { url: 'https://tabfold.truewidgets.com/s/share00001', views: 4, live: false },
    });
    expect((await db.folders.get(FOLDER.id))!.shareLive).toBe(false);
    expect(await route({ type: 'share-info', folderId: FOLDER.id })).toEqual({
      ok: true,
      data: { url: 'https://tabfold.truewidgets.com/s/share00001', views: 4, live: false },
    });

    // Sharing again keeps the same link.
    expect(await route({ type: 'share-create', folderId: FOLDER.id, live: true })).toMatchObject({ ok: true, data: { shareId: 'share00001' } });
    expect(server.count('POST')).toBe(1);

    expect(await route({ type: 'share-stop', folderId: FOLDER.id })).toEqual({ ok: true, data: { ok: true } });
    expect(server.shares.size).toBe(0);
    const folder = (await db.folders.get(FOLDER.id))!;
    expect('shareId' in folder || 'shareLive' in folder).toBe(false);
    expect(await route({ type: 'share-info', folderId: FOLDER.id })).toEqual({ ok: true, data: null });
  });

  it('a link stopped elsewhere is forgotten here', async () => {
    await folderWith(['https://a.com']);
    await route({ type: 'share-create', folderId: FOLDER.id, live: false });
    server.shares.clear();
    expect(await route({ type: 'share-info', folderId: FOLDER.id })).toEqual({ ok: true, data: null });
    expect((await db.folders.get(FOLDER.id))!.shareId).toBeUndefined();
  });

  it('is part of Pro; a plan that ended can still stop a link', async () => {
    await folderWith(['https://a.com']);
    await route({ type: 'share-create', folderId: FOLDER.id, live: false });
    await planState.set({ ...FREE_PLAN, checkedAt: Date.now() });
    // Reading the plan again (it says Free) before saying so.
    server.fetch = vi.fn(server.fetch) as never;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) =>
      String(input).endsWith('/me') ? new Response(JSON.stringify({ plan: { ...FREE_PLAN, checkedAt: Date.now() } }), { status: 200 }) : server.fetch(input, init),
    );
    expect(await route({ type: 'share-update', folderId: FOLDER.id })).toMatchObject({ ok: false, code: 'needs-pro' });
    expect(await route({ type: 'share-create', folderId: 'other', live: false })).toMatchObject({ ok: false, code: 'needs-pro' });
    expect(await route({ type: 'share-stop', folderId: FOLDER.id })).toEqual({ ok: true, data: { ok: true } });
  });
});

describe('"Keep it up to date"', () => {
  it('a change to a live share’s tabs sends it 30 seconds later, once, and only when it changed', async () => {
    const { savedTabIds } = await folderWith(['https://a.com', 'https://b.com']);
    await route({ type: 'share-create', folderId: FOLDER.id, live: true });
    const now = Date.now();
    await onFoldsChanged({ [`idb://tabfold/tabs/${savedTabIds[0]}`]: {} }, now);
    expect((await fakeBrowser.alarms.get(SHARE_ALARM))?.scheduledTime).toBe(now + SHARE_PUSH_DELAY_MS);
    // Another change moves it on (debounced).
    await onFoldsChanged({ [`idb://tabfold/tabs/${savedTabIds[1]}`]: {} }, now + 10_000);
    expect((await fakeBrowser.alarms.get(SHARE_ALARM))?.scheduledTime).toBe(now + 10_000 + SHARE_PUSH_DELAY_MS);

    // Nothing changed since it was sent: nothing goes.
    expect(await pushLiveShares()).toBe(0);
    await db.tabs.update(savedTabIds[0]!, { title: 'Renamed' });
    expect(await pushLiveShares()).toBe(1);
    expect(server.shares.get('share00001')!.tabs).toContainEqual({ title: 'Renamed', url: 'https://a.com' });
    expect(await pushLiveShares()).toBe(0);
    expect(server.count('PUT')).toBe(1);
  });

  it('a folder’s note goes with its share, and a live share sends a changed note (1.0)', async () => {
    await folderWith(['https://a.com']);
    await db.folders.update(FOLDER.id, { note: 'Waiting on the client', noteAt: Date.now() });
    await route({ type: 'share-create', folderId: FOLDER.id, live: true });
    expect(server.shares.get('share00001')!.note).toBe('Waiting on the client');
    expect(await pushLiveShares()).toBe(0);
    await route({ type: 'folder-update', id: FOLDER.id, note: 'Signed off' });
    expect(await pushLiveShares()).toBe(1);
    expect(server.shares.get('share00001')!.note).toBe('Signed off');
    await route({ type: 'folder-update', id: FOLDER.id, note: '' });
    expect(await pushLiveShares()).toBe(1);
    expect(server.shares.get('share00001')!.note).toBe('');
  });

  it('shares that don’t follow the folder, and other changes, set no alarm', async () => {
    await folderWith(['https://a.com']);
    await route({ type: 'share-create', folderId: FOLDER.id, live: false });
    await onFoldsChanged({ 'idb://tabfold/tabs/x': {} });
    await onFoldsChanged({ 'idb://tabfold/meta/searchVersion': {} });
    expect(await fakeBrowser.alarms.get(SHARE_ALARM)).toBeUndefined();
  });
});

describe('"Save to my Tabfold" from a shared page', () => {
  const site = { origin: SHARE_ORIGIN, url: `${SHARE_ORIGIN}/s/share00001` };

  beforeEach(() => {
    server.shares.set('share00001', {
      name: 'Client sites',
      color: 'green',
      tabs: [
        { title: 'Road Rescue', url: 'https://rlroadrescue.com' },
        { title: 'Aim Travel', url: 'https://aimtravel.netlify.app' },
        { title: 'Nope', url: 'javascript:alert(1)' },
      ],
      live: false,
      views: 0,
    });
  });

  it('answers only the share site, and only this message', async () => {
    expect(SHARE_ORIGIN).toBe('https://tabfold.truewidgets.com');
    expect(fromShareSite({ url: 'https://tabfold.truewidgets.com/s/x' })).toBe(true);
    expect(handleExternalMessage({ type: 'tabfold-save-share', id: 'share00001' }, { origin: 'https://evil.example' })).toBeUndefined();
    expect(handleExternalMessage({ type: 'tabfold-save-share', id: 'share00001' }, { url: 'https://tabfold.truewidgets.com.evil.example/s' })).toBeUndefined();
    expect(handleExternalMessage({ type: 'something-else' }, site)).toBeUndefined();
    expect(await handleExternalMessage({ type: 'tabfold-save-share', id: '../me' }, site)).toMatchObject({ ok: false, reason: 'bad-request' });
    expect(await handleExternalMessage({ type: 'tabfold-save-share', id: 'missing00' }, site)).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('saves the shared pages as a new folder named like the share, without a token', async () => {
    expect(await handleExternalMessage({ type: 'tabfold-save-share', id: 'share00001' }, site)).toEqual({ ok: true, tabs: 2 });
    expect(server.requests.at(-1)).toMatchObject({ method: 'GET', path: '/public/shares/share00001', auth: null });
    const folders = await db.folders.toArray();
    expect(folders).toEqual([expect.objectContaining({ name: 'Client sites', color: 'green', source: 'import', deletedAt: 0 })]);
    expect(folders[0]!.id).toMatch(/^[0-9a-z]{12}$/);
    const tabs = await db.tabs.where('folderId').equals(folders[0]!.id).toArray();
    expect(tabs.map((t) => [t.title, t.url]).sort()).toEqual([
      ['Aim Travel', 'https://aimtravel.netlify.app'],
      ['Road Rescue', 'https://rlroadrescue.com'],
    ]);
  });

  it('keeps the shared folder’s note (1.0)', async () => {
    server.shares.get('share00001')!.note = 'Our  favourite\nplaces';
    expect(await handleExternalMessage({ type: 'tabfold-save-share', id: 'share00001' }, site)).toEqual({ ok: true, tabs: 2 });
    const [saved] = await db.folders.toArray();
    expect(saved).toMatchObject({ note: 'Our favourite places' });
    expect(saved!.noteAt).toBeGreaterThan(0);
  });

  it('Free limits apply: a 4th folder, or more tabs than the list has room for, and nothing is saved', async () => {
    await planState.set({ ...FREE_PLAN, checkedAt: Date.now() });
    for (const id of ['f1', 'f2', 'f3']) await db.folders.add({ ...FOLDER, id: `${id}aaaaaaaaaa` });
    expect(await handleExternalMessage({ type: 'tabfold-save-share', id: 'share00001' }, site)).toMatchObject({ ok: false, reason: 'folder-limit' });
    await db.folders.clear();
    const now = Date.now();
    await db.sessions.add({ id: 'full', name: 'Full', tags: [], pinned: 0, color: null, kind: 'session', source: 'save-all', createdAt: now, updatedAt: now, deletedAt: 0, deviceId: 'd', version: 1, tabCount: 499, windowCount: 1, preview: [] } satisfies SessionRecord);
    expect(await handleExternalMessage({ type: 'tabfold-save-share', id: 'share00001' }, site)).toMatchObject({ ok: false, reason: 'list-full' });
    expect(await db.tabs.count()).toBe(0);
    expect(await db.folders.count()).toBe(0);
  });
});
