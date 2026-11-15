-- IMAP accounts (Yahoo, AOL, iCloud, other) with app passwords
alter table public.connected_accounts drop constraint connected_accounts_provider_check;
alter table public.connected_accounts add constraint connected_accounts_provider_check
  check (provider in ('google', 'microsoft', 'imap'));
alter table public.connected_accounts add column mail_service text
  check (mail_service is null or mail_service in ('yahoo', 'aol', 'icloud', 'other'));
comment on column public.connected_accounts.mail_service is 'IMAP accounts: which service (shapes setup help + labels)';
comment on column public.account_secrets.refresh_token_enc is 'Encrypted: Google/Microsoft refresh token, or for IMAP a JSON blob of server settings + app password';
