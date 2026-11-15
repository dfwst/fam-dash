-- "Retire this address": which companies / people still have this email address, and your
-- progress moving them to a new one. Built from a header scan of the whole mailbox.
alter table public.connected_accounts
  add column retiring boolean not null default false,
  add column retire_scanned_at timestamptz;
grant update (retiring) on public.connected_accounts to authenticated;

create table public.retire_items (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  account_id      uuid not null references public.connected_accounts(id) on delete cascade,
  group_key       text not null,             -- company domain (amazon.com) or a person's address
  name            text not null,             -- "Amazon", "Ann Doe"
  kind            text not null check (kind in ('update', 'unsubscribe', 'person', 'ignore')),
  reason          text,                      -- why: "order receipts + password resets"
  message_count   int not null default 0,
  first_seen      timestamptz,
  last_seen       timestamptz,
  samples         text[] not null default '{}',   -- a few recent subjects
  sender          text,                      -- a typical from-address
  unsubscribe     text,                      -- List-Unsubscribe link (https or mailto) if any
  status          text not null default 'todo' check (status in ('todo', 'done', 'skipped')),
  done_at         timestamptz,
  flagged_at      timestamptz,               -- emailed the old address again after you started retiring it
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (account_id, group_key)
);
create index retire_items_account_idx on public.retire_items (account_id, kind, status);

alter table public.retire_items enable row level security;
create policy "members read their household's retire list"
  on public.retire_items for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
create policy "members update their household's retire list"
  on public.retire_items for update to authenticated
  using (private.has_2fa() and private.is_member(household_id))
  with check (private.has_2fa() and private.is_member(household_id));
revoke insert, update, delete on public.retire_items from anon, authenticated;
grant update (status, done_at, kind, flagged_at, updated_at) on public.retire_items to authenticated;
