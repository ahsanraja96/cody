-- Tabfold 0.6: Pro for life (one payment), Teams (a team, its people, invitations and shared
-- folders) and shared folder links. As before, only the `tabfold` Edge Function uses these, with
-- the service role: row level security is on with no policies.

-- A Teams plan's seats are its subscription's quantity (item_id is the item whose quantity
-- changes); ended_at is when a subscription ended (a team's folders stay readable 30 days after).
alter table public.subscriptions
  add column quantity int not null default 1 check (quantity >= 1),
  add column item_id text,
  add column ended_at timestamptz;

-- One-time purchases (Pro for life), by the Checkout Session they were paid through.
create table public.purchases (
  id text primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  lookup_key text not null,
  customer_id text,
  payment_intent_id text,
  created_at timestamptz not null default now()
);

create index purchases_account_id on public.purchases (account_id);

-- A Teams plan's team. Its subscription is kept with the owner's own (public.subscriptions). An
-- account owns one team at most.
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  owner_id uuid not null unique references public.accounts (id) on delete cascade,
  subscription_id text unique,
  created_at timestamptz not null default now()
);

-- Who is in a team, the owner included. An account is in one team at most.
create table public.team_members (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now()
);

create index team_members_team_id on public.team_members (team_id, joined_at);

-- Invitations waiting for someone to sign in with that email (lower-cased).
create table public.team_invites (
  team_id uuid not null references public.teams (id) on delete cascade,
  email text not null,
  invited_at timestamptz not null default now(),
  primary key (team_id, email)
);

create index team_invites_email on public.team_invites (email, invited_at);

-- A team's shared folders: items in the same format as an account's sync, opaque to the server.
create table public.team_sync_state (
  team_id uuid primary key references public.teams (id) on delete cascade,
  version bigint not null default 0,
  bytes bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table public.team_sync_items (
  team_id uuid not null references public.teams (id) on delete cascade,
  key text not null,
  value jsonb not null,
  primary key (team_id, key)
);

-- Shared folder links: a public, read-only page at <SHARE_BASE_URL>/s/<id>. tabs is a list of
-- { title, url }, http(s) addresses only.
create table public.shares (
  id text primary key check (id ~ '^[A-Za-z0-9]{10}$'),
  account_id uuid not null references public.accounts (id) on delete cascade,
  name text not null,
  color text not null,
  tabs jsonb not null default '[]'::jsonb,
  live boolean not null default false,
  views bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index shares_account_id on public.shares (account_id);

alter table public.purchases enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.team_sync_state enable row level security;
alter table public.team_sync_items enable row level security;
alter table public.shares enable row level security;

revoke all on table public.purchases, public.teams, public.team_members, public.team_invites,
  public.team_sync_state, public.team_sync_items, public.shares from anon, authenticated;

-- The team a Teams subscription pays for, made once: the team that already has this
-- subscription; else the account's own team, which takes the subscription and the name (its plan
-- had ended); else a new team owned by the account, which leaves any team it was a member of.
-- Returns the team's id.
create function public.tabfold_team_create(p_owner uuid, p_name text, p_subscription text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- One change to an account's team at a time (the webhook and GET /me can both get here).
  perform 1 from public.accounts where id = p_owner for update;
  select id into v_id from public.teams where subscription_id = p_subscription;
  if v_id is not null then
    return v_id;
  end if;
  select id into v_id from public.teams where owner_id = p_owner;
  if v_id is not null then
    update public.teams set subscription_id = p_subscription, name = p_name where id = v_id;
    return v_id;
  end if;
  delete from public.team_members where account_id = p_owner;
  insert into public.teams (name, owner_id, subscription_id) values (p_name, p_owner, p_subscription)
    returning id into v_id;
  insert into public.team_members (account_id, team_id, role) values (p_owner, v_id, 'owner');
  return v_id;
end;
$$;

-- Someone invited to a team signed in with a code: if the account isn't in a team, it joins as a
-- member and the invitation goes. True if it joined.
create function public.tabfold_team_join(p_team uuid, p_account uuid, p_email text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.accounts where id = p_account for update;
  if exists (select 1 from public.team_members where account_id = p_account) then
    return false;
  end if;
  delete from public.team_invites where team_id = p_team and email = p_email;
  if not found then
    return false;
  end if;
  insert into public.team_members (account_id, team_id, role) values (p_account, p_team, 'member');
  return true;
end;
$$;

-- A team's shared folders as one JSON object, with the version (0 before the first write).
create function public.tabfold_team_sync_read(p_team uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_object_agg(i.key, i.value) from public.team_sync_items i where i.team_id = p_team), '{}'::jsonb),
    'version', coalesce((select s.version from public.team_sync_state s where s.team_id = p_team), 0)
  );
$$;

-- Like tabfold_sync_write, for a team: applies set and remove atomically only when the stored
-- version is still p_base. Returns the new version, -1 when the version moved on (conflict), or -2
-- when the items would pass p_max_bytes. Nothing changes unless it returns a version.
create function public.tabfold_team_sync_write(
  p_team uuid,
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
  insert into public.team_sync_state (team_id) values (p_team)
    on conflict (team_id) do nothing;
  -- The row lock makes concurrent writes for one team take turns.
  select version into v_version from public.team_sync_state where team_id = p_team for update;
  if v_version is distinct from p_base then
    return -1;
  end if;

  select coalesce(sum(octet_length(t.key) + octet_length(t.value::text)), 0) into v_bytes
  from (
    select i.key, i.value
      from public.team_sync_items i
     where i.team_id = p_team
       and not (v_set ? i.key)
       and not (i.key = any (v_remove))
    union all
    select s.key, s.value from jsonb_each(v_set) s
  ) t;
  if v_bytes > p_max_bytes then
    return -2;
  end if;

  delete from public.team_sync_items where team_id = p_team and key = any (v_remove);
  insert into public.team_sync_items (team_id, key, value)
    select p_team, s.key, s.value from jsonb_each(v_set) s
    on conflict (team_id, key) do update set value = excluded.value;
  update public.team_sync_state
     set version = v_version + 1, bytes = v_bytes, updated_at = now()
   where team_id = p_team;
  return v_version + 1;
end;
$$;

-- Someone opened a shared folder's page: counts the view and returns what the page shows, or
-- null when there's no such share.
create function public.tabfold_share_view(p_id text)
returns jsonb
language sql
set search_path = ''
as $$
  update public.shares set views = views + 1 where id = p_id
  returning jsonb_build_object('name', name, 'color', color, 'tabs', tabs, 'updated_at', updated_at);
$$;

-- Only the service role (the Edge Function) may call these.
revoke all on function public.tabfold_team_create(uuid, text, text) from public, anon, authenticated;
revoke all on function public.tabfold_team_join(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.tabfold_team_sync_read(uuid) from public, anon, authenticated;
revoke all on function public.tabfold_team_sync_write(uuid, bigint, jsonb, text[], bigint) from public, anon, authenticated;
revoke all on function public.tabfold_share_view(text) from public, anon, authenticated;
grant execute on function public.tabfold_team_create(uuid, text, text) to service_role;
grant execute on function public.tabfold_team_join(uuid, uuid, text) to service_role;
grant execute on function public.tabfold_team_sync_read(uuid) to service_role;
grant execute on function public.tabfold_team_sync_write(uuid, bigint, jsonb, text[], bigint) to service_role;
grant execute on function public.tabfold_share_view(text) to service_role;
