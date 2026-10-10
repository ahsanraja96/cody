// The Store on Supabase Postgres (Deno only; tests use an in-memory Store). The tables and SQL
// functions are in server/supabase/migrations.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { readExtPayUser, type Backup, type BackupInfo, type Store, type UsageKind } from './app.ts';
import type { ExtPayUser } from '../_shared/plan.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

interface DbError {
  code?: string;
  message: string;
}

/** Database errors as plain Errors: a code and message, never the row's data. */
function check<T>(result: { data: T; error: DbError | null }, what: string): T {
  if (result.error) throw new Error(`Database (${what}): ${result.error.code ?? ''} ${result.error.message}`);
  return result.data;
}

export function createSupabaseStore(db: SupabaseClient): Store {
  return {
    async accountId(email: string): Promise<string> {
      return check(await db.rpc('tabfold_account', { p_email: email }), 'account') as string;
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

    async aiUsage(account: string, month: string) {
      const result = await db.from('ai_usage').select('runs, light').eq('account_id', account).eq('month', month).maybeSingle();
      const row = check(result, 'ai usage') as { runs: number; light: number } | null;
      return { runs: row?.runs ?? 0, light: row?.light ?? 0 };
    },

    async takeRun(account: string, month: string, kind: UsageKind, limit: number): Promise<number> {
      const result = await db.rpc('tabfold_take_run', { p_account: account, p_month: month, p_kind: kind, p_limit: limit });
      return Number(check(result, 'take run'));
    },

    async extpayCacheGet(keyHash: string) {
      const result = await db.from('extpay_cache').select('user_json, checked_at').eq('key_hash', keyHash).maybeSingle();
      const row = check(result, 'extpay cache get') as { user_json: unknown; checked_at: string } | null;
      const user = row ? readExtPayUser(row.user_json) : null;
      return row && user ? { user, checkedAt: Date.parse(row.checked_at) } : null;
    },

    async extpayCachePut(keyHash: string, user: ExtPayUser, checkedAt: number): Promise<void> {
      const result = await db
        .from('extpay_cache')
        .upsert({ key_hash: keyHash, user_json: user, checked_at: new Date(checkedAt).toISOString() });
      check(result, 'extpay cache put');
      // Answers older than a day are of no use: drop them so the table stays small.
      const stale = new Date(checkedAt - DAY_MS).toISOString();
      check(await db.from('extpay_cache').delete().lt('checked_at', stale), 'extpay cache prune');
    },
  };
}
