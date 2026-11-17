-- ═══════════════════════════════════════════════════════════════════
--  023_rules — household rules ("everything about Karen Williams → Karen tab")
--
--  A rule matches an email two ways:
--    exact  — any of `phrases` in the sender, subject, recipients or text; or a sender in `senders`
--             (full address or a whole domain)
--    smart  — `description` in plain words; Claude judges it while sorting (no extra call)
--  A match puts THAT email on the rule's tab (email_threads.tab_id), can force it Real (never
--  auto-archived), can add a Gmail label, and — if share_matches — makes just that email
--  visible to everyone in the household, even when it arrived in someone's private account.
-- ═══════════════════════════════════════════════════════════════════

create table public.rules (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 60),
  tab_id          uuid references public.tabs(id) on delete set null,
  phrases         text[] not null default '{}',
  senders         text[] not null default '{}',
  description     text check (length(description) <= 1000),
  share_matches   boolean not null default true,
  always_real     boolean not null default true,
  gmail_label     text check (length(gmail_label) <= 40),
  gmail_label_ids jsonb not null default '{}'::jsonb,   -- { account_id: Gmail label id }
  enabled         boolean not null default true,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index rules_household_idx on public.rules (household_id) where enabled;

alter table public.rules enable row level security;
-- Rules are household settings: everyone in the household sees them (writes go through the rules function)
create policy "members read their household's rules" on public.rules for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));
revoke insert, update, delete on public.rules from anon, authenticated;

-- Per-email routing + sharing
alter table public.email_threads
  add column tab_id  uuid references public.tabs(id) on delete set null,   -- overrides the account's tab
  add column rule_id uuid references public.rules(id) on delete set null,
  add column shared  boolean not null default false;                       -- visible to the household
create index email_threads_tab_idx on public.email_threads (tab_id) where tab_id is not null;

-- Seeing an email: your account (or a shared account) as before, OR a rule shared this email
drop policy "people read mail they can see" on public.email_threads;
drop policy "people correct mail they can see" on public.email_threads;
create policy "people read mail they can see" on public.email_threads for select to authenticated
  using (private.has_2fa() and (private.can_see_account(account_id) or (shared and private.is_member(household_id))));
create policy "people correct mail they can see" on public.email_threads for update to authenticated
  using (private.has_2fa() and private.can_see_account(account_id))
  with check (private.has_2fa() and private.can_see_account(account_id));

-- Removing a rule puts its emails back where they came from (and unshares them)
create or replace function private.release_rule_threads() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.email_threads set tab_id = null, shared = false, updated_at = now() where rule_id = old.id;
  return old;
end $$;
create trigger rules_release before delete on public.rules
  for each row execute function private.release_rule_threads();
revoke all on function private.release_rule_threads() from public, anon, authenticated;
