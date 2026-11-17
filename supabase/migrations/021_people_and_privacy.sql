-- ═══════════════════════════════════════════════════════════════════
--  021_people_and_privacy — more than one person per household
--
--  Private by default: every mail account has an OWNER; only the owner sees its mail, sorting,
--  Review, Retire list and history — unless the account is marked `shared`. Tabs belong to a
--  person, except the household's Shared tab (owner_id null). To-Do items are the creator's,
--  or everyone's when they sit on the Shared tab. Learning (sender / company preferences) is
--  per person: your taps shape your sorting only.
--
--  Enforced HERE, in row-level security — not just by what the app shows.
-- ═══════════════════════════════════════════════════════════════════

-- ── People ──────────────────────────────────────────────────────────
alter table public.household_members
  add column profile jsonb not null default '{}'::jsonb,   -- answers to "help rlyfe sort" (family, church, work…)
  add column onboarded_at timestamptz;

-- ── Owners ──────────────────────────────────────────────────────────
alter table public.connected_accounts
  add column owner_id uuid references auth.users(id) on delete cascade,
  add column shared boolean not null default false;
update public.connected_accounts a set owner_id = coalesce(a.connected_by,
  (select m.user_id from public.household_members m where m.household_id = a.household_id and m.role = 'owner' limit 1));
alter table public.connected_accounts alter column owner_id set not null;

alter table public.tabs add column owner_id uuid references auth.users(id) on delete cascade;  -- null = Shared tab
update public.tabs t set owner_id =
  (select m.user_id from public.household_members m where m.household_id = t.household_id and m.role = 'owner' limit 1);
insert into public.tabs (household_id, slug, name, sort_order, owner_id)
select id, 'shared', 'Shared', 90, null from public.households
on conflict (household_id, slug) do nothing;

-- Every email carries its account's owner (keeps learning + privacy checks simple and fast)
alter table public.email_threads add column owner_id uuid;
update public.email_threads t set owner_id = a.owner_id from public.connected_accounts a where a.id = t.account_id;
alter table public.email_threads alter column owner_id set not null;
create index email_threads_owner_idx on public.email_threads (owner_id, from_email);

create or replace function private.thread_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select a.owner_id into new.owner_id from public.connected_accounts a where a.id = new.account_id;
  return new;
end $$;
create trigger email_threads_owner before insert on public.email_threads
  for each row execute function private.thread_owner();

alter table public.tasks add column owner_id uuid references auth.users(id) on delete cascade default auth.uid();
update public.tasks set owner_id = created_by where owner_id is null;
update public.tasks t set owner_id =
  (select m.user_id from public.household_members m where m.household_id = t.household_id and m.role = 'owner' limit 1)
  where owner_id is null;

-- ── Visibility helpers ──────────────────────────────────────────────
create or replace function private.can_see_account(acc uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.connected_accounts a
                 where a.id = acc and private.is_member(a.household_id)
                   and (a.owner_id = (select auth.uid()) or a.shared));
$$;
create or replace function private.is_shared_tab(tab uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tabs t where t.id = tab and t.owner_id is null);
$$;
revoke all on function private.can_see_account(uuid) from public, anon;
revoke all on function private.is_shared_tab(uuid) from public, anon;
grant execute on function private.can_see_account(uuid) to authenticated;
grant execute on function private.is_shared_tab(uuid) to authenticated;

-- ── Policies: replace "any household member" with "owner, or shared" ─
drop policy "members read their household's accounts" on public.connected_accounts;
drop policy "members change their household's account policy" on public.connected_accounts;
create policy "people read their own or shared accounts" on public.connected_accounts for select to authenticated
  using (private.has_2fa() and private.is_member(household_id) and (owner_id = (select auth.uid()) or shared));
create policy "people change their own or shared accounts" on public.connected_accounts for update to authenticated
  using (private.has_2fa() and private.is_member(household_id) and (owner_id = (select auth.uid()) or shared))
  with check (private.has_2fa() and private.is_member(household_id) and (owner_id = (select auth.uid()) or shared));
