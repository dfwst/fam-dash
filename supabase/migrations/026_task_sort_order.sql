-- Your own order within a list (drag to rearrange). Null = not placed yet → after placed items.
alter table public.tasks add column if not exists sort_order double precision;
