import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handle } from '../server/supabase/functions/tabfold/app.ts';
import { route } from '@/lib/background/router';
import { checkTeams } from '@/lib/background/teams';
import { checkWiped, refreshDataGuard } from '@/lib/dataGuard';
import { db, TabfoldDB } from '@/lib/db';
import { addFolder, countFoldedTabs, listLiveFolders, listRoom } from '@/lib/folders';
import { CommandError, type CommandResponse } from '@/lib/messages';
import { DEVICE_TOKEN_KEY } from '@/lib/pro/account';
import { errorFromResponse, ProError, type ApiRequest } from '@/lib/pro/api';
import { resetCheckoutRuntime } from '@/lib/pro/checkout';
import { PRO_CONFIG } from '@/lib/pro/config';
import { resetPlanRuntime } from '@/lib/pro/plan';
import { planState, teamDetails, teamGone } from '@/lib/pro/state';
import { parseInviteEmails, readTeamDetails } from '@/lib/pro/team';
import type { TeamDetails } from '@/lib/pro/types';
import { clearAllData, listFoldedTabs, listPersonalTabs, listTeamTabs, removeTabs, saveCapture } from '@/lib/repo';
import { syncOnce, type SyncArea, type SyncDeps, type SyncRunResult } from '@/lib/sync/engine';
import { mergeContent } from '@/lib/sync/merge';
import { defaultSyncState, type SyncLocalState, type SyncStateStore } from '@/lib/sync/localState';
import { CLOUD_LIMITS, decodeRecord, FOLDERS_KEY, pack, unpack, type SyncRecord } from '@/lib/sync/records';
import { teamSyncArea, teamSyncState } from '@/lib/sync/team';
import { copyFolderId, keepTeamCopy, placeTabs, purgeTeam, takeTeamOut } from '@/lib/teamFolders';
import { avatarColors, displayName, initials, latestActivity, teamDeviceId } from '@/lib/teams';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { FakeChrome } from './chrome';
import { teamErrorText, teamSeatsLine } from '@/ui/pro';
import { capturedWindow } from './fixtures';
import { createServer, keyOf, newToken, PUBLIC_URL, type Server } from './server/fakes';

// Teams in the extension, against the real server code (server/supabase/functions/tabfold/app.ts
// with its in-memory store, fake Stripe and mailer): the team client and commands, team sync
// between two members' computers, moving tabs in and out of team folders, and what happens when
// someone is no longer in the team.

let server: Server;
const before = { ...PRO_CONFIG };

const OWNER = 'free@example.com';
const OWNER_KEY = keyOf('free');
const SARA = 'sara@truewidgets.com';
const SARA_KEY = newToken('sara');
const MIKE = 'mike.k@truewidgets.com';
const MIKE_KEY = newToken('mike');

/** The server's answer to a request the extension sent (`api()` calls fetch). */
async function serve(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  return handle(new Request(url, init), server.deps);
}

beforeEach(async () => {
  server = createServer();
  await server.ready;
  PRO_CONFIG.apiUrl = PUBLIC_URL;
  vi.stubGlobal('fetch', serve);
  resetPlanRuntime();
  resetCheckoutRuntime();
});

afterEach(() => {
  Object.assign(PRO_CONFIG, before);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPlanRuntime();
  resetCheckoutRuntime();
});

/** This computer is the one with this device token. */
async function useToken(token: string): Promise<void> {
  await fakeBrowser.storage.local.set({ [DEVICE_TOKEN_KEY]: token });
  resetPlanRuntime();
}

/** The owner buys Teams ("Truewidgets", 3 seats, yearly); the team's id. */
async function buyTeam(): Promise<string> {
  await server.buy('free', { tier: 'teams', interval: 'year', teamName: 'Truewidgets', seats: 3 });
  return server.store.teamOfEmail(OWNER)!.id;
}

/** The owner invites this email; it signs in with a code on its own computer and joins. */
async function join(token: string, email: string): Promise<void> {
  await server.request('POST', '/team/invites', { key: OWNER_KEY, body: { emails: [email] } });
  await server.signIn(token, email);
}

function data<T>(response: CommandResponse<unknown>): T {
  if (!response.ok) throw new Error(`Command failed: ${response.code} ${response.error}`);
  return response.data as T;
}

/** A request as one computer makes it (`api()` with that computer's device token). */
function requestAs(token: string): ApiRequest {
  return async <T>(path: string, init: Parameters<ApiRequest>[1] = {}) => {
    const { body, timeoutMs: _timeout, headers, ...rest } = init;
    const sent = new Headers(headers);
    sent.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) sent.set('Content-Type', 'application/json');
    const response = await handle(
      new Request(`${PUBLIC_URL}${path}`, { ...rest, headers: sent, body: body === undefined ? undefined : JSON.stringify(body) }),
      server.deps,
    );
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) throw errorFromResponse(response.status, json, path);
    return json as T;
  };
}

function memoryStore(): SyncStateStore & { value: SyncLocalState } {
  const store = {
    value: defaultSyncState(),
    get: async () => store.value,
    set: async (state: SyncLocalState) => {
      store.value = state;
    },
  };
  return store;
}

/** Chrome sync or the account, in memory: what the person's own sync writes. */
function memoryArea(): SyncArea & { items: Record<string, unknown> } {
  const area = {
    items: {} as Record<string, unknown>,
    getAll: async () => ({ ...area.items }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(area.items, items);
    },
    remove: async (keys: string[]) => {
      for (const key of keys) delete area.items[key];
    },
  };
  return area;
}

