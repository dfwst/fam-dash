-- A shared account's mail must land on a tab everyone can see. If it's shared while pointing
-- at someone's private tab, it moves to the household's Shared tab.
create or replace function private.shared_account_tab() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.shared and new.default_tab_id is not null and exists (
       select 1 from public.tabs t where t.id = new.default_tab_id and t.owner_id is not null) then
    select t.id into new.default_tab_id from public.tabs t
     where t.household_id = new.household_id and t.slug = 'shared' and t.owner_id is null limit 1;
  end if;
  return new;
end $$;

drop trigger if exists shared_account_tab on public.connected_accounts;
create trigger shared_account_tab before insert or update of shared, default_tab_id on public.connected_accounts
  for each row execute function private.shared_account_tab();

-- Fix accounts already in that state
update public.connected_accounts set shared = shared where shared;
