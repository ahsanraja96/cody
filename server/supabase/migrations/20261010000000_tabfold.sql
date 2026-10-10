-- Tabfold Pro: accounts, synced folded tabs, daily backups, AI usage and the ExtensionPay cache.
-- Only the `tabfold` Edge Function uses these, with the service role: row level security is on
-- with no policies, so the public (anon) and signed-in API roles can't read or write anything.

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table public.sync_state (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  version bigint not null default 0,
  bytes bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table public.sync_items (
  account_id uuid not null references public.accounts (id) on delete cascade,
  key text not null,
  value jsonb not null,
  primary key (account_id, key)
);

create table public.backups (
  account_id uuid not null references public.accounts (id) on delete cascade,
  day date not null,
  items jsonb not null,
  tab_count int not null default 0,
  created_at timestamptz not null default now(),
  primary key (account_id, day)
);

create table public.ai_usage (
  account_id uuid not null references public.accounts (id) on delete cascade,
  month text not null,
  runs int not null default 0,
  light int not null default 0,
  primary key (account_id, month)
);

-- ExtensionPay answers, for 5 minutes, keyed by a SHA-256 of the key (the key is never stored).
create table public.extpay_cache (
  key_hash text primary key,
  user_json jsonb not null,
  checked_at timestamptz not null default now()
);

create index extpay_cache_checked_at on public.extpay_cache (checked_at);

alter table public.accounts enable row level security;
alter table public.sync_state enable row level security;
alter table public.sync_items enable row level security;
alter table public.backups enable row level security;
alter table public.ai_usage enable row level security;
alter table public.extpay_cache enable row level security;

revoke all on table public.accounts, public.sync_state, public.sync_items, public.backups, public.ai_usage,
  public.extpay_cache from anon, authenticated;

-- The account for an email (lower-cased by the caller), created on first use.
create function public.tabfold_account(p_email text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.accounts where email = p_email;
  if v_id is null then
    insert into public.accounts (email) values (p_email)
      on conflict (email) do nothing
      returning id into v_id;
    if v_id is null then
      select id into v_id from public.accounts where email = p_email;
    end if;
  end if;
  return v_id;
end;
$$;

-- Every synced item as one JSON object, with the version (0 before the first write).
create function public.tabfold_sync_read(p_account uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_object_agg(i.key, i.value) from public.sync_items i where i.account_id = p_account), '{}'::jsonb),
    'version', coalesce((select s.version from public.sync_state s where s.account_id = p_account), 0)
  );
$$;

-- Apply a sync write atomically: set and remove keys, but only when the stored version is still
-- p_base. Returns the new version, -1 when the version moved on (conflict), or -2 when the items
-- would pass p_max_bytes (keys plus JSON values). Nothing changes unless it returns a version.
create function public.tabfold_sync_write(
  p_account uuid,
  p_base bigint,
  p_set jsonb,
  p_remove text[],
  p_max_bytes bigint
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_set jsonb := coalesce(p_set, '{}'::jsonb);
  v_remove text[] := coalesce(p_remove, '{}'::text[]);
  v_version bigint;
  v_bytes bigint;
begin
  insert into public.sync_state (account_id) values (p_account)
    on conflict (account_id) do nothing;
  -- The row lock makes concurrent writes for one account take turns.
  select version into v_version from public.sync_state where account_id = p_account for update;
  if v_version is distinct from p_base then
    return -1;
  end if;

  select coalesce(sum(octet_length(t.key) + octet_length(t.value::text)), 0) into v_bytes
  from (
    select i.key, i.value
      from public.sync_items i
     where i.account_id = p_account
       and not (v_set ? i.key)
       and not (i.key = any (v_remove))
    union all
    select s.key, s.value from jsonb_each(v_set) s
  ) t;
  if v_bytes > p_max_bytes then
    return -2;
  end if;

  delete from public.sync_items where account_id = p_account and key = any (v_remove);
  insert into public.sync_items (account_id, key, value)
    select p_account, s.key, s.value from jsonb_each(v_set) s
    on conflict (account_id, key) do update set value = excluded.value;
  update public.sync_state
     set version = v_version + 1, bytes = v_bytes, updated_at = now()
   where account_id = p_account;
  return v_version + 1;
end;
$$;

-- Count one AI use for the month if it is under p_limit. p_kind is 'runs' (Organise) or 'light'
-- (smart names and Copy as context). Returns the new count, or -1 when the limit is reached.
create function public.tabfold_take_run(p_account uuid, p_month text, p_kind text, p_limit int)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  if p_kind not in ('runs', 'light') then
    raise exception 'tabfold_take_run: unknown kind %', p_kind;
  end if;
  insert into public.ai_usage (account_id, month) values (p_account, p_month)
    on conflict (account_id, month) do nothing;
  if p_kind = 'runs' then
    update public.ai_usage set runs = runs + 1
     where account_id = p_account and month = p_month and runs < p_limit
     returning runs into v_count;
  else
    update public.ai_usage set light = light + 1
     where account_id = p_account and month = p_month and light < p_limit
     returning light into v_count;
  end if;
  return coalesce(v_count, -1);
end;
$$;

-- Only the service role (the Edge Function) may call these.
revoke all on function public.tabfold_account(text) from public, anon, authenticated;
revoke all on function public.tabfold_sync_read(uuid) from public, anon, authenticated;
revoke all on function public.tabfold_sync_write(uuid, bigint, jsonb, text[], bigint) from public, anon, authenticated;
revoke all on function public.tabfold_take_run(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.tabfold_account(text) to service_role;
grant execute on function public.tabfold_sync_read(uuid) to service_role;
grant execute on function public.tabfold_sync_write(uuid, bigint, jsonb, text[], bigint) to service_role;
grant execute on function public.tabfold_take_run(uuid, text, text, int) to service_role;
