-- ═══════════════════════════════════════════════════════════════════
--  001_core — households, members, tabs
--
--  Every table in this app belongs to a household. Access rule everywhere:
--    1. you are a member of that household, AND
--    2. you signed in with 2FA (session assurance level 'aal2').
--  A stolen password alone reads nothing.
--
--  Helper functions live in the `private` schema, which the browser API
--  (PostgREST) does not expose.
-- ═══════════════════════════════════════════════════════════════════

create schema if not exists private;

-- ── Tables ──────────────────────────────────────────────────────────

create table public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'America/Chicago',
  created_at  timestamptz not null default now()
);

create table public.household_members (
  household_id  uuid not null references public.households(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'member' check (role in ('owner', 'member')),
  display_name  text not null,
  created_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user_idx on public.household_members (user_id);

-- Tabs are data, not code: Church and School later are just new rows.
create table public.tabs (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  slug          text not null,              -- url segment: life, dfw, able
  name          text not null,              -- shown label
  sort_order    int  not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (household_id, slug)
);

-- ── Helpers ─────────────────────────────────────────────────────────

-- True when the signed-in user belongs to household `hh`.
-- security definer so policies on household_members don't recurse into themselves.
create or replace function private.is_member(hh uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hh and m.user_id = (select auth.uid())
  );
$$;

-- True when this session passed 2FA.
create or replace function private.has_2fa()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', 'aal1') = 'aal2';
$$;

grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.has_2fa() to authenticated;

-- ── Row-level security ──────────────────────────────────────────────

alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.tabs              enable row level security;

create policy "members read their household"
  on public.households for select to authenticated
  using (private.has_2fa() and private.is_member(id));

create policy "members read their household's members"
  on public.household_members for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));

-- Tabs policies: see 002_tabs_policy.sql
-- (Until it runs, RLS with no policy = nobody can read tabs. Safe default.)
