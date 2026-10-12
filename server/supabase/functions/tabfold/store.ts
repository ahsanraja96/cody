// The Store on Supabase Postgres (Deno only; tests use an in-memory Store). The tables and SQL
// functions are in server/supabase/migrations (0.6: purchases, teams and their folders, shares;
// 1.0: a shared folder's note, deleting an account).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { Purchase, Subscription, TeamRole } from '../_shared/plan.ts';
import type {
  Account,
  Backup,
  BackupInfo,
  DeviceKind,
  PendingCheckout,
  PublicShare,
  ShareContent,
  ShareRecord,
  Store,
  TeamInvite,
  TeamMember,
  TeamMembership,
  TeamRecord,
  UsageKind,
} from './app.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_COLUMNS = 'id, email, stripe_customer_id, trial_started_at, email_verified_at, created_at';
const SUBSCRIPTION_COLUMNS =
  'id, customer_id, status, lookup_key, interval, current_period_end, cancel_at, cancel_at_period_end, trial_end, created_at, quantity, item_id, ended_at';
const TEAM_COLUMNS = 'id, name, owner_id, subscription_id, created_at';
const SHARE_COLUMNS = 'id, account_id, name, color, tabs, live, views, created_at, updated_at, note';
/** Postgres' code for a duplicate key. */
const DUPLICATE = '23505';

interface DbError {
  code?: string;
  message: string;
}

interface AccountRow {
  id: string;
  email: string;
  stripe_customer_id: string | null;
  trial_started_at: string | null;
  email_verified_at: string | null;
  created_at: string;
}

interface SubscriptionRow {
  id: string;
  customer_id: string;
  status: string;
  lookup_key: string | null;
  interval: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean;
  trial_end: string | null;
  created_at: string;
  quantity: number | null;
  item_id: string | null;
  ended_at: string | null;
}

interface PurchaseRow {
  id: string;
  lookup_key: string;
  customer_id: string | null;
  payment_intent_id: string | null;
  created_at: string;
}

interface TeamRow {
  id: string;
  name: string;
  owner_id: string;
  subscription_id: string | null;
  created_at: string;
}

interface ShareRow {
  id: string;
  account_id: string;
  name: string;
  color: string;
  tabs: { title: string; url: string }[];
  live: boolean;
  views: number | string;
  created_at: string;
  updated_at: string;
  note: string | null;
}

interface PendingRow {
  session_id: string;
  token_hash: string;
  created_at: string;
  signin_email: string | null;
}

/** Database errors as plain Errors: a code and message, never the row's data. */
function check<T>(result: { data: T; error: DbError | null }, what: string): T {
  if (result.error) throw new Error(`Database (${what}): ${result.error.code ?? ''} ${result.error.message}`);
  return result.data;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const time = (value: string | null) => (value === null ? null : Date.parse(value));

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    stripeCustomerId: row.stripe_customer_id,
    trialStartedAt: time(row.trial_started_at),
    emailVerifiedAt: time(row.email_verified_at),
    createdAt: Date.parse(row.created_at),
  };
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    lookupKey: row.lookup_key,
    interval: row.interval === 'month' || row.interval === 'year' ? row.interval : null,
    currentPeriodEnd: time(row.current_period_end),
    cancelAt: time(row.cancel_at),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    trialEnd: time(row.trial_end),
    createdAt: Date.parse(row.created_at),
    quantity: row.quantity ?? 1,
    itemId: row.item_id,
    endedAt: time(row.ended_at),
  };
}

function toPurchase(row: PurchaseRow): Purchase {
  return {
    id: row.id,
    lookupKey: row.lookup_key,
    customerId: row.customer_id,
    paymentIntentId: row.payment_intent_id,
    createdAt: Date.parse(row.created_at),
  };
}

function toTeam(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    subscriptionId: row.subscription_id,
    createdAt: Date.parse(row.created_at),
  };
}

