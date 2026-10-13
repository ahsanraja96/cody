import Dexie from 'dexie';
import { browser } from 'wxt/browser';
import { DB_NAME, db } from '../db';
import { cleanFolderNote, listPersonalFolders } from '../folders';
import { FREE_LIMITS } from '../limits';
import { CommandError, type Command, type CommandResults } from '../messages';
import { api, ProError } from '../pro/api';
import { PRO_CONFIG, proConfigured } from '../pro/config';
import { planState } from '../pro/state';
import { saveCapture } from '../repo';
import { TAB_GROUP_COLORS, type CapturedTab, type FolderRecord, type TabGroupColor, type TabRecord } from '../types';
import { capUrl, classifyUrl, displayHost } from '../urls';
import { getDeviceId } from '../state';
import { ensureRoom, freeLimitsNow, newFolderId, requirePaid } from './room';

/**
 * Share a folder as a public, read-only link (Mx-Share board, Pro; server/API.md "Share a
 * folder"). Only the folder's name, colour and its pages' titles and addresses go to the server;
 * tabs folded from Incognito never do. "Keep it up to date" (`shareLive`) sends the folder again 30
 * seconds after its tabs change. The public page's "Save to my Tabfold" button asks this extension
 * (externally_connectable) to save the shared tabs as a new folder.
 */

export type ShareCommand = Extract<Command, { type: 'share-create' | 'share-update' | 'share-stop' | 'share-info' }>;

/** Where shared pages live (`<origin>/s/<id>`), set at build time (WXT_SHARE_ORIGIN). */
export const SHARE_ORIGIN = (() => {
  const value = ((import.meta.env.WXT_SHARE_ORIGIN as string | undefined) ?? '').trim() || 'https://tabfold.truewidgets.com';
  try {
    return new URL(value).origin;
  } catch {
    return 'https://tabfold.truewidgets.com';
  }
})();

/** server/API.md: at most 1,000 tabs; titles cut to 200 characters; longer addresses are left out. */
export const SHARE_MAX_TABS = 1000;
const SHARE_MAX_TITLE = 200;
const SHARE_MAX_URL = 2000;
/** "Keep it up to date": changes go out this long after the folder's tabs last changed. */
export const SHARE_PUSH_DELAY_MS = 30_000;
export const SHARE_ALARM = 'tabfold-share-push';
/** What each live share last sent, so an unchanged folder isn't sent again. */
const SHARE_SENT = 'shareSent';

interface ShareBody {
  name: string;
  color: TabGroupColor;
  /** The folder's note (1.0): one line, '' when none (server/API.md "1.0 additions"). */
  note: string;
  tabs: Array<{ title: string; url: string }>;
  live: boolean;
}

export async function handleShareCommand(command: ShareCommand): Promise<CommandResults[ShareCommand['type']]> {
  switch (command.type) {
    case 'share-create':
      return createShare(command.folderId, command.live);
    case 'share-update':
      return updateShare(command.folderId, command.live);
    case 'share-stop':
      return stopShare(command.folderId);
    case 'share-info':
      return shareInfo(command.folderId);
  }
}

async function folderOf(folderId: string): Promise<FolderRecord> {
  const folder = await db.folders.get(folderId);
  if (!folder || folder.deletedAt) throw new CommandError('This folder no longer exists.', 'not-found');
  return folder;
}

/** The folder's pages as the shared page lists them: in live folds, web pages only, never Incognito. */
async function sharedTabs(folderId: string): Promise<ShareBody['tabs']> {
  const rows = await db.tabs.where('folderId').equals(folderId).toArray();
  const sessions = await db.sessions.bulkGet([...new Set(rows.map((r) => r.sessionId))]);
  const live = new Map(sessions.filter((s) => !!s && !s.deletedAt).map((s) => [s!.id, s!]));
  return rows
    .filter((r: TabRecord) => live.has(r.sessionId) && !r.incognito && classifyUrl(r.url) === 'web' && r.url.length <= SHARE_MAX_URL)
    .sort((a, b) => live.get(b.sessionId)!.createdAt - live.get(a.sessionId)!.createdAt || a.order - b.order)
    .slice(0, SHARE_MAX_TABS)
    .map((r) => ({ title: (r.title || displayHost(r.url) || r.url).slice(0, SHARE_MAX_TITLE), url: r.url }));
}

async function bodyFor(folder: FolderRecord, live: boolean): Promise<ShareBody> {
  return { name: folder.name, color: folder.color, note: cleanFolderNote(folder.note ?? ''), tabs: await sharedTabs(folder.id), live };
}

