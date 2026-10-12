import { isLive, type Purchase, type Subscription, type TeamRole } from '../../server/supabase/functions/_shared/plan.ts';
import {
  RUN_LIMIT_REACHED,
  SYNC_CONFLICT,
  SYNC_TOO_LARGE,
  type Account,
  type Backup,
  type BackupInfo,
  type DeviceKind,
  type PendingCheckout,
  type PublicShare,
  type ShareContent,
  type ShareRecord,
  type SigninCode,
  type Store,
  type TeamInvite,
  type TeamMember,
  type TeamMembership,
  type TeamRecord,
  type UsageKind,
} from '../../server/supabase/functions/tabfold/app.ts';

/**
 * An in-memory Store for the server tests and the end-to-end Pro test (e2e/pro.mjs), with no
 * test-runner imports so plain Node can load it. Behaves like the SQL in server/supabase/migrations,
 * including its atomic functions (sync and team sync writes, team creation and joining, share
 * views, deleting an account, the trial fingerprints, pruning ended teams' folders). Times come from `now` (default Date.now), as the database's `now()` would.
 */

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (text: string) => new TextEncoder().encode(text).length;

export interface MemoryStoreOptions {
  now?: () => number;
}

export interface DeviceRow {
  accountId: string;
  kind: DeviceKind;
  createdAt: number;
  lastSeenAt: number;
}

export interface TeamMemberRow {
  teamId: string;
  role: TeamRole;
  joinedAt: number;
}

type SyncState = { version: number; items: Record<string, unknown> };

/** `tabfold_sync_write` and `tabfold_team_sync_write`: a compare-and-set write, or a code. */
function casWrite(
  map: Map<string, SyncState>,
  key: string,
  baseVersion: number,
  set: Record<string, unknown>,
  remove: string[],
  maxBytes: number,
): number {
  const state = map.get(key) ?? { version: 0, items: {} };
  if (state.version !== baseVersion) return SYNC_CONFLICT;
  const next = { ...state.items };
  for (const item of remove) delete next[item];
  Object.assign(next, copy(set));
  let total = 0;
  for (const [item, value] of Object.entries(next)) total += bytes(item) + bytes(JSON.stringify(value));
  if (total > maxBytes) return SYNC_TOO_LARGE;
  map.set(key, { version: state.version + 1, items: next });
  return state.version + 1;
}

export class MemoryStore implements Store {
  now: () => number;
  /** By id. */
  accounts = new Map<string, Account>();
  /** By token hash. */
  devices = new Map<string, DeviceRow>();
  /** By email. */
  codes = new Map<string, SigninCode>();
  rates = new Map<string, { windowStart: number; count: number }>();
  subscriptions = new Map<string, { accountId: string; subscription: Subscription }>();
  pending = new Map<string, PendingCheckout>();
  events = new Set<string>();
  sync = new Map<string, SyncState>();
  backups = new Map<string, Map<string, Backup>>();
  usage = new Map<string, { runs: number; light: number }>();
  /** One-time purchases (Pro for life), by id. */
  purchases = new Map<string, { accountId: string; purchase: Purchase }>();
  /** By id. */
  teams = new Map<string, TeamRecord>();
  /** By account id: an account is in one team at most. */
  teamMembersByAccount = new Map<string, TeamMemberRow>();
  /** By `<team id>|<email>`. */
  teamInviteRows = new Map<string, { teamId: string; email: string; invitedAt: number }>();
  /** By team id. */
  teamSync = new Map<string, SyncState>();
  /** By id. */
  shares = new Map<string, ShareRecord>();
  /** `trial_used`: the trial fingerprints of emails that had a trial (kept after accounts are deleted). */
  trialHashes = new Set<string>();
  private seq = 0;
  private accountSeq = 0;

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  // ---- Accounts ----