let clock = Date.UTC(2026, 9, 11, 9);
let dbCounter = 0;

/** A team member's computer: its own database, syncing the team's copy as that member. */
class Member {
  db: TabfoldDB;
  status: SyncRunResult['status'] | undefined;
  deps: SyncDeps;
  gone = 0;
  constructor(
    readonly name: string,
    readonly token: string,
    readonly email: string,
    readonly teamId: string,
    store: SyncStateStore = memoryStore(),
  ) {
    this.db = new TabfoldDB(`team-test-${name}-${dbCounter++}`);
    this.deps = {
      database: this.db,
      area: teamSyncArea(requestAs(token), () => (this.gone += 1)),
      store,
      deviceId: async () => `device-${name}`,
      enabled: async () => true,
      isWiped: async () => false,
      now: () => clock,
      limits: CLOUD_LIMITS,
      scope: async () => ({ team: { id: teamId, name: 'Truewidgets' } }),
    };
  }
  async sync(force = false) {
    clock += 1000;
    const result = await syncOnce(this.deps, { previous: this.status, force });
    this.status = result.status;
    return result;
  }
  async fold(urls: string[]): Promise<string[]> {
    clock += 2000;
    const saved = await saveCapture([capturedWindow(urls)], { source: 'save-all', deviceId: `device-${this.name}`, now: clock }, { dedupe: false }, this.db);
    return saved.savedTabIds;
  }
  newFolder(name: string): Promise<FolderRecord> {
    return addFolder({ name, teamId: this.teamId }, { unlimited: false, now: clock }, this.db);
  }
  share(ids: string[], folder: FolderRecord | null) {
    clock += 1000;
    return placeTabs(ids, folder, { email: this.email, deviceId: `device-${this.name}`, teamName: 'Truewidgets', now: clock }, this.db);
  }
  teamTabs(): Promise<TabRecord[]> {
    return listTeamTabs(this.teamId, this.db);
  }
  async teamUrls(): Promise<string[]> {
    return (await this.teamTabs()).map((t) => t.url).sort();
  }
  async folders(): Promise<FolderRecord[]> {
    return listLiveFolders(this.db);
  }
}

async function settle(...members: Member[]): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    let wrote = false;
    for (const member of members) wrote = (await member.sync()).wrote || wrote;
    if (!wrote) return;
  }
  throw new Error('Members kept writing to the team’s copy');
}

// ---------------------------------------------------------------------------------------------

