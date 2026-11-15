-- Resumable scans (45k-email mailboxes): counts build up step by step; Claude sorts at the end.
alter table public.retire_items
  add column kind_by_you boolean not null default false,   -- you moved it → a rescan won't override
  add column unsub_count int not null default 0,
  add column account_signals int not null default 0,
  add column wrote_to boolean not null default false,
  add column personal boolean not null default false;
grant update (kind_by_you) on public.retire_items to authenticated;
alter table public.connected_accounts add column retire_scan_state jsonb;  -- progress of a running scan
