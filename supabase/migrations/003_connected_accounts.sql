-- ═══════════════════════════════════════════════════════════════════
--  003_connected_accounts — mail accounts, their (encrypted) tokens,
--  and short-lived OAuth "state" values
--
--  connected_accounts : visible to the household (2FA). No browser writes.
--  account_secrets    : NO policies + privileges revoked → Edge Functions only.
--  oauth_states       : same. Ties a Google redirect back to the user who
--                       started it, expires after 10 minutes.
-- ═══════════════════════════════════════════════════════════════════

create table public.connected_accounts (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  provider        text not null check (provider in ('google', 'microsoft')),
  email           text not null,
  default_tab_id  uuid references public.tabs(id) on delete set null,
  -- What the sync job may do to this mailbox:
  --   read_only  : look, never change anything (every account starts here)
  --   junk_only  : may archive bucket 1 only (Blake's inbox)
  --   full       : may archive buckets 1 and 2
  -- Bucket 3 is never archived by the job, under any policy.
  policy          text not null default 'read_only'
                  check (policy in ('read_only', 'junk_only', 'full')),
  status          text not null default 'active'
                  check (status in ('active', 'needs_reconnect', 'disabled')),
  history_id      text,          -- Gmail history checkpoint (Milestone 2)
  last_synced_at  timestamptz,
  connected_by    uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (household_id, provider, email)
);

create table public.account_secrets (
  account_id         uuid primary key references public.connected_accounts(id) on delete cascade,
  refresh_token_enc  text not null,      -- 'v1:<iv b64>:<ciphertext b64>' (AES-256-GCM)
  scopes             text not null,
  updated_at         timestamptz not null default now()
);

create table public.oauth_states (
  state         text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  household_id  uuid not null references public.households(id) on delete cascade,
  expires_at    timestamptz not null default now() + interval '10 minutes'
);

alter table public.connected_accounts enable row level security;
alter table public.account_secrets    enable row level security;
alter table public.oauth_states       enable row level security;

create policy "members read their household's accounts"
  on public.connected_accounts for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));

-- Belt and braces: even if someone adds a policy by mistake later,
-- the browser roles have no table privileges on the secret tables.
revoke all on public.account_secrets from anon, authenticated;
revoke all on public.oauth_states    from anon, authenticated;