describe('the team’s people, by email', () => {
  it('initials, names and avatar colours', () => {
    expect(initials('sara@truewidgets.com')).toBe('SA');
    expect(initials('mike.k@truewidgets.com')).toBe('MK');
    expect(initials('hello-world+tabs@x.com')).toBe('HW');
    expect(initials('a@x.com')).toBe('A');
    expect(displayName('sara@truewidgets.com')).toBe('Sara');
    expect(displayName('mike.k@truewidgets.com')).toBe('Mike');
    const details = { members: [{ email: 'ih@x.com' }, { email: 'sara@x.com' }], invites: [{ email: 'mike@x.com' }] } as unknown as TeamDetails;
    expect([...avatarColors(details).entries()]).toEqual([
      ['ih@x.com', 'blue'],
      ['sara@x.com', 'pink'],
      ['mike@x.com', 'orange'],
    ]);
  });

  it('“Sara added 3 tabs”: the newest adder’s tabs within the hour', () => {
    const at = Date.UTC(2026, 9, 11, 12);
    const tabs = [
      { addedBy: 'sara@x.com', savedAt: at },
      { addedBy: 'sara@x.com', savedAt: at - 10 * 60_000 },
      { addedBy: 'sara@x.com', savedAt: at - 50 * 60_000 },
      { addedBy: 'sara@x.com', savedAt: at - 3 * 3_600_000 },
      { addedBy: 'mike@x.com', savedAt: at - 5 * 60_000 },
      { savedAt: at + 60_000 },
    ];
    expect(latestActivity(tabs)).toEqual({ email: 'sara@x.com', tabs: 3, at });
    expect(latestActivity([{ savedAt: at }])).toBeNull();
  });

  it('reads the invite field: commas, spaces or new lines; each once; says what’s wrong', () => {
    expect(parseInviteEmails('sara@truewidgets.com, Mike.K@truewidgets.com\nsara@truewidgets.com <ada@x.io>')).toEqual({
      ok: true,
      emails: ['sara@truewidgets.com', 'mike.k@truewidgets.com', 'ada@x.io'],
    });
    expect(parseInviteEmails('  ')).toMatchObject({ ok: false, reason: 'empty', message: 'Add an email address first.' });
    expect(parseInviteEmails('sara@truewidgets.com mike@')).toMatchObject({
      ok: false,
      reason: 'invalid',
      message: '“mike@” doesn’t look like an email address.',
    });
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@x.com`).join(' ');
    expect(parseInviteEmails(many)).toMatchObject({ ok: false, reason: 'too-many', message: 'Invite up to 20 people at a time.' });
  });

  it('reads GET /team’s answer and leaves anything odd out', () => {
    expect(
      readTeamDetails({
        team: { id: 't1', name: 'Truewidgets', seats: 3, role: 'owner', status: 'past_due' },
        members: [{ id: 'a', email: 'Ada@X.com', role: 'owner', joinedAt: 5 }, { email: 'no-id@x.com' }],
        invites: [{ email: 'Mike@X.com', invitedAt: 7 }, { invitedAt: 1 }],
      }),
    ).toEqual({
      team: { id: 't1', name: 'Truewidgets', seats: 3, role: 'owner', status: 'past_due' },
      members: [{ id: 'a', email: 'ada@x.com', role: 'owner', joinedAt: 5 }],
      invites: [{ email: 'mike@x.com', invitedAt: 7 }],
    });
    expect(readTeamDetails({ members: [] })).toBeNull();
  });
});

describe('the Team section’s words', () => {
  it('the seats line, as the owner and as a member', () => {
    expect(teamSeatsLine(3, 'year')).toBe('3 people · $8 a person a month, billed yearly. Everyone gets Pro AI.');
    expect(teamSeatsLine(1, 'month')).toBe('1 person · $10 a person a month, billed monthly. Everyone gets Pro AI.');
    expect(teamSeatsLine(4, null)).toBe('4 people · Everyone gets Pro AI.');
  });

  it('a failure says the server’s own words, unless Tabfold couldn’t ask', () => {
    expect(teamErrorText(new CommandError('Only the team’s owner can do this.', 'owner-only'))).toBe('Only the team’s owner can do this.');
    expect(teamErrorText(new CommandError('A team can have up to 100 people, invitations included.', 'server'))).toBe(
      'A team can have up to 100 people, invitations included.',
    );
    expect(teamErrorText(new CommandError('x', 'offline'))).toBe('You’re offline. Connect to the internet, then try again.');
    // Online, yet no answer (the server turned the request away): don't blame the connection.
    vi.stubGlobal('navigator', { onLine: true });
    try {
      expect(teamErrorText(new CommandError('x', 'offline'))).toBe(
        'Couldn’t reach Tabfold’s server. Check your connection, then try again in a moment.',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('who added a tab, in the team’s records ([9])', () => {
  const record: SyncRecord = { id: 'abcdefabcdef', url: 'https://a.com/', title: 'A', savedAt: 1_700_000_000_000, keywords: [] };

  it('travels as the 10th field and reads back; older records have none', () => {
    const packed = pack([{ ...record, addedBy: 'sara@truewidgets.com' }, { ...record, id: 'bbbbbbbbbbbb', url: 'https://b.com/' }], [], {
      floor: 0,
      limits: CLOUD_LIMITS,
    });
    const chunk = packed.items['tf.c0'] as unknown[][];
    expect(chunk.find((r) => r[0] === 'abcdefabcdef')).toEqual(['abcdefabcdef', 'https://a.com/', 'A', 1_700_000_000, [], '', 0, '', 0, 'sara@truewidgets.com']);
    expect(chunk.find((r) => r[0] === 'bbbbbbbbbbbb')).toHaveLength(4);
    const back = unpack(packed.items, CLOUD_LIMITS).records;
    expect(back.find((r) => r.id === 'abcdefabcdef')!.addedBy).toBe('sara@truewidgets.com');
    expect(back.find((r) => r.id === 'bbbbbbbbbbbb')!.addedBy).toBeUndefined();
  });

  it('drops one that isn’t an email, keeping the tab', () => {
    const raw = ['abcdefabcdef', 'https://a.com/', 'A', 1_700_000_000, [], '', 0, '', 0, 'not an email'];
    expect(decodeRecord(raw, CLOUD_LIMITS)).toEqual(record);
  });

  it('two copies agree on who added it, whichever way round', () => {
    const a = { ...record, addedBy: 'sara@x.com' };
    const b = { ...record, addedBy: 'ada@x.com' };
    expect(mergeContent(a, b).addedBy).toBe('ada@x.com');
    expect(mergeContent(b, a).addedBy).toBe('ada@x.com');
    expect(mergeContent(record, a).addedBy).toBe('sara@x.com');
  });
});

describe('the team client and commands', () => {
  let teamId: string;

  beforeEach(async () => {
    teamId = await buyTeam();
    await useToken(OWNER_KEY);
    data(await route({ type: 'plan-refresh', force: true }));
  });

  it('reads the team, invites, cancels an invitation and renames; the pages get the details too', async () => {
    expect((await planState.get()).team).toEqual({ id: teamId, name: 'Truewidgets', role: 'owner', seats: 3 });
    const details = data<TeamDetails>(await route({ type: 'team-get' }));
    expect(details).toMatchObject({
      team: { id: teamId, name: 'Truewidgets', role: 'owner', seats: 3, status: 'active' },
      members: [{ email: OWNER, role: 'owner' }],
      invites: [],
    });
    expect(await teamDetails.get()).toMatchObject({ team: { id: teamId }, members: [{ email: OWNER }] });

    expect(data(await route({ type: 'team-invite', emails: ['sara@truewidgets.com, Mike.K@truewidgets.com'] }))).toEqual({ invited: 2 });
    expect(server.mailer.invites.map((i) => i.email)).toEqual([SARA, MIKE]);
    expect((await teamDetails.get())!.invites.map((i) => i.email)).toEqual([SARA, MIKE]);
    // Already invited: nothing new, nobody emailed again.
    expect(data(await route({ type: 'team-invite', emails: [SARA] }))).toEqual({ invited: 0 });
    // Something that isn't an email: nobody invited.
    expect(await route({ type: 'team-invite', emails: ['ada@x.com', 'nope'] })).toMatchObject({
      ok: false,
      code: 'invalid-email',
      error: '“nope” doesn’t look like an email address.',
    });
    expect(server.mailer.invites).toHaveLength(2);

    expect(data(await route({ type: 'team-cancel-invite', email: MIKE }))).toEqual({ ok: true });
    expect((await teamDetails.get())!.invites.map((i) => i.email)).toEqual([SARA]);

    expect(data(await route({ type: 'team-rename', name: '  Truewidgets   Ltd ' }))).toMatchObject({ team: { name: 'Truewidgets Ltd' } });
    expect((await planState.get()).team!.name).toBe('Truewidgets Ltd');
    expect((await teamDetails.get())!.team.name).toBe('Truewidgets Ltd');
  });

  it('a member: the owner’s things say who can do them; leaving works', async () => {
    await join(SARA_KEY, SARA);
    await useToken(SARA_KEY);
    data(await route({ type: 'plan-refresh', force: true }));
    expect((await planState.get()).team).toMatchObject({ id: teamId, role: 'member' });
    const details = data<TeamDetails>(await route({ type: 'team-get' }));
    expect(details.members.map((m) => [m.email, m.role])).toEqual([
      [OWNER, 'owner'],
      [SARA, 'member'],
    ]);
    expect(await route({ type: 'team-rename', name: 'Mine now' })).toMatchObject({
      ok: false,
      code: 'owner-only',
      error: 'Only the team’s owner can do this.',
    });
    expect(await route({ type: 'team-invite', emails: ['x@x.com'] })).toMatchObject({ ok: false, code: 'owner-only' });
    expect(await route({ type: 'team-remove', memberId: details.members[0]!.id })).toMatchObject({ ok: false, code: 'owner-only' });

    expect(data(await route({ type: 'team-leave' }))).toEqual({ ok: true });
    expect((await planState.get()).team).toBeUndefined();
    expect(server.store.teamOfEmail(SARA)).toBeNull();
  });

  it('the owner removes someone, and can’t leave their own team', async () => {
    await join(SARA_KEY, SARA);
    await join(MIKE_KEY, MIKE);
    const details = data<TeamDetails>(await route({ type: 'team-get' }));
    const sara = details.members.find((m) => m.email === SARA)!;
    expect(data(await route({ type: 'team-remove', memberId: sara.id }))).toEqual({ ok: true });
    expect((await teamDetails.get())!.members.map((m) => m.email)).toEqual([OWNER, MIKE]);
    expect(server.store.teamOfEmail(SARA)).toBeNull();
    expect(await route({ type: 'team-leave' })).toMatchObject({ ok: false, code: 'owner-cant-leave' });
  });

  it('someone in no team: not-in-team, without asking the server for the team', async () => {
    await useToken(keyOf('proMonthly'));
    data(await route({ type: 'plan-refresh', force: true }));
    expect(await route({ type: 'team-get' })).toMatchObject({ ok: false, code: 'not-in-team', error: 'You’re not in a team.' });
    expect(data(await route({ type: 'team-sync-now' }))).toEqual({ ok: false });
  });

  it('a team folder is shared as a link by the owner only', async () => {
    await join(SARA_KEY, SARA);
    await useToken(SARA_KEY);
    data(await route({ type: 'plan-refresh', force: true }));
    const folder = data<{ folder: FolderRecord }>(await route({ type: 'folder-create', name: 'Client sites', teamId })).folder;
    expect(await route({ type: 'share-create', folderId: folder.id, live: false })).toMatchObject({
      ok: false,
      code: 'owner-only',
      error: 'Only the team’s owner can share a team folder as a link.',
    });
  });

  it('a new team folder: no limit, and only for the plan’s team', async () => {
    const made = data<{ folder: FolderRecord }>(await route({ type: 'folder-create', name: 'Client sites', color: 'green', teamId }));
    expect(made.folder).toMatchObject({ name: 'Client sites', color: 'green', teamId });
    expect(await route({ type: 'folder-create', name: 'Theirs', teamId: 'team_other' })).toMatchObject({ ok: false, code: 'not-in-team' });
  });
});

describe('Start a team, end to end', () => {
  it('checkout with seats and a name; once paid, the plan shows the team and its owner', async () => {
    await useToken(OWNER_KEY);
    data(await route({ type: 'plan-refresh', force: true }));
    // Stripe's pages are https (the extension opens nothing else).
    server.stripe.baseUrl = 'https://checkout.stripe.test';
    const chrome = new FakeChrome().install();
    const page = chrome.openWindow([{ url: 'chrome-extension://test/library.html#/pro', active: true }], { focused: true }).tabIds[0]!;
    expect(data(await route({ type: 'checkout-open', tier: 'teams', interval: 'year', seats: 4, teamName: 'Truewidgets' }, { tabId: page }))).toEqual({
      opened: true,
    });
    const sessionId = [...server.stripe.sessions.keys()].at(-1)!;
    expect(server.stripe.sessions.get(sessionId)!.line_items).toEqual([{ price: server.stripe.priceFor('tabfold-teams-yearly')!.id, quantity: 4 }]);
    await server.stripe.completeSession(sessionId);
    await server.deliverEvents();
    const plan = data<{ tier: string; team?: unknown }>(await route({ type: 'plan-refresh', force: true }));
    expect(plan).toMatchObject({ tier: 'pro-ai', team: { name: 'Truewidgets', role: 'owner', seats: 4 } });
  });
});

// ---------------------------------------------------------------------------------------------

describe('team sync between two members', () => {
  let teamId: string;
  let owner: Member;
  let sara: Member;

  beforeEach(async () => {
    teamId = await buyTeam();
    await join(SARA_KEY, SARA);
    owner = new Member('owner', OWNER_KEY, OWNER, teamId);
    sara = new Member('sara', SARA_KEY, SARA, teamId);
  });

  it('a folder one makes, and the tabs added to it, show up for the other with who added them', async () => {
    const folder = await owner.newFolder('Client sites');
    const ids = await owner.fold(['https://rlroadrescue.com/', 'https://aimtravel.netlify.app/', 'https://app.netlify.com/']);
    const moved = await owner.share(ids, folder);
    expect(moved).toMatchObject({ moved: 3, skippedIncognito: 0 });
    // The tabs left the owner's own list for the team's fold, with new ids.
    expect(await listPersonalTabs(owner.db)).toHaveLength(0);
    expect((await owner.teamTabs()).map((t) => t.id).sort()).toEqual([...moved.newIds].sort());
    expect(moved.newIds.some((id) => ids.includes(id))).toBe(false);

    expect(await owner.sync()).toMatchObject({ wrote: true, status: { state: 'synced', syncedTabs: 3 } });
    expect(await sara.sync()).toMatchObject({ applied: true, status: { state: 'synced', syncedTabs: 3 } });
    const [theirs] = await sara.folders();
    expect(theirs).toMatchObject({ id: folder.id, name: 'Client sites', teamId });
    const tabs = await sara.teamTabs();
    expect(tabs.map((t) => [t.url, t.folderId, t.addedBy]).sort()).toEqual([
      ['https://aimtravel.netlify.app/', folder.id, OWNER],
      ['https://app.netlify.com/', folder.id, OWNER],
      ['https://rlroadrescue.com/', folder.id, OWNER],
    ]);
    const fold = await sara.db.sessions.get(tabs[0]!.sessionId);
    expect(fold).toMatchObject({ deviceId: teamDeviceId(teamId), name: 'Team · Truewidgets', source: 'import' });
    // The team's tabs and folders count toward no Free limit.
    expect(await countFoldedTabs(sara.db)).toBe(0);
    expect(await listPersonalTabs(sara.db)).toHaveLength(0);
    // Nothing more to write on either side.
    await settle(owner, sara);
  });

  it('a tab added, moved and removed travels to everyone; so does a new name', async () => {
    const folder = await owner.newFolder('Client sites');
    await owner.share(await owner.fold(['https://a.example/']), folder);
    await settle(owner, sara);

    // Sara adds one of her own tabs.
    const mine = await sara.fold(['https://sara.example/brief']);
    await sara.share(mine, (await sara.folders())[0]!);
    await settle(sara, owner);
    const ownerTabs = await owner.teamTabs();
    expect(ownerTabs.map((t) => t.url).sort()).toEqual(['https://a.example/', 'https://sara.example/brief']);
    expect(latestActivity(ownerTabs)).toMatchObject({ email: SARA, tabs: 1 });

    // The owner moves it into another team folder, and renames the first.
    const onboarding = await owner.newFolder('Onboarding');
    const saraTab = ownerTabs.find((t) => t.addedBy === SARA)!;
    clock += 1000;
    expect(await owner.share([saraTab.id], onboarding)).toMatchObject({ moved: 1, newIds: [] });
    await owner.db.folders.put({ ...folder, name: 'Client sites 2027', updatedAt: clock });
    await settle(owner, sara);
    expect((await sara.teamTabs()).find((t) => t.url === 'https://sara.example/brief')!.folderId).toBe(onboarding.id);
    expect((await sara.folders()).map((f) => f.name).sort()).toEqual(['Client sites 2027', 'Onboarding']);

    // Sara removes it: gone for everyone.
    await removeTabs([(await sara.teamTabs()).find((t) => t.url === 'https://sara.example/brief')!.id], sara.db);
    await settle(sara, owner);
    expect(await owner.teamUrls()).toEqual(['https://a.example/']);
  });

  it('deleting a team folder takes it and its tabs from everyone', async () => {
    const folder = await owner.newFolder('Ads and SEO');
    await owner.share(await owner.fold(['https://ads.example/', 'https://seo.example/']), folder);
    await settle(owner, sara);
    expect(await sara.teamUrls()).toHaveLength(2);

    // As "Delete folder…" does it for a team folder.
    clock += 1000;
    await sara.db.folders.put({ ...(await sara.db.folders.get(folder.id))!, deletedAt: clock, updatedAt: clock });
    await removeTabs((await sara.teamTabs()).map((t) => t.id), sara.db);
    await settle(sara, owner);
    expect(await owner.teamUrls()).toEqual([]);
    expect((await owner.folders()).filter((f) => f.teamId)).toEqual([]);
  });

  it('moving a tab out of a team folder makes it the person’s own again, and the team loses it', async () => {
    const folder = await owner.newFolder('Client sites');
    await owner.share(await owner.fold(['https://keep.example/', 'https://other.example/']), folder);
    await settle(owner, sara);
    const tab = (await sara.teamTabs()).find((t) => t.url === 'https://keep.example/')!;
    const out = await sara.share([tab.id], null);
    expect(out).toMatchObject({ moved: 1 });
    const personal = await listPersonalTabs(sara.db);
    expect(personal).toHaveLength(1);
    expect(personal[0]).toMatchObject({ url: 'https://keep.example/', id: out.newIds[0] });
    expect(personal[0]!.addedBy).toBeUndefined();
    expect(personal[0]!.folderId).toBeUndefined();
    expect((await sara.db.sessions.get(personal[0]!.sessionId))!.name).toBe('From Truewidgets');
    await settle(sara, owner);
    expect(await owner.teamUrls()).toEqual(['https://other.example/']);
  });

  it('the person’s own sync never carries a team’s folders or tabs, and the team’s copy nothing personal', async () => {
    const teamFolder = await owner.newFolder('Client sites');
    await owner.share(await owner.fold(['https://team.example/']), teamFolder);
    const holiday = await addFolder({ name: 'Holiday' }, { unlimited: true, now: clock }, owner.db);
    const [own] = await owner.fold(['https://lisbon.example/flat']);
    await owner.db.tabs.update(own!, { folderId: holiday.id });
    await owner.sync();

    const personal = memoryArea();
    const result = await syncOnce({
      database: owner.db,
      area: personal,
      store: memoryStore(),
      deviceId: async () => 'device-owner',
      enabled: async () => true,
      isWiped: async () => false,
      now: () => clock,
      siteKinds: { get: async () => ({ kinds: {}, removals: {} }), set: async () => undefined },
    });
    expect(result).toMatchObject({ wrote: true, status: { syncedTabs: 1 } });
    const mine = unpack(personal.items);
    expect(mine.records.map((r) => r.url)).toEqual(['https://lisbon.example/flat']);
    expect(mine.folders!.folders.map((f) => f.name)).toEqual(['Holiday']);
    expect(JSON.stringify(personal.items)).not.toContain('team.example');

    const team = unpack((await requestAs(OWNER_KEY)<{ items: Record<string, unknown> }>('/team/sync')).items, CLOUD_LIMITS);
    expect(team.records.map((r) => [r.url, r.addedBy])).toEqual([['https://team.example/', OWNER]]);
    expect(team.folders!.folders.map((f) => f.name)).toEqual(['Client sites']);
    expect(team.folders!.kinds).toEqual([]);
    expect(JSON.stringify(team)).not.toContain('lisbon');
    expect(Object.keys(personal.items)).toContain(FOLDERS_KEY);
  });

  it('“Clear everything” here never removes the team’s tabs for everyone: they come back', async () => {
    const stored = new Member('owner2', OWNER_KEY, OWNER, teamId, teamSyncState(async () => teamId));
    const folder = await stored.newFolder('Client sites');
    await stored.share(await stored.fold(['https://one.example/', 'https://two.example/']), folder);
    await settle(stored, sara);
    await clearAllData(stored.db);
    expect(await stored.teamUrls()).toEqual([]);
    await stored.sync();
    await settle(stored, sara);
    expect(await sara.teamUrls()).toEqual(['https://one.example/', 'https://two.example/']);
    expect(await stored.teamUrls()).toEqual(['https://one.example/', 'https://two.example/']);
  });

  it('after leaving: the team’s copy says so, the folders leave this computer, and “Keep a copy” keeps them as the person’s own', async () => {
    const folder = await owner.newFolder('Client sites');
    await owner.share(await owner.fold(['https://a.example/', 'https://b.example/', 'https://c.example/']), folder);
    await settle(owner, sara);

    await requestAs(SARA_KEY)('/team/leave', { method: 'POST' });
    expect(await sara.sync()).toMatchObject({ status: { state: 'error', error: 'You’re not in this team any more.' } });
    expect(sara.gone).toBe(1);

    const now = (clock += 1000);
    expect(await takeTeamOut(teamId, now, sara.db)).toEqual({ folders: 1, tabs: 3 });
    expect(await sara.folders()).toEqual([]);
    expect(await listFoldedTabs(sara.db)).toEqual([]);

    expect(await keepTeamCopy(teamId, { name: 'Truewidgets', deviceId: 'device-sara', since: now, now: now + 10 }, sara.db)).toEqual({
      folders: 1,
      tabs: 3,
    });
    const [copy] = await sara.folders();
    expect(copy).toMatchObject({ id: copyFolderId(teamId, folder.id), name: 'Client sites', deletedAt: 0 });
    expect(copy!.teamId).toBeUndefined();
    const tabs = await listPersonalTabs(sara.db);
    expect(tabs.map((t) => [t.url, t.folderId, t.addedBy]).sort()).toEqual([
      ['https://a.example/', copy!.id, undefined],
      ['https://b.example/', copy!.id, undefined],
      ['https://c.example/', copy!.id, undefined],
    ]);
    expect((await sara.db.sessions.get(tabs[0]!.sessionId))!.name).toBe('From Truewidgets');
    // Nothing of the team's is left here; the owner still has everything.
    expect(await sara.db.sessions.filter((s) => s.deviceId === teamDeviceId(teamId)).count()).toBe(0);
    expect((await sara.db.folders.toArray()).filter((f) => f.teamId)).toEqual([]);
    await owner.sync();
    expect(await owner.teamUrls()).toHaveLength(3);
  });

  it('after leaving without keeping a copy, nothing of the team’s is left here', async () => {
    const folder = await owner.newFolder('Client sites');
    await owner.share(await owner.fold(['https://a.example/']), folder);
    await settle(owner, sara);
    await takeTeamOut(teamId, clock, sara.db);
    await purgeTeam(teamId, sara.db);
    expect(await sara.db.tabs.count()).toBe(0);
    expect(await sara.db.folders.count()).toBe(0);
    expect(await sara.db.sessions.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('moving tabs in and out of team folders (commands)', () => {
  let teamId: string;
  let folder: FolderRecord;

  beforeEach(async () => {
    teamId = await buyTeam();
    await useToken(OWNER_KEY);
    data(await route({ type: 'plan-refresh', force: true }));
    folder = data<{ folder: FolderRecord }>(await route({ type: 'folder-create', name: 'Client sites', teamId })).folder;
  });

  const foldHere = async (urls: string[], incognito = false) => {
    const saved = await saveCapture([capturedWindow(urls)], { source: 'save-all', deviceId: 'device-here', now: Date.now() }, { dedupe: false });
    if (incognito) await db.tabs.where('id').anyOf(saved.savedTabIds).modify({ incognito: true });
    return saved.savedTabIds;
  };

  it('into a team folder shares it (it leaves the person’s list); Undo puts it back as it was', async () => {
    const [id] = await foldHere(['https://client.example/']);
    const original = (await db.tabs.get(id!))!;
    const moved = data<{ moved: number; actionId: string }>(await route({ type: 'tabs-move', tabRecordIds: [id!], folderId: folder.id }));
    expect(moved.moved).toBe(1);
    expect(await db.tabs.get(id!)).toBeUndefined();
    const [shared] = await listTeamTabs(teamId);
    expect(shared).toMatchObject({ url: 'https://client.example/', folderId: folder.id, addedBy: OWNER });
    expect(await listPersonalTabs()).toEqual([]);

    expect(data(await route({ type: 'undo', actionId: moved.actionId }))).toEqual({ undone: true });
    expect(await listTeamTabs(teamId)).toEqual([]);
    expect(await db.tabs.get(id!)).toEqual(original);
    expect((await db.sessions.get(original.sessionId))!.deletedAt).toBe(0);
  });

  it('out of a team folder (or into a folder of their own) makes it the person’s again', async () => {
    const [id] = await foldHere(['https://client.example/']);
    data(await route({ type: 'tabs-move', tabRecordIds: [id!], folderId: folder.id }));
    const [shared] = await listTeamTabs(teamId);
    const own = data<{ folder: FolderRecord }>(await route({ type: 'folder-create', name: 'Holiday' })).folder;
    expect(data(await route({ type: 'tabs-move', tabRecordIds: [shared!.id], folderId: own.id }))).toMatchObject({ moved: 1 });
    const [back] = await listPersonalTabs();
    expect(back).toMatchObject({ url: 'https://client.example/', folderId: own.id });
    expect(back!.addedBy).toBeUndefined();
    expect(await listTeamTabs(teamId)).toEqual([]);
  });

  it('a tab folded from Incognito stays on this computer: never into a team folder', async () => {
    const [id] = await foldHere(['https://secret.example/'], true);
    expect(await route({ type: 'tabs-move', tabRecordIds: [id!], folderId: folder.id })).toMatchObject({ ok: false, code: 'incognito' });
    expect(await listPersonalTabs()).toHaveLength(1);
  });

  it('a team’s tab doesn’t snooze (it would hide it from everyone)', async () => {
    const [id] = await foldHere(['https://client.example/']);
    data(await route({ type: 'tabs-move', tabRecordIds: [id!], folderId: folder.id }));
    const [shared] = await listTeamTabs(teamId);
    expect(data(await route({ type: 'snooze', until: Date.now() + 3_600_000, tabRecordIds: [shared!.id] }))).toMatchObject({ snoozed: 0 });
  });

  it('deleting a team folder removes its tabs for the team; Undo brings both back', async () => {
    const ids = await foldHere(['https://a.example/', 'https://b.example/']);
    data(await route({ type: 'tabs-move', tabRecordIds: ids, folderId: folder.id }));
    const deleted = data<{ tabs: number; actionId: string }>(await route({ type: 'folder-delete', id: folder.id }));
    expect(deleted.tabs).toBe(2);
    expect(await listTeamTabs(teamId)).toEqual([]);
    expect((await listLiveFolders()).filter((f) => f.teamId)).toEqual([]);
    data(await route({ type: 'undo', actionId: deleted.actionId }));
    expect(await listTeamTabs(teamId)).toHaveLength(2);
    expect((await listLiveFolders()).find((f) => f.id === folder.id)).toMatchObject({ teamId });
  });

  it('team folders and tabs count toward no Free limit', async () => {
    const ids = await foldHere(['https://a.example/', 'https://b.example/']);
    data(await route({ type: 'tabs-move', tabRecordIds: ids, folderId: folder.id }));
    expect(await countFoldedTabs()).toBe(0);
    for (const name of ['One', 'Two', 'Three']) await addFolder({ name }, { unlimited: false });
    await expect(addFolder({ name: 'Four' }, { unlimited: false })).rejects.toMatchObject({ code: 'folder-limit' });
    await expect(addFolder({ name: 'Team two', teamId }, { unlimited: false })).resolves.toMatchObject({ teamId });
    expect((await listRoom({ tier: 'free' })).tabs).toBe(0);
  });

  it('“Make room” and duplicates leave the team’s tabs alone', async () => {
    const ids = await foldHere(['https://same.example/', 'https://same.example/']);
    data(await route({ type: 'tabs-move', tabRecordIds: [ids[0]!], folderId: folder.id }));
    expect(data<{ groups: unknown[] }>(await route({ type: 'duplicates-list' })).groups).toEqual([]);
    const room = data<{ folds: Array<{ name: string }> }>(await route({ type: 'room-list' }));
    expect(room.folds.map((f) => f.name)).not.toContain('Team · Truewidgets');
  });
});

describe('when the person is no longer in the team', () => {
  let teamId: string;

  beforeEach(async () => {
    teamId = await buyTeam();
    await join(SARA_KEY, SARA);
    await useToken(SARA_KEY);
    data(await route({ type: 'plan-refresh', force: true }));
    const folder = data<{ folder: FolderRecord }>(await route({ type: 'folder-create', name: 'Client sites', teamId })).folder;
    const saved = await saveCapture([capturedWindow(['https://client.example/'])], { source: 'save-all', deviceId: 'device-sara', now: Date.now() }, { dedupe: false });
    data(await route({ type: 'tabs-move', tabRecordIds: saved.savedTabIds, folderId: folder.id }));
  });

  const removedByOwner = async () => {
    const sara = server.store.account(SARA).id;
    await server.request('DELETE', `/team/members/${sara}`, { key: OWNER_KEY });
    data(await route({ type: 'plan-refresh', force: true }));
  };

  it('removed: its folders leave the list, and the full list asks once; “Keep a copy” keeps them', async () => {
    await removedByOwner();
    expect((await planState.get()).team).toBeUndefined();
    await checkTeams();
    expect(await teamGone.get()).toEqual([
      { teamId, name: 'Truewidgets', reason: 'left', at: expect.any(Number), folders: 1, tabs: 1 },
    ]);
    expect((await listLiveFolders()).filter((f) => f.teamId)).toEqual([]);
    expect(await listFoldedTabs()).toEqual([]);
    // Asked once: checking again changes nothing.
    await checkTeams();
    expect(await teamGone.get()).toHaveLength(1);

    expect(data(await route({ type: 'team-keep-copy', teamId }))).toEqual({ folders: 1, tabs: 1 });
    expect(await teamGone.get()).toEqual([]);
    expect((await listLiveFolders()).map((f) => [f.name, f.teamId])).toEqual([['Client sites', undefined]]);
    expect((await listPersonalTabs()).map((t) => t.url)).toEqual(['https://client.example/']);
  });

  it('left, then dismissed: nothing of the team’s is left here', async () => {
    data(await route({ type: 'team-leave' }));
    expect(await teamGone.get()).toMatchObject([{ teamId, reason: 'left' }]);
    expect(data(await route({ type: 'team-gone-dismiss', teamId }))).toEqual({ ok: true });
    expect(await teamGone.get()).toEqual([]);
    expect(await db.tabs.count()).toBe(0);
    expect(await db.folders.count()).toBe(0);
  });

  it('the team’s plan ended: the same question, saying so', async () => {
    const owner = server.store.teamOfEmail(OWNER)!;
    await server.stripe.setSubscription(owner.subscriptionId!, { status: 'canceled', ended_at: Math.floor(Date.now() / 1000) }, { event: 'customer.subscription.deleted' });
    await server.deliverEvents();
    data(await route({ type: 'plan-refresh', force: true }));
    await checkTeams();
    expect(await teamGone.get()).toMatchObject([{ teamId, name: 'Truewidgets', reason: 'ended' }]);
  });

  it('signing out: the team’s folders leave quietly (they come back with the team’s copy)', async () => {
    // Only the team's fold is here (the fold its tab came from is gone).
    await db.sessions.filter((s) => s.deviceId !== teamDeviceId(teamId)).delete();
    await refreshDataGuard();
    data(await route({ type: 'signout' }));
    await checkTeams();
    expect(await teamGone.get()).toEqual([]);
    expect(await db.folders.count()).toBe(0);
    expect(await db.tabs.count()).toBe(0);
    // Only the team's fold was here: an emptied list isn't taken for one erased from outside.
    expect((await checkWiped()).wiped).toBe(false);
  });

  it('back in the team while the question waits: the question goes, the team’s copy comes back', async () => {
    data(await route({ type: 'team-sync-now' }));
    await removedByOwner();
    await checkTeams();
    expect(await teamGone.get()).toHaveLength(1);
    await join(SARA_KEY, SARA);
    data(await route({ type: 'plan-refresh', force: true }));
    await checkTeams();
    expect(await teamGone.get()).toEqual([]);
    expect(data(await route({ type: 'team-sync-now' }))).toEqual({ ok: true });
    expect((await listTeamTabs(teamId)).map((t) => t.url)).toEqual(['https://client.example/']);
    expect((await listLiveFolders()).map((f) => [f.name, f.teamId])).toEqual([['Client sites', teamId]]);
  });
});

describe('team-sync-now', () => {
  it('pulls the team’s folders onto this computer, and sends what changed here', async () => {
    const teamId = await buyTeam();
    await join(SARA_KEY, SARA);
    const owner = new Member('owner', OWNER_KEY, OWNER, teamId);
    const folder = await owner.newFolder('Client sites');
    await owner.share(await owner.fold(['https://a.example/', 'https://b.example/']), folder);
    await owner.sync();

    // This computer is Sara's.
    await useToken(SARA_KEY);
    data(await route({ type: 'plan-refresh', force: true }));
    expect(data(await route({ type: 'team-sync-now' }))).toEqual({ ok: true });
    expect((await listTeamTabs(teamId)).map((t) => [t.url, t.addedBy]).sort()).toEqual([
      ['https://a.example/', OWNER],
      ['https://b.example/', OWNER],
    ]);
    expect((await listLiveFolders()).map((f) => [f.name, f.teamId])).toEqual([['Client sites', teamId]]);

    // Sara adds a tab here; the owner sees it.
    const saved = await saveCapture([capturedWindow(['https://c.example/'])], { source: 'save-all', deviceId: 'device-sara', now: Date.now() }, { dedupe: false });
    data(await route({ type: 'tabs-move', tabRecordIds: saved.savedTabIds, folderId: folder.id }));
    expect(data(await route({ type: 'team-sync-now' }))).toEqual({ ok: true });
    await owner.sync();
    expect(await owner.teamUrls()).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
    expect((await owner.teamTabs()).find((t) => t.url === 'https://c.example/')!.addedBy).toBe(SARA);
  });

  it('a team route failing says why in people’s words', () => {
    expect(new ProError('owner-only').message).toBe('Only the team’s owner can do this.');
    expect(new ProError('not-in-team').message).toBe('You’re not in a team.');
  });
});
