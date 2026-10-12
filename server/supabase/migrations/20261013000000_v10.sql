-- Tabfold 1.0: a shared folder's note, and deleting an account. As before, only the `tabfold` Edge
-- Function uses these, with the service role: row level security is on with no policies.

-- A shared folder's note: one line, at most 140 characters ('' when none). The server cleans it.
alter table public.shares
  add column note text not null default '' check (char_length(note) <= 140);

-- Someone opened a shared folder's page: counts the view and returns what the page shows (now with
-- the note), or null when there's no such share.
create or replace function public.tabfold_share_view(p_id text)
returns jsonb
language sql
set search_path = ''
as $$
  update public.shares set views = views + 1 where id = p_id
  returning jsonb_build_object('name', name, 'color', color, 'tabs', tabs, 'updated_at', updated_at, 'note', note);
$$;

-- Deletes an account and everything kept for it, in one step (the Edge Function has already
-- cancelled its Stripe subscriptions). Its sign-in code and the checkouts its computers started go
-- first, as they aren't tied to the account's row; the rest goes with the row (on delete cascade):
-- its devices and Chrome profile key, synced copy, backups, AI usage, subscriptions and purchases as
-- stored here, shares, its team membership, and a team it owns with that team's people,
-- invitations and folders. Stripe keeps its own records. True if there was such an account.
create function public.tabfold_account_delete(p_account uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_email text;
begin
  -- One change to an account at a time (as tabfold_team_create and tabfold_team_join do).
  select email into v_email from public.accounts where id = p_account for update;
  if v_email is null then
    return false;
  end if;
  delete from public.pending_checkouts
   where token_hash in (select d.token_hash from public.devices d where d.account_id = p_account)
      or signin_email = v_email;
  delete from public.signin_codes where email = v_email;
  delete from public.accounts where id = p_account;
  return true;
end;
$$;

-- Only the service role (the Edge Function) may call these.
revoke all on function public.tabfold_share_view(text) from public, anon, authenticated;
revoke all on function public.tabfold_account_delete(uuid) from public, anon, authenticated;
grant execute on function public.tabfold_share_view(text) to service_role;
grant execute on function public.tabfold_account_delete(uuid) to service_role;
