-- Settings: you can rename each account's short label ("tsagmail") — that column only.
-- Row access is still the M4 update policy (2FA + household member).
alter table public.connected_accounts
  add constraint connected_accounts_nickname_len check (nickname is null or length(btrim(nickname)) between 1 and 24);
grant update (nickname) on public.connected_accounts to authenticated;