/** A small fingerprint of what a share shows, to skip sending an unchanged folder. */
function fingerprint(body: ShareBody): string {
  // The note joins only when there is one, so shares sent before 1.0 aren't all sent again.
  const text = JSON.stringify([body.name, body.color, body.tabs.map((t) => [t.title, t.url]), ...(body.note ? [body.note] : [])]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}-${text.length}`;
}

async function sentPrints(): Promise<Record<string, string>> {
  return ((await browser.storage.local.get(SHARE_SENT))[SHARE_SENT] as Record<string, string> | undefined) ?? {};
}

async function rememberSent(folderId: string, print: string | null): Promise<void> {
  const current = await sentPrints();
  const next = { ...current };
  if (print) next[folderId] = print;
  else delete next[folderId];
  await browser.storage.local.set({ [SHARE_SENT]: next });
}

/** The share is gone on the server (stopped elsewhere): forget it here too. */
async function forgetShare(folderId: string): Promise<void> {
  await db.folders.where('id').equals(folderId).modify((f) => {
    delete f.shareId;
    delete f.shareLive;
  });
  await rememberSent(folderId, null);
}

const isGone = (error: unknown) => error instanceof ProError && error.status === 404;

function shareUrl(value: unknown, id: string): string {
  return typeof value === 'string' && /^https:\/\//.test(value) ? value : `${SHARE_ORIGIN}/s/${id}`;
}

async function createShare(folderId: string, live: boolean): Promise<CommandResults['share-create']> {
  await requirePaid();
  const folder = await folderOf(folderId);
  // A team folder is shared as a link by the team's owner only (Mx-Plans: "Owner controls: members, sharing").
  if (folder.teamId && (await planState.get()).team?.role !== 'owner') {
    throw new ProError('owner-only', 'Only the team’s owner can share a team folder as a link.');
  }
  if (folder.shareId) {
    // Already shared: send what it has now (and the switch), same link.
    const updated = await updateShare(folderId, live);
    return { url: updated.url, shareId: (await db.folders.get(folderId))?.shareId ?? folder.shareId };
  }
  const body = await bodyFor(folder, live);
  const answer = await api<{ id?: unknown; url?: unknown }>('/shares', { method: 'POST', body });
  const id = typeof answer?.id === 'string' && /^[A-Za-z0-9]{4,64}$/.test(answer.id) ? answer.id : null;
  if (!id) throw new ProError('server', 'Tabfold’s server sent an unexpected answer.');
  await db.folders.update(folderId, { shareId: id, shareLive: live });
  await rememberSent(folderId, fingerprint(body));
  return { url: shareUrl(answer.url, id), shareId: id };
}

async function updateShare(folderId: string, live?: boolean): Promise<CommandResults['share-update']> {
  await requirePaid();
  const folder = await folderOf(folderId);
  if (!folder.shareId) throw new CommandError('This folder isn’t shared.', 'not-shared');
  const keepLive = live ?? folder.shareLive === true;
  const body = await bodyFor(folder, keepLive);
  let answer: { url?: unknown; views?: unknown; live?: unknown };
  try {
    answer = await api(`/shares/${encodeURIComponent(folder.shareId)}`, { method: 'PUT', body });
  } catch (error) {
    if (isGone(error)) {
      await forgetShare(folderId);
      throw new CommandError('This link was stopped. Share the folder again for a new one.', 'not-shared');
    }
    throw error;
  }
  if (folder.shareLive !== keepLive) await db.folders.update(folderId, { shareLive: keepLive });
  await rememberSent(folderId, fingerprint(body));
  return { url: shareUrl(answer?.url, folder.shareId), views: typeof answer?.views === 'number' ? answer.views : 0, live: keepLive };
}

async function stopShare(folderId: string): Promise<{ ok: true }> {
  const folder = await db.folders.get(folderId);
  if (!folder?.shareId) return { ok: true };
  try {
    await api(`/shares/${encodeURIComponent(folder.shareId)}`, { method: 'DELETE' });
  } catch (error) {
    if (!isGone(error)) throw error;
  }
  await forgetShare(folderId);
  return { ok: true };
}

async function shareInfo(folderId: string): Promise<CommandResults['share-info']> {
  const folder = await db.folders.get(folderId);
  if (!folder?.shareId) return null;
  try {
    const answer = await api<{ url?: unknown; views?: unknown; live?: unknown }>(`/shares/${encodeURIComponent(folder.shareId)}`);
    return {
      url: shareUrl(answer?.url, folder.shareId),
      views: typeof answer?.views === 'number' ? answer.views : 0,
      live: typeof answer?.live === 'boolean' ? answer.live : folder.shareLive === true,
    };
  } catch (error) {
    if (isGone(error)) {
      await forgetShare(folderId);
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// "Keep it up to date"

/** Folders shared with "Keep it up to date" on. */
async function liveShares(): Promise<FolderRecord[]> {
  return (await db.folders.where('deletedAt').equals(0).toArray()).filter((f) => !!f.shareId && f.shareLive === true);
}

let anyLiveShare: boolean | undefined;

/**
 * Folded tabs or folders changed (here or on a Tabfold page): with a live share, send it 30 s after
 * the last change (an alarm, so a sleeping worker still does it).
 */
export async function onFoldsChanged(parts: Record<string, unknown>, now = Date.now()): Promise<void> {
  const keys = Object.keys(parts);
  const folders = keys.some((k) => k.startsWith(`idb://${DB_NAME}/folders/`));
  const tabs = keys.some((k) => k.startsWith(`idb://${DB_NAME}/tabs/`));
  if (!folders && !tabs) return;
  if (folders || anyLiveShare === undefined) anyLiveShare = (await liveShares()).length > 0;
  if (!anyLiveShare) return;
  await browser.alarms.create(SHARE_ALARM, { when: now + SHARE_PUSH_DELAY_MS });
}

