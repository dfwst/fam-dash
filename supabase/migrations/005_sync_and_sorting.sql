-- ═══════════════════════════════════════════════════════════════════
--  005_sync_and_sorting — Milestone 2
--
--  email_threads : one row per inbox thread per account, with its sort result
--  sync_runs     : one row per account per sync (what happened, how long)
--  ai_usage      : every Claude API call with tokens + cost
--  app_secrets   : server-only values (the cron token); no browser access
--
--  Shadow mode: nothing here changes mail. The sync job only reads Gmail
--  and writes these tables.
-- ═══════════════════════════════════════════════════════════════════

create table public.email_threads (
  account_id        uuid not null references public.connected_accounts(id) on delete cascade,
  thread_id         text not null,                -- Gmail thread id
  household_id      uuid not null references public.households(id) on delete cascade,
  gmail_history_id  text,                         -- thread version; changes when anything in it changes
  last_message_id   text,                         -- re-sort only when this changes (a new message), not on read/label changes
  in_inbox          boolean not null default true, -- in INBOX within the 30-day sync window
  status            text not null default 'pending'
                    check (status in ('pending', 'classified', 'error')),
  attempts          int  not null default 0,
  last_error        text,

  -- What the dashboard shows (no message bodies are stored)
  subject           text,
  from_name         text,
  from_email        text,
  snippet           text,
  last_message_at   timestamptz,
  message_count     int,
  unread            boolean,
  last_from_me      boolean,                      -- you sent the latest message (they owe you)
  labels            text[],
  has_unsubscribe   boolean,

  -- Sort result
  bucket            smallint check (bucket in (1, 2, 3)),  -- 1 junk, 2 glance, 3 real
  priority          boolean not null default false,        -- declined payment, security, Resi
  category          text,
  summary           text,
  reason            text,
  group_key         text,                                  -- groups repeats ("church serving reminder")
  classified_by     text check (classified_by in ('rule', 'ai', 'fallback')),
  model             text,
  classified_at     timestamptz,
  classified_run_id uuid,

  -- Your correction from the Review screen (training data for better rules)
  user_bucket       smallint check (user_bucket in (1, 2, 3)),

  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (account_id, thread_id)
);
create index email_threads_household_idx on public.email_threads (household_id, in_inbox, bucket);
create index email_threads_status_idx    on public.email_threads (account_id, status);

create table public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  account_id    uuid references public.connected_accounts(id) on delete cascade,
  trigger       text not null check (trigger in ('scheduled', 'manual')),
  status        text not null default 'running' check (status in ('running', 'done', 'error')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  chain         int not null default 0,             -- how many follow-up invocations it took
  stats         jsonb not null default '{}'::jsonb,
  error         text
);
create index sync_runs_household_idx on public.sync_runs (household_id, started_at desc);
create index sync_runs_account_idx   on public.sync_runs (account_id, status);

create table public.ai_usage (
  id                  bigint generated always as identity primary key,
  household_id        uuid not null references public.households(id) on delete cascade,
  run_id              uuid references public.sync_runs(id) on delete set null,
  account_id          uuid references public.connected_accounts(id) on delete set null,
  thread_id           text,
  purpose             text not null default 'classify',
  model               text not null,
  input_tokens        int not null default 0,
  output_tokens       int not null default 0,
  cache_read_tokens   int not null default 0,
  cache_write_tokens  int not null default 0,
  cost_usd            numeric(12, 6) not null default 0,
  created_at          timestamptz not null default now()
);
create index ai_usage_household_idx on public.ai_usage (household_id, created_at desc);
create index ai_usage_run_idx       on public.ai_usage (run_id);

-- Per-account notes for the sorter ("Blake's daily inbox: never junk school mail")
alter table public.connected_accounts add column ai_context text;

create table public.app_secrets (
  name   text primary key,
  value  text not null
);
insert into public.app_secrets (name, value)
values ('cron_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));

-- ── Row-level security ──────────────────────────────────────────────
alter table public.email_threads enable row level security;
alter table public.sync_runs     enable row level security;
alter table public.ai_usage      enable row level security;
alter table public.app_secrets   enable row level security;

create policy "members read their household's threads"
  on public.email_threads for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));

-- The browser may change exactly one column: your bucket correction.
create policy "members correct their household's threads"
  on public.email_threads for update to authenticated
  using (private.has_2fa() and private.is_member(household_id))
  with check (private.has_2fa() and private.is_member(household_id));
revoke insert, update, delete on public.email_threads from anon, authenticated;
grant update (user_bucket) on public.email_threads to authenticated;

create policy "members read their household's runs"
  on public.sync_runs for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
revoke insert, update, delete on public.sync_runs from anon, authenticated;

create policy "members read their household's AI usage"
  on public.ai_usage for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
revoke insert, update, delete on public.ai_usage from anon, authenticated;

revoke all on public.app_secrets from anon, authenticated;