  /** The account for an email, synchronously (for setting up tests). */
  account(email: string): Account {
    for (const account of this.accounts.values()) if (account.email === email) return account;
    const account: Account = {
      // Numbered in the order they were made: never reused, even after an account is deleted.
      id: `account-${++this.accountSeq}`,
      email,
      stripeCustomerId: null,
      trialStartedAt: null,
      emailVerifiedAt: null,
      createdAt: this.now(),
    };
    this.accounts.set(account.id, account);
    return account;
  }

  async accountByEmail(email: string) {
    return copy(this.account(email));
  }

  async accountById(id: string) {
    const account = this.accounts.get(id);
    return account ? copy(account) : null;
  }

  async accountByCustomer(customerId: string) {
    for (const account of this.accounts.values()) if (account.stripeCustomerId === customerId) return copy(account);
    for (const { accountId, subscription } of this.subscriptions.values()) {
      if (subscription.customerId === customerId) return this.accountById(accountId);
    }
    return null;
  }

  async setCustomer(account: string, customerId: string) {
    const row = this.accounts.get(account);
    const taken = [...this.accounts.values()].some((other) => other.stripeCustomerId === customerId);
    if (row && row.stripeCustomerId === null && !taken) row.stripeCustomerId = customerId;
  }

  async startTrial(account: string, trialHash: string) {
    const row = this.accounts.get(account);
    if (!row || row.trialStartedAt !== null || this.trialHashes.has(trialHash)) return false;
    row.trialStartedAt = this.now();
    this.trialHashes.add(trialHash);
    return true;
  }

  async trialUsed(trialHash: string) {
    return this.trialHashes.has(trialHash);
  }

  async verifyEmail(account: string) {
    const row = this.accounts.get(account);
    if (!row || row.emailVerifiedAt !== null) return false;
    row.emailVerifiedAt = this.now();
    for (const [hash, device] of [...this.devices]) if (device.accountId === account) this.devices.delete(hash);
    return true;
  }

  // ---- Devices ----

  async accountForToken(tokenHash: string, kind: DeviceKind) {
    const device = this.devices.get(tokenHash);
    if (!device || device.kind !== kind) return null;
    device.lastSeenAt = this.now();
    return this.accountById(device.accountId);
  }

  async link(tokenHash: string, account: string, kind: DeviceKind) {
    const now = this.now();
    const existing = this.devices.get(tokenHash);
    this.devices.set(tokenHash, { accountId: account, kind, createdAt: existing?.createdAt ?? now, lastSeenAt: now });
  }

  async unlink(tokenHash: string) {
    if (this.devices.get(tokenHash)?.kind === 'device') this.devices.delete(tokenHash);
  }

  // ---- Codes ----

  async codeGet(email: string) {
    const code = this.codes.get(email);
    return code ? { ...code } : null;
  }

  async codePut(email: string, codeHash: string, expiresAt: number) {
    this.codes.set(email, { codeHash, expiresAt, attempts: 0 });
  }

  async codeAttempt(email: string) {
    const code = this.codes.get(email);
    if (!code) return null;
    code.attempts += 1;
    return code.attempts;
  }

  async codeDelete(email: string) {
    this.codes.delete(email);
  }

  async rateTake(key: string, limit: number, windowSeconds: number) {
    const now = this.now();
    const windowMs = windowSeconds * 1000;
    let row = this.rates.get(key);
    if (!row || row.windowStart <= now - windowMs) {
      row = { windowStart: now, count: 0 };
      this.rates.set(key, row);
    }
    row.count += 1;
    if (row.count <= limit) return 0;
    return Math.max(1, Math.ceil((row.windowStart + windowMs - now) / 1000));
  }

  // ---- Subscriptions and checkouts ----

  async subscriptionPut(account: string, subscription: Subscription) {
    this.subscriptions.set(subscription.id, { accountId: account, subscription: copy(subscription) });
  }

  async subscriptionList(account: string) {
    return [...this.subscriptions.values()].filter((row) => row.accountId === account).map((row) => copy(row.subscription));
  }

  async subscriptionGet(id: string) {
    const row = this.subscriptions.get(id);
    return row ? copy(row.subscription) : null;
  }