/**
 * Send every live share whose folder changed since it was last sent. Runs from the alarm and the
 * worker's 5-minute check (which catches changes made while it slept). Shares whose plan ended
 * stay as they are (only Pro can change one); failures wait for the next change or check.
 */
export async function pushLiveShares(): Promise<number> {
  if (!proConfigured()) return 0;
  const shares = await liveShares();
  anyLiveShare = shares.length > 0;
  if (shares.length === 0 || (await freeLimitsNow())) return 0;
  const sent = await sentPrints();
  let pushed = 0;
  for (const folder of shares) {
    const body = await bodyFor(folder, true);
    const print = fingerprint(body);
    if (sent[folder.id] === print) continue;
    try {
      await api(`/shares/${encodeURIComponent(folder.shareId!)}`, { method: 'PUT', body });
      await rememberSent(folder.id, print);
      pushed += 1;
    } catch (error) {
      if (isGone(error)) await forgetShare(folder.id);
      else console.warn('[tabfold] shared folder update failed', error instanceof ProError ? error.code : (error as Error)?.name);
    }
  }
  return pushed;
}

/** For tests: forget the cached "is anything shared live". */
export function resetShareRuntime(): void {
  anyLiveShare = undefined;
}

/** Called once at the worker's top level: follow changes to folded tabs and folders. */
export function setupShare(): void {
  Dexie.on('storagemutated', (parts) => {
    onFoldsChanged(parts as Record<string, unknown>).catch(() => undefined);
  });
}

// ---------------------------------------------------------------------------------------------
// "Save to my Tabfold" from a shared page

export interface ExternalAnswer {
  ok: boolean;
  /** 'list-full', 'folder-limit', 'not-found', 'offline', 'bad-request', 'not-configured'. */
  reason?: string;
  /** Tabs saved. */
  tabs?: number;
  /** What the shared page shows when it didn't work (it reads `message`). */
  message?: string;
}

/** The sentence the public share page shows for each reason it couldn't save. */
const SAVE_MESSAGES: Record<string, string> = {
  'list-full': 'Your free Tabfold list is full (500 tabs). Make room in Tabfold, or upgrade, then try again.',
  'folder-limit': 'Free Tabfold has 3 folders. Delete one in Tabfold, or upgrade, then try again.',
  'not-found': 'This link doesn’t work any more.',
  offline: 'Tabfold couldn’t reach the internet. Check your connection and try again.',
  'rate-limited': 'Too many tries. Wait a minute and try again.',
  empty: 'There are no pages in this folder to save.',
  'not-configured': 'This copy of Tabfold can’t save shared folders.',
};

function withMessage(answer: ExternalAnswer): ExternalAnswer {
  if (answer.ok || answer.message) return answer;
  return { ...answer, message: SAVE_MESSAGES[answer.reason ?? ''] ?? 'Tabfold couldn’t save this folder. Try again.' };
}

const SHARE_ID = /^[A-Za-z0-9]{4,64}$/;

/** Is this sender a page on the share site (`<SHARE_ORIGIN>/…`)? */
export function fromShareSite(sender: { origin?: string; url?: string; id?: string }): boolean {
  let origin = sender.origin;
  if (!origin && sender.url) {
    try {
      origin = new URL(sender.url).origin;
    } catch {
      return false;
    }
  }
  return origin === SHARE_ORIGIN;
}

