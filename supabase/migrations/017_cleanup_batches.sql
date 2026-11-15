-- One-time "clean up old mail" runs (IMAP accounts): what was archived, so it can be put back.
create table public.cleanup_batches (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  account_id    uuid not null references public.connected_accounts(id) on delete cascade,
  cutoff        timestamptz not null,           -- archived inbox mail received before this
  status        text not null default 'running' check (status in ('running', 'done', 'undoing', 'undone')),
  archived      int not null default 0,
  kept          int not null default 0,
  message_ids   text[] not null default '{}',   -- Message-IDs moved to Archive
  unread_ids    text[] not null default '{}',   -- of those, the ones that were unread
  restored      int not null default 0,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  undone_at     timestamptz
);
create index cleanup_batches_account_idx on public.cleanup_batches (account_id, created_at desc);

alter table public.cleanup_batches enable row level security;
create policy "members read their household's cleanups"
  on public.cleanup_batches for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
revoke insert, update, delete on public.cleanup_batches from anon, authenticated;