  async purchasePut(account: string, purchase: Purchase) {
    if (!this.purchases.has(purchase.id)) this.purchases.set(purchase.id, { accountId: account, purchase: copy(purchase) });
  }

  async purchaseList(account: string) {
    return [...this.purchases.values()].filter((row) => row.accountId === account).map((row) => copy(row.purchase));
  }

  async pendingPut(sessionId: string, tokenHash: string) {
    this.pending.set(sessionId, { sessionId, tokenHash, createdAt: this.now(), signInEmail: null });
  }

  async pendingList(tokenHash: string, since: number, limit: number) {
    return [...this.pending.values()]
      .filter((row) => row.tokenHash === tokenHash && row.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async pendingGet(sessionId: string) {
    const row = this.pending.get(sessionId);
    return row ? { ...row } : null;
  }

  async pendingSignIn(sessionId: string, email: string) {
    const row = this.pending.get(sessionId);
    if (row) row.signInEmail = email;
  }

  async pendingDelete(sessionId: string) {
    this.pending.delete(sessionId);
  }

  async stripeEventNew(id: string) {
    if (this.events.has(id)) return false;
    this.events.add(id);
    return true;
  }

  async stripeEventForget(id: string) {
    this.events.delete(id);
  }

  // ---- Sync, backups, AI ----

  async syncRead(account: string) {
    const state = this.sync.get(account);
    return { items: copy(state?.items ?? {}), version: state?.version ?? 0 };
  }

  async syncWrite(account: string, baseVersion: number, set: Record<string, unknown>, remove: string[], maxBytes: number) {
    return casWrite(this.sync, account, baseVersion, set, remove, maxBytes);
  }

  async syncVersion(account: string) {
    return this.sync.get(account)?.version ?? 0;
  }

  private backupsOf(account: string) {
    let map = this.backups.get(account);
    if (!map) this.backups.set(account, (map = new Map()));
    return map;
  }

  async backupExists(account: string, day: string) {
    return this.backupsOf(account).has(day);
  }

  async backupPut(account: string, backup: Backup) {
    const map = this.backupsOf(account);
    if (!map.has(backup.day)) map.set(backup.day, copy(backup));
  }

  async backupList(account: string): Promise<BackupInfo[]> {
    return [...this.backupsOf(account).values()]
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .map(({ day, tabCount, createdAt }) => ({ day, tabCount, createdAt }));
  }

  async backupGet(account: string, day: string) {
    const backup = this.backupsOf(account).get(day);
    return backup ? { day, items: copy(backup.items) } : null;
  }

  async backupPrune(account: string, beforeDay: string) {
    const map = this.backupsOf(account);
    for (const day of [...map.keys()]) if (day < beforeDay) map.delete(day);
  }

  async backupPruneAll(beforeDay: string) {
    for (const account of this.backups.keys()) await this.backupPrune(account, beforeDay);
  }

  async aiUsage(account: string, month: string) {
    return { ...(this.usage.get(`${account}|${month}`) ?? { runs: 0, light: 0 }) };
  }

  async takeRun(account: string, month: string, kind: UsageKind, limit: number) {
    const key = `${account}|${month}`;
    const row = this.usage.get(key) ?? { runs: 0, light: 0 };
    this.usage.set(key, row);
    if (row[kind] >= limit) return RUN_LIMIT_REACHED;
    row[kind] += 1;
    return row[kind];
  }

  // ---- Teams ----

  private nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async teamCreate(owner: string, name: string, subscriptionId: string) {
    for (const team of this.teams.values()) if (team.subscriptionId === subscriptionId) return team.id;
    for (const team of this.teams.values()) {
      if (team.ownerId === owner) {
        team.subscriptionId = subscriptionId;
        team.name = name;
        return team.id;
      }
    }
    const team: TeamRecord = { id: this.nextId('team'), name, ownerId: owner, subscriptionId, createdAt: this.now() };
    this.teams.set(team.id, team);
    // Leaves a team it was a member of: one team per account.
    this.teamMembersByAccount.set(owner, { teamId: team.id, role: 'owner', joinedAt: this.now() });
    return team.id;
  }

  async teamOf(account: string): Promise<TeamMembership | null> {
    const row = this.teamMembersByAccount.get(account);
    const team = row && this.teams.get(row.teamId);
    return row && team ? { team: copy(team), role: row.role, joinedAt: row.joinedAt } : null;
  }

  async teamGet(team: string) {
    const row = this.teams.get(team);
    return row ? copy(row) : null;
  }

  async teamRename(team: string, name: string) {
    const row = this.teams.get(team);
    if (row) row.name = name;
  }

  async teamMembers(team: string): Promise<TeamMember[]> {
    return [...this.teamMembersByAccount]
      .filter(([, row]) => row.teamId === team)
      .map(([accountId, row]) => ({ id: accountId, email: this.accounts.get(accountId)?.email ?? '', role: row.role, joinedAt: row.joinedAt }))
      .sort((a, b) => (a.role === b.role ? a.joinedAt - b.joinedAt : a.role === 'owner' ? -1 : 1));
  }

  async teamInvites(team: string): Promise<TeamInvite[]> {
    return [...this.teamInviteRows.values()]
      .filter((row) => row.teamId === team)
      .sort((a, b) => a.invitedAt - b.invitedAt)
      .map(({ email, invitedAt }) => ({ email, invitedAt }));
  }

  async teamInvitePut(team: string, email: string) {
    const key = `${team}|${email}`;
    if (this.teamInviteRows.has(key)) return false;
    this.teamInviteRows.set(key, { teamId: team, email, invitedAt: this.now() });
    return true;
  }

  async teamInviteDelete(team: string, email: string) {
    return this.teamInviteRows.delete(`${team}|${email}`);
  }

  async teamInvitesFor(email: string) {
    return [...this.teamInviteRows.values()]
      .filter((row) => row.email === email)
      .sort((a, b) => a.invitedAt - b.invitedAt)
      .map((row) => row.teamId);
  }

  async teamJoin(team: string, account: string, email: string) {
    if (this.teamMembersByAccount.has(account)) return false;
    if (!this.teamInviteRows.delete(`${team}|${email}`)) return false;
    this.teamMembersByAccount.set(account, { teamId: team, role: 'member', joinedAt: this.now() });
    return true;
  }

  async teamLeave(team: string, account: string) {
    const row = this.teamMembersByAccount.get(account);
    if (!row || row.teamId !== team || row.role !== 'member') return false;
    this.teamMembersByAccount.delete(account);
    return true;
  }

  async teamSyncRead(team: string) {
    const state = this.teamSync.get(team);
    return { items: copy(state?.items ?? {}), version: state?.version ?? 0 };
  }

  async teamSyncWrite(team: string, baseVersion: number, set: Record<string, unknown>, remove: string[], maxBytes: number) {
    return casWrite(this.teamSync, team, baseVersion, set, remove, maxBytes);
  }

  async teamSyncVersion(team: string) {
    return this.teamSync.get(team)?.version ?? 0;
  }

  // ---- Shared folders ----

  async shareCreate(id: string, account: string, content: ShareContent) {
    if (this.shares.has(id)) return false;
    const now = this.now();
    this.shares.set(id, { ...copy(content), id, accountId: account, views: 0, createdAt: now, updatedAt: now });
    return true;
  }

  async shareGet(id: string) {
    const share = this.shares.get(id);
    return share ? copy(share) : null;
  }

  async shareUpdate(id: string, account: string, content: ShareContent) {
    const share = this.shares.get(id);
    if (!share || share.accountId !== account) return null;
    Object.assign(share, copy(content), { updatedAt: this.now() });
    return copy(share);
  }

  async shareDelete(id: string, account: string) {
    if (this.shares.get(id)?.accountId !== account) return false;
    return this.shares.delete(id);
  }

  async shareCount(account: string) {
    return [...this.shares.values()].filter((share) => share.accountId === account).length;
  }

  async shareView(id: string): Promise<PublicShare | null> {
    const share = this.shares.get(id);
    if (!share) return null;
    share.views += 1;
    return { name: share.name, color: share.color, tabs: copy(share.tabs), updatedAt: share.updatedAt, note: share.note ?? '' };
  }

  // ---- Deleting an account ----

  /** `tabfold_account_delete`: the account and everything kept for it, as the database's cascades do. */
  async accountDelete(account: string, trialHash: string) {
    const row = this.accounts.get(account);
    if (!row) return false;
    // An account that had a trial leaves its email's fingerprint behind (trials from before 1.0 too).
    if (row.trialStartedAt !== null) this.trialHashes.add(trialHash);
    const tokens = new Set<string>();
    for (const [hash, device] of [...this.devices]) {
      if (device.accountId !== account) continue;
      tokens.add(hash);
      this.devices.delete(hash);
    }
    for (const [id, pending] of [...this.pending]) {
      if (tokens.has(pending.tokenHash) || pending.signInEmail === row.email) this.pending.delete(id);
    }
    this.codes.delete(row.email);
    for (const [id, sub] of [...this.subscriptions]) if (sub.accountId === account) this.subscriptions.delete(id);
    for (const [id, purchase] of [...this.purchases]) if (purchase.accountId === account) this.purchases.delete(id);
    this.sync.delete(account);
    this.backups.delete(account);
    for (const key of [...this.usage.keys()]) if (key.startsWith(`${account}|`)) this.usage.delete(key);
    for (const [id, share] of [...this.shares]) if (share.accountId === account) this.shares.delete(id);
    // A team it owns ends: its people, invitations and folders go with it.
    for (const [teamId, team] of [...this.teams]) {
      if (team.ownerId !== account) continue;
      this.teams.delete(teamId);
      this.teamSync.delete(teamId);
      for (const [member, membership] of [...this.teamMembersByAccount]) if (membership.teamId === teamId) this.teamMembersByAccount.delete(member);
      for (const [key, invite] of [...this.teamInviteRows]) if (invite.teamId === teamId) this.teamInviteRows.delete(key);
    }
    this.teamMembersByAccount.delete(account);
    this.accounts.delete(account);
    return true;
  }

  /** `tabfold_team_sync_prune`: empties the folders of teams whose subscription ended before then. */
  async teamSyncPruneEnded(endedBefore: number) {
    let emptied = 0;
    for (const team of this.teams.values()) {
      const subscription = team.subscriptionId ? this.subscriptions.get(team.subscriptionId)?.subscription : undefined;
      if (!subscription || isLive(subscription)) continue;
      const endedAt = subscription.endedAt ?? subscription.cancelAt ?? subscription.currentPeriodEnd;
      if (typeof endedAt !== 'number' || endedAt >= endedBefore) continue;
      if (this.teamSync.delete(team.id)) emptied += 1;
    }
    return emptied;
  }

  // ---- Test helpers ----

  /** The team an email's account is in (test set-up and checks), or null. */
  teamOfEmail(email: string): TeamRecord | null {
    const account = [...this.accounts.values()].find((a) => a.email === email);
    const row = account && this.teamMembersByAccount.get(account.id);
    return row ? (this.teams.get(row.teamId) ?? null) : null;
  }

  /** The account a device token's hash is linked to (any kind), or null. */
  linkedAccount(tokenHash: string): Account | null {
    const device = this.devices.get(tokenHash);
    return device ? (this.accounts.get(device.accountId) ?? null) : null;
  }

  /** Usage for an email this month (or the month given). */
  async usageOf(email: string, month = '2026-10') {
    return this.aiUsage(this.account(email).id, month);
  }

  async setUsage(email: string, usage: { runs?: number; light?: number }, month = '2026-10') {
    this.usage.set(`${this.account(email).id}|${month}`, { runs: 0, light: 0, ...usage });
  }
}