function toShare(row: ShareRow): ShareRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    color: row.color,
    tabs: row.tabs ?? [],
    live: row.live,
    views: Number(row.views),
    createdAt: Date.parse(row.created_at),
    updatedAt: Date.parse(row.updated_at),
    note: row.note ?? '',
  };
}

const shareColumns = (content: ShareContent) => ({
  name: content.name,
  color: content.color,
  tabs: content.tabs,
  live: content.live,
  note: content.note ?? '',
});

function toPending(row: PendingRow): PendingCheckout {
  return {
    sessionId: row.session_id,
    tokenHash: row.token_hash,
    createdAt: Date.parse(row.created_at),
    signInEmail: row.signin_email,
  };
}

export function createSupabaseStore(db: SupabaseClient): Store {
  async function accountById(id: string): Promise<Account | null> {
    if (!UUID.test(id)) return null;
    const result = await db.from('accounts').select(ACCOUNT_COLUMNS).eq('id', id).maybeSingle();
    const row = check(result, 'account by id') as AccountRow | null;
    return row ? toAccount(row) : null;
  }

  return {
    async accountByEmail(email: string): Promise<Account> {
      const id = check(await db.rpc('tabfold_account', { p_email: email }), 'account') as string;
      const account = await accountById(id);
      if (!account) throw new Error('Database (account): the new account is missing');
      return account;
    },

    accountById,

    async accountByCustomer(customerId: string): Promise<Account | null> {
      const result = await db.from('accounts').select(ACCOUNT_COLUMNS).eq('stripe_customer_id', customerId).maybeSingle();
      const row = check(result, 'account by customer') as AccountRow | null;
      if (row) return toAccount(row);
      const sub = await db.from('subscriptions').select('account_id').eq('customer_id', customerId).limit(1).maybeSingle();
      const found = check(sub, 'account by subscription customer') as { account_id: string } | null;
      return found ? accountById(found.account_id) : null;
    },

    async setCustomer(account: string, customerId: string): Promise<void> {
      const result = await db
        .from('accounts')
        .update({ stripe_customer_id: customerId })
        .eq('id', account)
        .is('stripe_customer_id', null);
      // Another account already has this customer: keep things as they are.
      if (result.error?.code === '23505') return;
      check(result, 'set customer');
    },

    async startTrial(account: string): Promise<boolean> {
      return check(await db.rpc('tabfold_start_trial', { p_account: account }), 'start trial') === true;
    },

    async verifyEmail(account: string): Promise<boolean> {
      return check(await db.rpc('tabfold_verify_email', { p_account: account }), 'verify email') === true;
    },

    async accountForToken(tokenHash: string, kind: DeviceKind): Promise<Account | null> {
      const result = await db
        .from('devices')
        .select(`last_seen_at, accounts (${ACCOUNT_COLUMNS})`)
        .eq('token_hash', tokenHash)
        .eq('kind', kind)
        .maybeSingle();
      const row = check(result, 'device') as unknown as { last_seen_at: string; accounts: AccountRow | null } | null;
      if (!row?.accounts) return null;
      // Noted at most hourly, so most requests stay a single read.
      if (Date.now() - Date.parse(row.last_seen_at) > HOUR_MS) {
        const touch = await db.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('token_hash', tokenHash);
        check(touch, 'device seen');
      }
      return toAccount(row.accounts);
    },

    async link(tokenHash: string, account: string, kind: DeviceKind): Promise<void> {
      const result = await db
        .from('devices')
        .upsert(
          { token_hash: tokenHash, account_id: account, kind, last_seen_at: new Date().toISOString() },
          { onConflict: 'token_hash' },
        );
      check(result, 'link');
    },

    async unlink(tokenHash: string): Promise<void> {
      check(await db.from('devices').delete().eq('token_hash', tokenHash).eq('kind', 'device'), 'unlink');
    },

    async codeGet(email: string) {
      const result = await db.from('signin_codes').select('code_hash, expires_at, attempts').eq('email', email).maybeSingle();
      const row = check(result, 'code get') as { code_hash: string; expires_at: string; attempts: number } | null;
      return row ? { codeHash: row.code_hash, expiresAt: Date.parse(row.expires_at), attempts: row.attempts } : null;
    },

    async codePut(email: string, codeHash: string, expiresAt: number): Promise<void> {
      const result = await db.from('signin_codes').upsert(
        { email, code_hash: codeHash, expires_at: iso(expiresAt), attempts: 0, created_at: new Date().toISOString() },
        { onConflict: 'email' },
      );
      check(result, 'code put');
      // Codes nobody used: gone a day after they expired.
      const stale = new Date(Date.now() - DAY_MS).toISOString();
      check(await db.from('signin_codes').delete().lt('expires_at', stale), 'code prune');
    },

    async codeAttempt(email: string): Promise<number | null> {
      const attempts = check(await db.rpc('tabfold_code_attempt', { p_email: email }), 'code attempt') as number | null;
      return attempts === null ? null : Number(attempts);
    },

    async codeDelete(email: string): Promise<void> {
      check(await db.from('signin_codes').delete().eq('email', email), 'code delete');
    },

    async rateTake(key: string, limit: number, windowSeconds: number): Promise<number> {
      const result = await db.rpc('tabfold_rate_take', { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
      return Number(check(result, 'rate take'));
    },

    async subscriptionPut(account: string, sub: Subscription): Promise<void> {
      const result = await db.from('subscriptions').upsert(
        {
          id: sub.id,
          account_id: account,
          customer_id: sub.customerId,
          status: sub.status,
          lookup_key: sub.lookupKey,
          interval: sub.interval,
          current_period_end: iso(sub.currentPeriodEnd),
          cancel_at: iso(sub.cancelAt),
          cancel_at_period_end: sub.cancelAtPeriodEnd,
          trial_end: iso(sub.trialEnd),
          created_at: iso(sub.createdAt),
          quantity: sub.quantity ?? 1,
          item_id: sub.itemId ?? null,
          ended_at: iso(sub.endedAt ?? null),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      );
      check(result, 'subscription put');
    },

    async subscriptionList(account: string): Promise<Subscription[]> {
      const result = await db.from('subscriptions').select(SUBSCRIPTION_COLUMNS).eq('account_id', account);
      return (check(result, 'subscription list') as SubscriptionRow[]).map(toSubscription);
    },

    async subscriptionGet(id: string): Promise<Subscription | null> {
      const result = await db.from('subscriptions').select(SUBSCRIPTION_COLUMNS).eq('id', id).maybeSingle();
      const row = check(result, 'subscription get') as SubscriptionRow | null;
      return row ? toSubscription(row) : null;
    },

    async purchasePut(account: string, purchase: Purchase): Promise<void> {
      const result = await db.from('purchases').upsert(
        {
          id: purchase.id,
          account_id: account,
          lookup_key: purchase.lookupKey,
          customer_id: purchase.customerId,
          payment_intent_id: purchase.paymentIntentId,
          created_at: iso(purchase.createdAt),
        },
        { onConflict: 'id', ignoreDuplicates: true },
      );
      check(result, 'purchase put');
    },

    async purchaseList(account: string): Promise<Purchase[]> {
      const result = await db
        .from('purchases')
        .select('id, lookup_key, customer_id, payment_intent_id, created_at')
        .eq('account_id', account);
      return (check(result, 'purchase list') as PurchaseRow[]).map(toPurchase);
    },

    async pendingPut(sessionId: string, tokenHash: string): Promise<void> {
      check(await db.from('pending_checkouts').insert({ session_id: sessionId, token_hash: tokenHash }), 'pending put');
      // Checkouts are only asked about for a day.
      const stale = new Date(Date.now() - 7 * DAY_MS).toISOString();
      check(await db.from('pending_checkouts').delete().lt('created_at', stale), 'pending prune');
    },

    async pendingList(tokenHash: string, since: number, limit: number): Promise<PendingCheckout[]> {
      const result = await db
        .from('pending_checkouts')
        .select('session_id, token_hash, created_at, signin_email')
        .eq('token_hash', tokenHash)
        .gte('created_at', new Date(since).toISOString())
        .order('created_at', { ascending: false })
        .limit(limit);
      return (check(result, 'pending list') as PendingRow[]).map(toPending);
    },

    async pendingGet(sessionId: string): Promise<PendingCheckout | null> {
      const result = await db
        .from('pending_checkouts')
        .select('session_id, token_hash, created_at, signin_email')
        .eq('session_id', sessionId)
        .maybeSingle();
      const row = check(result, 'pending get') as PendingRow | null;
      return row ? toPending(row) : null;
    },

    async pendingSignIn(sessionId: string, email: string): Promise<void> {
      check(await db.from('pending_checkouts').update({ signin_email: email }).eq('session_id', sessionId), 'pending sign-in');
    },

    async pendingDelete(sessionId: string): Promise<void> {
      check(await db.from('pending_checkouts').delete().eq('session_id', sessionId), 'pending delete');
    },

    async stripeEventNew(id: string): Promise<boolean> {
      const result = await db
        .from('stripe_events')
        .upsert({ id }, { onConflict: 'id', ignoreDuplicates: true })
        .select('id');
      const rows = check(result, 'stripe event') as { id: string }[] | null;
      // A month of event ids is plenty to spot Stripe's retries.
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      check(await db.from('stripe_events').delete().lt('received_at', stale), 'stripe event prune');
      return (rows ?? []).length > 0;
    },

    async stripeEventForget(id: string): Promise<void> {
      check(await db.from('stripe_events').delete().eq('id', id), 'stripe event forget');
    },

    async syncRead(account: string) {
      const data = check(await db.rpc('tabfold_sync_read', { p_account: account }), 'sync read') as {
        items: Record<string, unknown>;
        version: number;
      };
      return { items: data.items ?? {}, version: Number(data.version ?? 0) };
    },

    async syncWrite(account, baseVersion, set, remove, maxBytes): Promise<number> {
      const result = await db.rpc('tabfold_sync_write', {
        p_account: account,
        p_base: baseVersion,
        p_set: set,
        p_remove: remove,
        p_max_bytes: maxBytes,
      });
      return Number(check(result, 'sync write'));
    },

    async syncVersion(account: string): Promise<number> {
      const result = await db.from('sync_state').select('version').eq('account_id', account).maybeSingle();
      const row = check(result, 'sync version') as { version: number } | null;
      return Number(row?.version ?? 0);
    },

    async backupExists(account: string, day: string): Promise<boolean> {
      const result = await db.from('backups').select('day').eq('account_id', account).eq('day', day).maybeSingle();
      return check(result, 'backup exists') !== null;
    },

    async backupPut(account: string, backup: Backup): Promise<void> {
      const result = await db.from('backups').upsert(
        {
          account_id: account,
          day: backup.day,
          items: backup.items,
          tab_count: backup.tabCount,
          created_at: new Date(backup.createdAt).toISOString(),
        },
        { onConflict: 'account_id,day', ignoreDuplicates: true },
      );
      check(result, 'backup put');
    },

    async backupList(account: string): Promise<BackupInfo[]> {
      const result = await db
        .from('backups')
        .select('day, tab_count, created_at')
        .eq('account_id', account)
        .order('day', { ascending: false });
      const rows = check(result, 'backup list') as { day: string; tab_count: number; created_at: string }[];
      return rows.map((row) => ({ day: row.day, tabCount: row.tab_count, createdAt: Date.parse(row.created_at) }));
    },

    async backupGet(account: string, day: string) {
      const result = await db.from('backups').select('day, items').eq('account_id', account).eq('day', day).maybeSingle();
      const row = check(result, 'backup get') as { day: string; items: Record<string, unknown> } | null;
      return row ? { day: row.day, items: row.items } : null;
    },

    async backupPrune(account: string, beforeDay: string): Promise<void> {
      check(await db.from('backups').delete().eq('account_id', account).lt('day', beforeDay), 'backup prune');
    },

    async backupPruneAll(beforeDay: string): Promise<void> {
      check(await db.from('backups').delete().lt('day', beforeDay), 'backup prune all');
    },

    async aiUsage(account: string, month: string) {
      const result = await db.from('ai_usage').select('runs, light').eq('account_id', account).eq('month', month).maybeSingle();
      const row = check(result, 'ai usage') as { runs: number; light: number } | null;
      return { runs: row?.runs ?? 0, light: row?.light ?? 0 };
    },

    async takeRun(account: string, month: string, kind: UsageKind, limit: number): Promise<number> {
      const result = await db.rpc('tabfold_take_run', { p_account: account, p_month: month, p_kind: kind, p_limit: limit });
      return Number(check(result, 'take run'));
    },

    // ---- Teams ----

    async teamCreate(owner: string, name: string, subscriptionId: string): Promise<string> {
      const result = await db.rpc('tabfold_team_create', { p_owner: owner, p_name: name, p_subscription: subscriptionId });
      return check(result, 'team create') as string;
    },

    async teamOf(account: string): Promise<TeamMembership | null> {
      if (!UUID.test(account)) return null;
      const result = await db
        .from('team_members')
        .select(`role, joined_at, teams (${TEAM_COLUMNS})`)
        .eq('account_id', account)
        .maybeSingle();
      const row = check(result, 'team of') as unknown as { role: TeamRole; joined_at: string; teams: TeamRow | null } | null;
      if (!row?.teams) return null;
      return { team: toTeam(row.teams), role: row.role, joinedAt: Date.parse(row.joined_at) };
    },

    async teamGet(team: string): Promise<TeamRecord | null> {
      if (!UUID.test(team)) return null;
      const result = await db.from('teams').select(TEAM_COLUMNS).eq('id', team).maybeSingle();
      const row = check(result, 'team get') as TeamRow | null;
      return row ? toTeam(row) : null;
    },

    async teamRename(team: string, name: string): Promise<void> {
      check(await db.from('teams').update({ name }).eq('id', team), 'team rename');
    },

    async teamMembers(team: string): Promise<TeamMember[]> {
      const result = await db
        .from('team_members')
        .select('account_id, role, joined_at, accounts (email)')
        .eq('team_id', team)
        .order('joined_at', { ascending: true });
      const rows = check(result, 'team members') as unknown as {
        account_id: string;
        role: TeamRole;
        joined_at: string;
        accounts: { email: string } | null;
      }[];
      const members = rows.map((row) => ({
        id: row.account_id,
        email: row.accounts?.email ?? '',
        role: row.role,
        joinedAt: Date.parse(row.joined_at),
      }));
      // The owner first; the others stay in the order they joined.
      return [...members.filter((m) => m.role === 'owner'), ...members.filter((m) => m.role !== 'owner')];
    },

    async teamInvites(team: string): Promise<TeamInvite[]> {
      const result = await db
        .from('team_invites')
        .select('email, invited_at')
        .eq('team_id', team)
        .order('invited_at', { ascending: true });
      const rows = check(result, 'team invites') as { email: string; invited_at: string }[];
      return rows.map((row) => ({ email: row.email, invitedAt: Date.parse(row.invited_at) }));
    },

    async teamInvitePut(team: string, email: string): Promise<boolean> {
      const result = await db.from('team_invites').insert({ team_id: team, email });
      if (result.error?.code === DUPLICATE) return false;
      check(result, 'team invite');
      return true;
    },

    async teamInviteDelete(team: string, email: string): Promise<boolean> {
      const result = await db.from('team_invites').delete().eq('team_id', team).eq('email', email).select('email');
      return ((check(result, 'team uninvite') as { email: string }[] | null) ?? []).length > 0;
    },

    async teamInvitesFor(email: string): Promise<string[]> {
      const result = await db
        .from('team_invites')
        .select('team_id')
        .eq('email', email)
        .order('invited_at', { ascending: true });
      return (check(result, 'invites for') as { team_id: string }[]).map((row) => row.team_id);
    },

    async teamJoin(team: string, account: string, email: string): Promise<boolean> {
      const result = await db.rpc('tabfold_team_join', { p_team: team, p_account: account, p_email: email });
      return check(result, 'team join') === true;
    },

    async teamLeave(team: string, account: string): Promise<boolean> {
      // Member ids come from the request: anything that isn't an account id is nobody.
      if (!UUID.test(account)) return false;
      const result = await db
        .from('team_members')
        .delete()
        .eq('team_id', team)
        .eq('account_id', account)
        .eq('role', 'member')
        .select('account_id');
      return ((check(result, 'team leave') as { account_id: string }[] | null) ?? []).length > 0;
    },

    async teamSyncRead(team: string) {
      const data = check(await db.rpc('tabfold_team_sync_read', { p_team: team }), 'team sync read') as {
        items: Record<string, unknown>;
        version: number;
      };
      return { items: data.items ?? {}, version: Number(data.version ?? 0) };
    },

    async teamSyncWrite(team, baseVersion, set, remove, maxBytes): Promise<number> {
      const result = await db.rpc('tabfold_team_sync_write', {
        p_team: team,
        p_base: baseVersion,
        p_set: set,
        p_remove: remove,
        p_max_bytes: maxBytes,
      });
      return Number(check(result, 'team sync write'));
    },

    async teamSyncVersion(team: string): Promise<number> {
      const result = await db.from('team_sync_state').select('version').eq('team_id', team).maybeSingle();
      const row = check(result, 'team sync version') as { version: number } | null;
      return Number(row?.version ?? 0);
    },

    // ---- Shared folders ----

    async shareCreate(id: string, account: string, content: ShareContent): Promise<boolean> {
      const result = await db.from('shares').insert({ id, account_id: account, ...shareColumns(content) });
      if (result.error?.code === DUPLICATE) return false;
      check(result, 'share create');
      return true;
    },

    async shareGet(id: string): Promise<ShareRecord | null> {
      const result = await db.from('shares').select(SHARE_COLUMNS).eq('id', id).maybeSingle();
      const row = check(result, 'share get') as ShareRow | null;
      return row ? toShare(row) : null;
    },

    async shareUpdate(id: string, account: string, content: ShareContent): Promise<ShareRecord | null> {
      const result = await db
        .from('shares')
        .update({ ...shareColumns(content), updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', account)
        .select(SHARE_COLUMNS)
        .maybeSingle();
      const row = check(result, 'share update') as ShareRow | null;
      return row ? toShare(row) : null;
    },

    async shareDelete(id: string, account: string): Promise<boolean> {
      const result = await db.from('shares').delete().eq('id', id).eq('account_id', account).select('id');
      return ((check(result, 'share delete') as { id: string }[] | null) ?? []).length > 0;
    },

    async shareCount(account: string): Promise<number> {
      const result = await db.from('shares').select('id', { count: 'exact', head: true }).eq('account_id', account);
      check(result, 'share count');
      return result.count ?? 0;
    },

    async shareView(id: string): Promise<PublicShare | null> {
      const data = check(await db.rpc('tabfold_share_view', { p_id: id }), 'share view') as {
        name: string;
        color: string;
        tabs: { title: string; url: string }[];
        updated_at: string;
        note?: string | null;
      } | null;
      if (!data) return null;
      return { name: data.name, color: data.color, tabs: data.tabs ?? [], updatedAt: Date.parse(data.updated_at), note: data.note ?? '' };
    },

    // ---- Deleting an account (1.0) ----

    async accountDelete(account: string): Promise<boolean> {
      if (!UUID.test(account)) return false;
      return check(await db.rpc('tabfold_account_delete', { p_account: account }), 'account delete') === true;
    },
  };
}
