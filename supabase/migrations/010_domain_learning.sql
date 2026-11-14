-- ═══════════════════════════════════════════════════════════════════
--  010_domain_learning — sort a whole company in one tap
--
--  domain_prefs: "everything from linkedin.com is Junk". Set from the Review
--  queue's grouped cards. The sorter uses it for any address at that domain
--  it hasn't learned individually (exact-sender preferences still win).
--  Personal mail domains (gmail.com, icloud.com, …) are never grouped or learned
--  as a domain — one friend's address says nothing about another's.
--
--  review_domain(domain, bucket): checks every unchecked inbox thread from that
--  domain as `bucket` (never priority threads or conversations you're in),
--  records the domain preference, and returns the threads it checked so the
--  screen can offer Undo. unreview_threads() is that Undo.
-- ═══════════════════════════════════════════════════════════════════

create table public.domain_prefs (
  household_id  uuid not null references public.households(id) on delete cascade,
  domain        text not null,
  bucket        smallint not null check (bucket in (1, 2, 3)),
  updated_at    timestamptz not null default now(),
  primary key (household_id, domain)
);
alter table public.domain_prefs enable row level security;
create policy "members read their household's domain prefs"
  on public.domain_prefs for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
create policy "members remove their household's domain prefs"
  on public.domain_prefs for delete to authenticated
  using (private.has_2fa() and private.is_member(household_id));
revoke insert, update on public.domain_prefs from anon, authenticated;

create or replace function private.is_personal_domain(d text)
returns boolean language sql immutable as $$
  select lower(d) in ('gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com',
                      'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
                      'protonmail.com', 'att.net', 'sbcglobal.net', 'comcast.net', 'verizon.net');
$$;

create or replace function public.review_domain(p_domain text, p_bucket smallint)
returns table (account_id uuid, thread_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  hh uuid;
begin
  if not private.has_2fa() then raise exception 'needs-2fa'; end if;
  select m.household_id into hh from public.household_members m where m.user_id = (select auth.uid()) limit 1;
  if hh is null then raise exception 'no-household'; end if;
  if p_bucket not in (1, 2, 3) then raise exception 'bad-bucket'; end if;
  p_domain := lower(trim(p_domain));
  if private.is_personal_domain(p_domain) then raise exception 'personal-domain'; end if;

  insert into public.domain_prefs (household_id, domain, bucket)
  values (hh, p_domain, p_bucket)
  on conflict (household_id, domain) do update set bucket = excluded.bucket, updated_at = now();

  -- Each update fires the per-thread learning trigger too (sender preferences)
  return query
  update public.email_threads t set user_bucket = p_bucket, updated_at = now()
  where t.household_id = hh
    and split_part(t.from_email, '@', 2) = p_domain
    and t.in_inbox and t.status = 'classified'
    and t.user_bucket is null
    and not t.priority and not coalesce(t.last_from_me, false)
  returning t.account_id, t.thread_id;
end;
$$;

create or replace function public.unreview_threads(p_domain text, p_threads jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  hh uuid;
  n integer;
begin
  if not private.has_2fa() then raise exception 'needs-2fa'; end if;
  select m.household_id into hh from public.household_members m where m.user_id = (select auth.uid()) limit 1;
  if hh is null then raise exception 'no-household'; end if;

  delete from public.domain_prefs where household_id = hh and domain = lower(trim(p_domain));

  update public.email_threads t set user_bucket = null, updated_at = now()
  from jsonb_to_recordset(p_threads) as x(account_id uuid, thread_id text)
  where t.household_id = hh and t.account_id = x.account_id and t.thread_id = x.thread_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.review_domain(text, smallint) from public, anon;
revoke all on function public.unreview_threads(text, jsonb) from public, anon;
grant execute on function public.review_domain(text, smallint) to authenticated;
grant execute on function public.unreview_threads(text, jsonb) to authenticated;
revoke all on function private.is_personal_domain(text) from public, anon;
grant execute on function private.is_personal_domain(text) to authenticated;