/**
 * `runtime.onMessageExternal`: `{ type: 'tabfold-save-share', id }` from the share site. Reads the
 * share (`GET /public/shares/<id>`, no token) and saves its tabs as a new folder named like it. Free
 * limits apply (3 folders, 500 tabs): nothing is saved when it doesn't fit. Anything else, or from
 * anywhere else, gets no answer.
 */
export function handleExternalMessage(message: unknown, sender: { origin?: string; url?: string; id?: string }): Promise<ExternalAnswer> | undefined {
  if (!fromShareSite(sender)) return undefined;
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'tabfold-save-share') return undefined;
  const id = (message as { id?: unknown }).id;
  if (typeof id !== 'string' || !SHARE_ID.test(id)) return Promise.resolve(withMessage({ ok: false, reason: 'bad-request' }));
  return saveShare(id)
    .catch((error): ExternalAnswer => {
      const code = error instanceof CommandError ? error.code : undefined;
      return { ok: false, reason: code ?? 'error' };
    })
    .then(withMessage);
}

interface PublicShare {
  name: string;
  color: TabGroupColor;
  /** The folder's note (1.0), '' when none. */
  note: string;
  tabs: Array<{ title: string; url: string }>;
}

function readPublicShare(value: unknown): PublicShare | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { name?: unknown; color?: unknown; note?: unknown; tabs?: unknown };
  if (!Array.isArray(v.tabs)) return null;
  const tabs = v.tabs
    .filter((t): t is { title?: unknown; url: string } => !!t && typeof t === 'object' && typeof (t as { url?: unknown }).url === 'string')
    .map((t) => ({ url: capUrl(t.url).url, title: typeof t.title === 'string' ? t.title.slice(0, SHARE_MAX_TITLE) : '' }))
    .filter((t) => classifyUrl(t.url) === 'web')
    .slice(0, SHARE_MAX_TABS);
  const name = (typeof v.name === 'string' ? v.name.trim() : '').slice(0, 60) || 'Shared folder';
  const color = (TAB_GROUP_COLORS as readonly string[]).includes(v.color as string) ? (v.color as TabGroupColor) : 'grey';
  return { name, color, note: cleanFolderNote(v.note), tabs };
}

function capturedTabFor(url: string, title: string): CapturedTab {
  const { url: capped, truncated } = capUrl(url);
  return {
    url: capped,
    title: title.trim() || displayHost(capped) || capped,
    favIconUrl: '',
    pinned: false,
    groupName: null,
    groupColor: null,
    groupCollapsed: false,
    keywords: [],
    urlTruncated: truncated,
  };
}

async function saveShare(id: string): Promise<ExternalAnswer> {
  if (!proConfigured()) return { ok: false, reason: 'not-configured' };
  let response: Response;
  try {
    response = await fetch(`${PRO_CONFIG.apiUrl}/public/shares/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, reason: 'offline' };
  }
  if (response.status === 404) return { ok: false, reason: 'not-found' };
  if (!response.ok) return { ok: false, reason: response.status === 429 ? 'rate-limited' : 'server' };
  const share = readPublicShare(await response.json().catch(() => null));
  if (!share) return { ok: false, reason: 'server' };
  if (share.tabs.length === 0) return { ok: false, reason: 'empty' };

  // The Free limits: a 4th folder or more tabs than fit, and nothing is saved.
  if (await freeLimitsNow()) {
    const folders = (await listPersonalFolders()).length;
    if (folders >= FREE_LIMITS.folders) {
      throw new CommandError(`Free has ${FREE_LIMITS.folders} folders.`, 'folder-limit', { limit: FREE_LIMITS.folders });
    }
    await ensureRoom(share.tabs.length, 'This folder');
  }

  const now = Date.now();
  const folders = await db.folders.toArray();
  // TODO(merge): use CORE-A's folder-create repo function.
  const folder: FolderRecord = {
    id: newFolderId(),
    name: share.name,
    color: share.color,
    order: folders.reduce((max, f) => Math.max(max, f.order + 1), 0),
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    source: 'import',
    // The shared folder's note comes along (1.0).
    ...(share.note ? { note: share.note, noteAt: now } : {}),
  };
  const result = await saveCapture(
    [{ name: '', focused: false, bounds: null, state: null, tabs: share.tabs.map((t) => capturedTabFor(t.url, t.title)) }],
    { name: share.name, source: 'import', deviceId: await getDeviceId(), now },
    // The whole folder, as shared: pages already folded elsewhere are kept here too.
    { dedupe: false },
  );
  await db.transaction('rw', [db.folders, db.tabs], async () => {
    await db.folders.add(folder);
    if (result.savedTabIds.length) await db.tabs.where('id').anyOf(result.savedTabIds).modify({ folderId: folder.id });
  });
  return { ok: true, tabs: result.savedTabIds.length };
}