grant update (ai_context, shared) on public.connected_accounts to authenticated;

drop policy "members read their household's threads" on public.email_threads;
drop policy "members correct their household's threads" on public.email_threads;
create policy "people read mail they can see" on public.email_threads for select to authenticated
  using (private.has_2fa() and private.can_see_account(account_id));
create policy "people correct mail they can see" on public.email_threads for update to authenticated
  using (private.has_2fa() and private.can_see_account(account_id))
  with check (private.has_2fa() and private.can_see_account(account_id));

drop policy "members read their household's action log" on public.action_log;
create policy "people read history of mail they can see" on public.action_log for select to authenticated
  using (private.has_2fa() and private.is_member(household_id) and (account_id is null or private.can_see_account(account_id)));

drop policy "members read their household's AI usage" on public.ai_usage;
create policy "people read AI usage for mail they can see" on public.ai_usage for select to authenticated
  using (private.has_2fa() and private.is_member(household_id) and (account_id is null or private.can_see_account(account_id)));

drop policy "members read their household's runs" on public.sync_runs;
create policy "people read syncs of mail they can see" on public.sync_runs for select to authenticated
  using (private.has_2fa() and private.is_member(household_id) and (account_id is null or private.can_see_account(account_id)));

drop policy "members read their household's cleanups" on public.cleanup_batches;
create policy "people read cleanups of mail they can see" on public.cleanup_batches for select to authenticated
  using (private.has_2fa() and private.can_see_account(account_id));

drop policy "members read their household's retire list" on public.retire_items;
drop policy "members update their household's retire list" on public.retire_items;
create policy "people read retire lists they can see" on public.retire_items for select to authenticated
  using (private.has_2fa() and private.can_see_account(account_id));
create policy "people update retire lists they can see" on public.retire_items for update to authenticated
  using (private.has_2fa() and private.can_see_account(account_id))
  with check (private.has_2fa() and private.can_see_account(account_id));

drop policy "members read their household's tabs" on public.tabs;
create policy "people read their own tabs and the Shared tab" on public.tabs for select to authenticated
  using (private.has_2fa() and private.is_member(household_id) and (owner_id is null or owner_id = (select auth.uid())));

drop policy "members read their household's tasks" on public.tasks;
drop policy "members add tasks to their household" on public.tasks;
drop policy "members change their household's tasks" on public.tasks;
drop policy "members delete their household's tasks" on public.tasks;
create policy "people read their own and shared to-dos" on public.tasks for select to authenticated
  using (private.has_2fa() and private.is_member(household_id) and (owner_id = (select auth.uid()) or private.is_shared_tab(tab_id)));
create policy "people add their own to-dos" on public.tasks for insert to authenticated
  with check (private.has_2fa() and private.is_member(household_id) and owner_id = (select auth.uid()));
create policy "people change their own and shared to-dos" on public.tasks for update to authenticated
  using (private.has_2fa() and private.is_member(household_id) and (owner_id = (select auth.uid()) or private.is_shared_tab(tab_id)))
  with check (private.has_2fa() and private.is_member(household_id));
create policy "people delete their own and shared to-dos" on public.tasks for delete to authenticated
  using (private.has_2fa() and private.is_member(household_id) and (owner_id = (select auth.uid()) or private.is_shared_tab(tab_id)));
-- A to-do can only link to an email its creator can see
create or replace function private.check_task_links() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.tab_id is not null and not exists (
    select 1 from public.tabs where id = new.tab_id and household_id = new.household_id) then
    raise exception 'tab not in household';
  end if;
  if new.account_id is not null and not exists (
    select 1 from public.connected_accounts where id = new.account_id and household_id = new.household_id) then
    raise exception 'account not in household';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- ── Learning becomes per person ─────────────────────────────────────
