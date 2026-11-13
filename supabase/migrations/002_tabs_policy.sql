-- ═══════════════════════════════════════════════════════════════════
--  002_tabs_policy — who can read the tabs table
--
--  Available helpers (from 001_core):
--    private.has_2fa()        → true when this session passed 2FA
--    private.is_member(uuid)  → true when the signed-in user belongs to that household
--
--  Pattern to copy (from 001_core):
--    create policy "members read their household's members"
--      on public.household_members for select to authenticated
--      using (private.has_2fa() and private.is_member(household_id));
-- ═══════════════════════════════════════════════════════════════════

-- Read-only from the browser: no insert/update/delete policies, so those are refused.
-- 2FA applies here too: tab names (e.g. a future School tab) say something about the family.
create policy "members read their household's tabs"
  on public.tabs for select to authenticated
  using (private.has_2fa() and private.is_member(household_id));


-- Seed the three Phase 1 tabs for every household (only adds missing ones).
insert into public.tabs (household_id, slug, name, sort_order)
select h.id, t.slug, t.name, t.sort_order
from public.households h
cross join (values ('life', 'Life', 1), ('dfw', 'DFW Smart Tech', 2), ('able', 'ABLe', 3))
  as t(slug, name, sort_order)
on conflict (household_id, slug) do nothing;
