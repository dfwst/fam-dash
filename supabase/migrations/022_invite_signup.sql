-- Public sign-ups stay OFF: an invite link is the only way to create a login.
-- Each invite can create exactly one login (signup_user_id), and only that login can use it to join.
alter table public.household_invites add column signup_user_id uuid references auth.users(id) on delete set null;
