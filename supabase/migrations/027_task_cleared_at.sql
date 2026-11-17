-- A ticked-off to-do stays on its list (crossed out, at the bottom) until you clear it.
alter table public.tasks add column if not exists cleared_at timestamptz;
-- Items finished before this change were already gone - keep them gone.
update public.tasks set cleared_at = done_at where done_at is not null and cleared_at is null;