alter table public.sender_prefs add column owner_id uuid;
update public.sender_prefs p set owner_id =
  (select m.user_id from public.household_members m where m.household_id = p.household_id and m.role = 'owner' limit 1);
alter table public.sender_prefs alter column owner_id set not null;
alter table public.sender_prefs drop constraint sender_prefs_pkey;
alter table public.sender_prefs add primary key (household_id, owner_id, sender_email);

alter table public.domain_prefs add column owner_id uuid;
update public.domain_prefs p set owner_id =
  (select m.user_id from public.household_members m where m.household_id = p.household_id and m.role = 'owner' limit 1);
alter table public.domain_prefs alter column owner_id set not null;
alter table public.domain_prefs drop constraint domain_prefs_pkey;
alter table public.domain_prefs add primary key (household_id, owner_id, domain);

drop policy "members read their household's sender prefs" on public.sender_prefs;
drop policy "members remove their household's sender prefs" on public.sender_prefs;
create policy "people read their own sender learning" on public.sender_prefs for select to authenticated
  using (private.has_2fa() and private.is_member(household_id) and owner_id = (select auth.uid()));
create policy "people remove their own sender learning" on public.sender_prefs for delete to authenticated
  using (private.has_2fa() and private.is_member(household_id) and owner_id = (select auth.uid()));
drop policy "members read their household's domain prefs" on public.domain_prefs;
drop policy "members remove their household's domain prefs" on public.domain_prefs;
create policy "people read their own company learning" on public.domain_prefs for select to authenticated
  using (private.has_2fa() and private.is_member(household_id) and owner_id = (select auth.uid()));
create policy "people remove their own company learning" on public.domain_prefs for delete to authenticated
  using (private.has_2fa() and private.is_member(household_id) and owner_id = (select auth.uid()));

drop trigger email_threads_learn on public.email_threads;
drop trigger sender_prefs_forget on public.sender_prefs;
drop function private.learn_from_correction();
drop function private.forget_sender_pref();
drop function private.apply_sender_pref(uuid, text, uuid, text);

create function private.apply_sender_pref(hh uuid, own uuid, sender text, skip_account uuid, skip_thread text)
returns void language plpgsql security definer set search_path = '' as $$
declare pref smallint;
begin
  select bucket into pref from public.sender_prefs where household_id = hh and owner_id = own and sender_email = sender;
  if pref is not null then
    update public.email_threads t set
      bucket = pref, classified_by = 'learned',
      reason = 'You sort this sender as ' || case pref when 1 then 'Junk' when 2 then 'Glance' else 'Real' end,
      classified_at = now(), updated_at = now()
    where t.owner_id = own and t.from_email = sender
      and t.in_inbox and t.user_bucket is null
      and not t.priority and not coalesce(t.last_from_me, false)
      and t.bucket is distinct from pref
      and not (t.account_id = skip_account and t.thread_id = skip_thread);
  else
    update public.email_threads t set status = 'pending', attempts = 0, updated_at = now()
    where t.owner_id = own and t.from_email = sender and t.classified_by = 'learned';
  end if;
end $$;

create function private.learn_from_correction() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.from_email is null then return new; end if;
  insert into public.sender_prefs (household_id, owner_id, sender_email)
  values (new.household_id, new.owner_id, new.from_email) on conflict do nothing;
  update public.sender_prefs set
    votes_1 = greatest(0, votes_1 + (new.user_bucket is not distinct from 1)::int - (old.user_bucket is not distinct from 1)::int),
    votes_2 = greatest(0, votes_2 + (new.user_bucket is not distinct from 2)::int - (old.user_bucket is not distinct from 2)::int),
    votes_3 = greatest(0, votes_3 + (new.user_bucket is not distinct from 3)::int - (old.user_bucket is not distinct from 3)::int),
    updated_at = now()
  where household_id = new.household_id and owner_id = new.owner_id and sender_email = new.from_email;
  perform private.apply_sender_pref(new.household_id, new.owner_id, new.from_email, new.account_id, new.thread_id);
  return new;
