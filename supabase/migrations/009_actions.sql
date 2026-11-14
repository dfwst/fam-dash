-- ═══════════════════════════════════════════════════════════════════
--  009_actions — Milestone 4: quick actions, auto-archive, undo
--
--  action_log   : every change rlyfe makes to Gmail (or to a snooze), by you or
--                 by the morning sync, with what's needed to undo it.
--  email_threads: snoozed_until (Remind me), acted/acted_at (Done / Ignored / archived)
--  sender_prefs : ignore_count + always_ignore + the Gmail filter ids it created
--  connected_accounts.policy is now changeable from Settings (only that column).
--
--  Archive = remove the INBOX label. Nothing is ever deleted or trashed.
-- ═══════════════════════════════════════════════════════════════════

alter table public.email_threads
  add column snoozed_until timestamptz,
  add column acted         text check (acted in ('done', 'ignored', 'archived')),
  add column acted_at      timestamptz;

create table public.action_log (
  id            bigint generated always as identity primary key,
  household_id  uuid not null references public.households(id) on delete cascade,
  account_id    uuid references public.connected_accounts(id) on delete cascade,
  thread_id     text,
  action        text not null check (action in ('archive', 'unarchive', 'snooze', 'unsnooze', 'create_filter', 'delete_filter')),
  source        text not null check (source in ('user', 'sync')),
  reason        text,
  user_id       uuid references auth.users(id) on delete set null,
  payload       jsonb not null default '{}'::jsonb,   -- was_unread, subject, from, filter_id…
  created_at    timestamptz not null default now(),
  undone_at     timestamptz
);
create index action_log_household_idx on public.action_log (household_id, created_at desc);
create index action_log_thread_idx    on public.action_log (account_id, thread_id);

alter table public.action_log enable row level security;
create policy "members read their household's action log"
  on public.action_log for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
revoke insert, update, delete on public.action_log from anon, authenticated;

alter table public.sender_prefs
  add column ignore_count  int not null default 0,
  add column always_ignore boolean not null default false,
  add column gmail_filters jsonb not null default '{}'::jsonb;  -- { account_id: filter_id }

-- Cleanup policy: the one account setting the browser may change
create policy "members change their household's account policy"
  on public.connected_accounts for update to authenticated
  using (private.has_2fa() and private.is_member(household_id))
  with check (private.has_2fa() and private.is_member(household_id));
revoke update on public.connected_accounts from anon, authenticated;
grant update (policy) on public.connected_accounts to authenticated;
