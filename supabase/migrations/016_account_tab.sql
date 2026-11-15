-- Settings: choose which tab an account's mail shows on (that column only, same update policy)
grant update (default_tab_id) on public.connected_accounts to authenticated;

create or replace function private.check_account_tab() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.default_tab_id is not null and not exists (
    select 1 from public.tabs where id = new.default_tab_id and household_id = new.household_id) then
    raise exception 'tab not in household';
  end if;
  return new;
end $$;

create trigger connected_accounts_check_tab before insert or update of default_tab_id on public.connected_accounts
  for each row execute function private.check_account_tab();
