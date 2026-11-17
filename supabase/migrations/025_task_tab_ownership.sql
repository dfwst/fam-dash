-- Moving a To-Do between lists: it can go to a shared tab, or to a private tab of the person
-- doing it (a shared item moved onto your own list becomes yours). Never onto someone else's private tab.
create or replace function private.check_task_links() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tab_owner uuid;
begin
  if new.tab_id is not null then
    select owner_id into tab_owner from public.tabs where id = new.tab_id and household_id = new.household_id;
    if not found then raise exception 'tab not in household'; end if;
    if tab_owner is not null and new.owner_id is distinct from tab_owner then
      if tab_owner = auth.uid() then new.owner_id := tab_owner;
      else raise exception 'tab not yours'; end if;
    end if;
  end if;
  if new.account_id is not null and not exists (
    select 1 from public.connected_accounts where id = new.account_id and household_id = new.household_id) then
    raise exception 'account not in household';
  end if;
  new.updated_at := now();
  return new;
end $$;
