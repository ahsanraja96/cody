-- Tabfold Pro, payments through Stripe Checkout: accounts get a Stripe customer and the server's
-- 7-day trial; computers sign in with device tokens (and Chrome profile keys), proved by a 6-digit
-- code sent by email. Replaces the ExtensionPay cache. As before, only the `tabfold` Edge Function
-- uses these, with the service role: row level security is on with no policies.

-- email_verified_at: when the email was first proved with a code. An account made by a signed-out
-- checkout starts without it (Stripe doesn't check the email typed on its page).
alter table public.accounts
  add column stripe_customer_id text unique,
  add column trial_started_at timestamptz,
  add column email_verified_at timestamptz;

-- Accounts from before came from ExtensionPay's own email sign-in.
update public.accounts set email_verified_at = created_at;

-- A computer's device token (kind 'device') or a Chrome profile key (kind 'profile'), stored only
-- as a SHA-256 hash.
create table public.devices (
  token_hash text primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  kind text not null check (kind in ('device', 'profile')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index devices_account_id on public.devices (account_id);

-- The latest sign-in code for an email, stored only as an HMAC. Deleted once used.
create table public.signin_codes (
  email text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

-- Fixed-window counters (codes asked for, per email hash and per token hash).
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count int not null default 0
);

-- Stripe subscriptions, as Stripe last described them.
create table public.subscriptions (
  id text primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  customer_id text not null,
  status text not null,
  lookup_key text,
  interval text,
  current_period_end timestamptz,
  cancel_at timestamptz,
  cancel_at_period_end boolean not null default false,
  trial_end timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index subscriptions_account_id on public.subscriptions (account_id);
create index subscriptions_customer_id on public.subscriptions (customer_id);

-- Checkouts a device token started, until they are processed. signin_email is set when the
-- checkout was paid with an email whose account is older than the checkout: that computer has to
-- sign in with a code instead of being signed in by the payment.
create table public.pending_checkouts (
  session_id text primary key,
  token_hash text not null,
  created_at timestamptz not null default now(),
  signin_email text
);

create index pending_checkouts_token_hash on public.pending_checkouts (token_hash, created_at);

-- Stripe webhook events already processed.
create table public.stripe_events (
  id text primary key,
  received_at timestamptz not null default now()
);

create index stripe_events_received_at on public.stripe_events (received_at);

drop table if exists public.extpay_cache;

alter table public.devices enable row level security;
alter table public.signin_codes enable row level security;
alter table public.rate_limits enable row level security;
alter table public.subscriptions enable row level security;
alter table public.pending_checkouts enable row level security;
alter table public.stripe_events enable row level security;

revoke all on table public.devices, public.signin_codes, public.rate_limits, public.subscriptions,
  public.pending_checkouts, public.stripe_events from anon, authenticated;

-- Take one from a key's allowance of p_limit per p_window_seconds (at most a day). Returns 0 when
-- allowed, else the seconds until the window starts again.
create function public.tabfold_rate_take(p_key text, p_limit int, p_window_seconds int)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_window interval := make_interval(secs => p_window_seconds);
  v_start timestamptz;
  v_count int;
begin
  if p_window_seconds <= 0 or p_window_seconds > 86400 then
    raise exception 'tabfold_rate_take: window must be 1 to 86400 seconds';
  end if;
  insert into public.rate_limits as r (key, window_start, count) values (p_key, now(), 1)
    on conflict (key) do update
      set window_start = case when r.window_start <= now() - v_window then now() else r.window_start end,
          count = case when r.window_start <= now() - v_window then 1 else r.count + 1 end
    returning window_start, count into v_start, v_count;
  -- Windows are at most a day, so older rows are of no use.
  delete from public.rate_limits where window_start < now() - interval '1 day';
  if v_count <= p_limit then
    return 0;
  end if;
  return greatest(1, ceil(extract(epoch from (v_start + v_window - now())))::int);
end;
$$;

-- Start the account's trial now, only if it never started. True if this call started it.
create function public.tabfold_start_trial(p_account uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.accounts set trial_started_at = now()
   where id = p_account and trial_started_at is null
   returning id into v_id;
  return v_id is not null;
end;
$$;

-- Count one try of the email's code. Returns the tries so far, or null when there's no code.
create function public.tabfold_code_attempt(p_email text)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_attempts int;
begin
  update public.signin_codes set attempts = attempts + 1
   where email = p_email
   returning attempts into v_attempts;
  return v_attempts;
end;
$$;

-- The account's email was just proved with a code. The first time, every computer and Chrome
-- profile key linked to the account goes (they were linked by a payment whose email nobody had
-- proved); the plan, synced tabs and backups stay. True if this was the first time.
create function public.tabfold_verify_email(p_account uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.accounts set email_verified_at = now()
   where id = p_account and email_verified_at is null
   returning id into v_id;
  if v_id is null then
    return false;
  end if;
  delete from public.devices where account_id = p_account;
  return true;
end;
$$;

-- Only the service role (the Edge Function) may call these.
revoke all on function public.tabfold_rate_take(text, int, int) from public, anon, authenticated;
revoke all on function public.tabfold_start_trial(uuid) from public, anon, authenticated;
revoke all on function public.tabfold_code_attempt(text) from public, anon, authenticated;
revoke all on function public.tabfold_verify_email(uuid) from public, anon, authenticated;
grant execute on function public.tabfold_rate_take(text, int, int) to service_role;
grant execute on function public.tabfold_start_trial(uuid) to service_role;
grant execute on function public.tabfold_code_attempt(text) to service_role;
grant execute on function public.tabfold_verify_email(uuid) to service_role;
