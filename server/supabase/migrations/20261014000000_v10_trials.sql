-- Tabfold 1.0, continued: one trial per email even after an account is deleted, and a team's
-- shared folders deleted 30 days after its plan ends. As before, only the `tabfold` Edge Function
-- uses these, with the service role: row level security is on with no policies.

-- Emails that had the 7-day trial, as a one-way fingerprint only: HMAC-SHA256 of
-- 'trial:<email>' keyed with the server's code secret (CODE_SECRET), in hex. The address can't be
-- read back from it, and the key isn't in the database. Kept after the account is deleted, so the
-- same email can't start another trial. Written when a trial starts, and when an account that had
-- one is deleted (which covers trials started before 1.0: until then the account row records them).
create table public.trial_used (
  email_hash text primary key check (email_hash ~ '^[0-9a-f]{64}$'),
  used_at timestamptz not null default now()
);

alter table public.trial_used enable row level security;
revoke all on table public.trial_used from anon, authenticated;

-- Start the account's trial now, only if it never started for this account and its email's
-- fingerprint isn't in trial_used; then keep the fingerprint. True if this call started it.
-- (The one-argument version from before stays for a server not yet redeployed.)
create function public.tabfold_start_trial(p_account uuid, p_trial_hash text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform 1 from public.accounts where id = p_account for update;
  if exists (select 1 from public.trial_used where email_hash = p_trial_hash) then
    return false;
  end if;
  update public.accounts set trial_started_at = now()
   where id = p_account and trial_started_at is null
   returning id into v_id;
  if v_id is null then
    return false;
  end if;
  insert into public.trial_used (email_hash) values (p_trial_hash) on conflict (email_hash) do nothing;
  return true;
end;
$$;

-- Deleting an account now also keeps its email's trial fingerprint when it had a trial. Replaces
-- the version without it, so no deletion can forget the fingerprint.
drop function public.tabfold_account_delete(uuid);

create function public.tabfold_account_delete(p_account uuid, p_trial_hash text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_email text;
  v_trial timestamptz;
begin
  -- One change to an account at a time (as tabfold_team_create and tabfold_team_join do).
  select email, trial_started_at into v_email, v_trial from public.accounts where id = p_account for update;
  if v_email is null then
    return false;
  end if;
  if v_trial is not null then
    if p_trial_hash is null or p_trial_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'tabfold_account_delete: the account had a trial, so its trial fingerprint is needed';
    end if;
    insert into public.trial_used (email_hash, used_at) values (p_trial_hash, v_trial) on conflict (email_hash) do nothing;
  end if;
  delete from public.pending_checkouts
   where token_hash in (select d.token_hash from public.devices d where d.account_id = p_account)
      or signin_email = v_email;
  delete from public.signin_codes where email = v_email;
  delete from public.accounts where id = p_account;
  return true;
end;
$$;

-- A team's shared folders go 30 days after its plan ends: every team whose subscription isn't live
-- (active, trialing or past due) and ended before p_ended_before (its end, else when it was set to
-- end, else its period's end) loses its team sync items and state. The team, its people and
-- invitations stay (its owner can start the plan again). Returns how many teams were emptied.
create function public.tabfold_team_sync_prune(p_ended_before timestamptz)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  with ended as (
    select t.id
      from public.teams t
      join public.subscriptions s on s.id = t.subscription_id
     where s.status not in ('active', 'trialing', 'past_due')
       and coalesce(s.ended_at, s.cancel_at, s.current_period_end) < p_ended_before
  ),
  items as (
    delete from public.team_sync_items i using ended e where i.team_id = e.id
  ),
  state as (
    delete from public.team_sync_state st using ended e where st.team_id = e.id returning st.team_id
  )
  select count(*) into v_count from state;
  return v_count;
end;
$$;

-- Only the service role (the Edge Function) may call these.
revoke all on function public.tabfold_start_trial(uuid, text) from public, anon, authenticated;
revoke all on function public.tabfold_account_delete(uuid, text) from public, anon, authenticated;
revoke all on function public.tabfold_team_sync_prune(timestamptz) from public, anon, authenticated;
grant execute on function public.tabfold_start_trial(uuid, text) to service_role;
grant execute on function public.tabfold_account_delete(uuid, text) to service_role;
grant execute on function public.tabfold_team_sync_prune(timestamptz) to service_role;
