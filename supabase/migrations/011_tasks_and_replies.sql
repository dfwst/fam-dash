-- ═══════════════════════════════════════════════════════════════════
--  011_tasks_and_replies — Milestone 5
--
--  tasks      : your own To-Do items. Typed in by hand, or made from an email
--               ("Add to To-Do") — then they keep a link back to that email.
--               Each lives on a tab (Life, DFW Smart Tech, …).
--  action_log : now also records replies you send ('reply'). Sent mail can't be
--               un-sent, so reply rows are history only (no Undo).
-- ═══════════════════════════════════════════════════════════════════

create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  tab_id        uuid references public.tabs(id) on delete set null,
  title         text not null check (length(btrim(title)) between 1 and 300),
  notes         text check (length(notes) <= 4000),
  due_on        date,
  done_at       timestamptz,
  -- the email it came from (optional)
  account_id    uuid references public.connected_accounts(id) on delete set null,
  thread_id     text,
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index tasks_open_idx on public.tasks (household_id, tab_id) where done_at is null;

alter table public.tasks enable row level security;

create policy "members read their household's tasks"
  on public.tasks for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
create policy "members add tasks to their household"
  on public.tasks for insert to authenticated
  with check (private.has_2fa() and private.is_member(household_id));
create policy "members change their household's tasks"
  on public.tasks for update to authenticated
  using (private.has_2fa() and private.is_member(household_id))
  with check (private.has_2fa() and private.is_member(household_id));
create policy "members delete their household's tasks"
  on public.tasks for delete to authenticated
  using (private.has_2fa() and private.is_member(household_id));

revoke all on public.tasks from anon;
grant select, insert, update, delete on public.tasks to authenticated;

-- A task's tab and email must belong to the same household as the task
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

create trigger tasks_check_links before insert or update on public.tasks
  for each row execute function private.check_task_links();

-- Replies show up in Review → Activity
alter table public.action_log drop constraint action_log_action_check;
alter table public.action_log add constraint action_log_action_check
  check (action in ('archive', 'unarchive', 'snooze', 'unsnooze', 'create_filter', 'delete_filter', 'reply'));