end $$;
create trigger email_threads_learn after update of user_bucket on public.email_threads
  for each row when (old.user_bucket is distinct from new.user_bucket)
  execute function private.learn_from_correction();

create function private.forget_sender_pref() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.email_threads t set status = 'pending', attempts = 0, updated_at = now()
  where t.owner_id = old.owner_id and t.from_email = old.sender_email and t.classified_by = 'learned';
  return old;
end $$;
create trigger sender_prefs_forget after delete on public.sender_prefs
  for each row execute function private.forget_sender_pref();

revoke all on function private.apply_sender_pref(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function private.learn_from_correction() from public, anon, authenticated;
revoke all on function private.forget_sender_pref() from public, anon, authenticated;
revoke all on function private.thread_owner() from public, anon, authenticated;

create or replace function public.review_domain(p_domain text, p_bucket smallint)
returns table (account_id uuid, thread_id text)
language plpgsql security definer set search_path = '' as $$
declare hh uuid; me uuid := (select auth.uid());
begin
  if not private.has_2fa() then raise exception 'needs-2fa'; end if;
  select m.household_id into hh from public.household_members m where m.user_id = me limit 1;
  if hh is null then raise exception 'no-household'; end if;
  if p_bucket not in (1, 2, 3) then raise exception 'bad-bucket'; end if;
  p_domain := lower(trim(p_domain));
  if private.is_personal_domain(p_domain) then raise exception 'personal-domain'; end if;

  insert into public.domain_prefs (household_id, owner_id, domain, bucket)
  values (hh, me, p_domain, p_bucket)
  on conflict (household_id, owner_id, domain) do update set bucket = excluded.bucket, updated_at = now();

  return query
  update public.email_threads t set user_bucket = p_bucket, updated_at = now()
  where t.owner_id = me
    and split_part(t.from_email, '@', 2) = p_domain
    and t.in_inbox and t.status = 'classified'
    and t.user_bucket is null
    and not t.priority and not coalesce(t.last_from_me, false)
  returning t.account_id, t.thread_id;
end $$;

create or replace function public.unreview_threads(p_domain text, p_threads jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare hh uuid; me uuid := (select auth.uid()); n integer;
begin
  if not private.has_2fa() then raise exception 'needs-2fa'; end if;
  select m.household_id into hh from public.household_members m where m.user_id = me limit 1;
  if hh is null then raise exception 'no-household'; end if;
  delete from public.domain_prefs where household_id = hh and owner_id = me and domain = lower(trim(p_domain));
  update public.email_threads t set user_bucket = null, updated_at = now()
  from jsonb_to_recordset(p_threads) as x(account_id uuid, thread_id text)
  where t.owner_id = me and t.account_id = x.account_id and t.thread_id = x.thread_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── Invites ─────────────────────────────────────────────────────────
create table public.household_invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  token_hash   text not null unique,                 -- sha-256 of the link's token; the token itself is never stored
  name         text not null,                        -- "Blake"
  profile      jsonb not null default '{}'::jsonb,   -- what the inviter already knows (pre-fills her questions)
  created_by   uuid not null references auth.users(id) on delete cascade,
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_by  uuid references auth.users(id) on delete set null,
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);
alter table public.household_invites enable row level security;
create policy "members see their household's invites" on public.household_invites for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
revoke insert, update, delete on public.household_invites from anon, authenticated;

-- ── Your own profile is yours to edit ───────────────────────────────
create policy "people update their own profile" on public.household_members for update to authenticated
  using (private.has_2fa() and user_id = (select auth.uid()))
  with check (private.has_2fa() and user_id = (select auth.uid()));
revoke update on public.household_members from anon, authenticated;
grant update (display_name, profile, onboarded_at) on public.household_members to authenticated;
