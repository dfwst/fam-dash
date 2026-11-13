-- ═══════════════════════════════════════════════════════════════════
--  007_learn_from_corrections — your bucket corrections teach the sorter
--
--  sender_prefs: one row per sender, counting how you've sorted their mail.
--    bucket = the bucket you clearly prefer (at least 2× any other), else null.
--    One correction is enough; mixed corrections cancel out → Claude decides.
--
--  When you correct a thread (email_threads.user_bucket changes):
--    1. the sender's vote counts update
--    2. the sender's OTHER inbox threads take the new bucket right away
--       (never priority threads, never conversations you're in, never threads
--        you've corrected yourself)
--  The sync job reads sender_prefs before calling Claude, and also shows Claude
--  your recent corrections as examples.
--
--  Removing a sender preference sends that sender's learned threads back to
--  'pending' so the next sync sorts them fresh.
-- ═══════════════════════════════════════════════════════════════════

alter table public.email_threads drop constraint email_threads_classified_by_check;
alter table public.email_threads add constraint email_threads_classified_by_check
  check (classified_by in ('rule', 'ai', 'fallback', 'learned'));

create table public.sender_prefs (
  household_id  uuid not null references public.households(id) on delete cascade,
  sender_email  text not null,
  votes_1       int not null default 0,
  votes_2       int not null default 0,
  votes_3       int not null default 0,
  bucket        smallint generated always as (
    case
      when votes_1 > 0 and votes_1 >= 2 * greatest(votes_2, votes_3) then 1
      when votes_2 > 0 and votes_2 >= 2 * greatest(votes_1, votes_3) then 2
      when votes_3 > 0 and votes_3 >= 2 * greatest(votes_1, votes_2) then 3
    end
  ) stored,
  updated_at    timestamptz not null default now(),
  primary key (household_id, sender_email)
);

alter table public.sender_prefs enable row level security;
create policy "members read their household's sender prefs"
  on public.sender_prefs for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
create policy "members remove their household's sender prefs"
  on public.sender_prefs for delete to authenticated
  using (private.has_2fa() and private.is_member(household_id));
revoke insert, update on public.sender_prefs from anon, authenticated;

-- Apply a sender's learned bucket to their other inbox threads
create or replace function private.apply_sender_pref(hh uuid, sender text, skip_account uuid, skip_thread text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pref smallint;
begin
  select bucket into pref from public.sender_prefs where household_id = hh and sender_email = sender;

  if pref is not null then
    update public.email_threads t set
      bucket = pref,
      classified_by = 'learned',
      reason = 'You sort this sender as ' || case pref when 1 then 'Junk' when 2 then 'Glance' else 'Real' end,
      classified_at = now(),
      updated_at = now()
    where t.household_id = hh and t.from_email = sender
      and t.in_inbox and t.user_bucket is null
      and not t.priority and not coalesce(t.last_from_me, false)
      and t.bucket is distinct from pref
      and not (t.account_id = skip_account and t.thread_id = skip_thread);
  else
    -- No clear preference any more: let the next sync re-sort what we learned
    update public.email_threads t set status = 'pending', attempts = 0, updated_at = now()
    where t.household_id = hh and t.from_email = sender and t.classified_by = 'learned';
  end if;
end;
$$;

create or replace function private.learn_from_correction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.from_email is null then return new; end if;

  insert into public.sender_prefs (household_id, sender_email)
  values (new.household_id, new.from_email)
  on conflict do nothing;

  update public.sender_prefs set
    votes_1 = greatest(0, votes_1 + (new.user_bucket is not distinct from 1)::int - (old.user_bucket is not distinct from 1)::int),
    votes_2 = greatest(0, votes_2 + (new.user_bucket is not distinct from 2)::int - (old.user_bucket is not distinct from 2)::int),
    votes_3 = greatest(0, votes_3 + (new.user_bucket is not distinct from 3)::int - (old.user_bucket is not distinct from 3)::int),
    updated_at = now()
  where household_id = new.household_id and sender_email = new.from_email;

  perform private.apply_sender_pref(new.household_id, new.from_email, new.account_id, new.thread_id);
  return new;
end;
$$;

-- Only fires when YOU change user_bucket; the trigger's own updates touch other columns
create trigger email_threads_learn
  after update of user_bucket on public.email_threads
  for each row when (old.user_bucket is distinct from new.user_bucket)
  execute function private.learn_from_correction();

create or replace function private.forget_sender_pref()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.email_threads t set status = 'pending', attempts = 0, updated_at = now()
  where t.household_id = old.household_id and t.from_email = old.sender_email and t.classified_by = 'learned';
  return old;
end;
$$;

create trigger sender_prefs_forget
  after delete on public.sender_prefs
  for each row execute function private.forget_sender_pref();

revoke all on function private.apply_sender_pref(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function private.learn_from_correction() from public, anon, authenticated;
revoke all on function private.forget_sender_pref() from public, anon, authenticated;

-- Seed from corrections you've already made
insert into public.sender_prefs (household_id, sender_email, votes_1, votes_2, votes_3)
select household_id, from_email,
       count(*) filter (where user_bucket = 1),
       count(*) filter (where user_bucket = 2),
       count(*) filter (where user_bucket = 3)
from public.email_threads
where user_bucket is not null and from_email is not null
group by household_id, from_email;

select private.apply_sender_pref(household_id, sender_email, null, null) from public.sender_prefs;
