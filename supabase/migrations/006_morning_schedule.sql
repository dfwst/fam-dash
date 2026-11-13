-- ═══════════════════════════════════════════════════════════════════
--  006_morning_schedule — weekday morning sync at 6:30 Central
--
--  pg_cron runs in UTC, and Central time shifts by an hour for daylight
--  saving. So we schedule BOTH 11:30 and 12:30 UTC (6:30 CDT and 6:30 CST);
--  sync-run checks the household's local clock and only the call that lands
--  at 6am does anything. The other returns "skipped".
--
--  pg_net sends the request; the x-cron-token header (stored in app_secrets,
--  readable only server-side) proves the call came from here.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function private.trigger_morning_sync()
returns void
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url     := 'https://obubqqolwnglbafaqdbp.supabase.co/functions/v1/sync-run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-token', (select value from public.app_secrets where name = 'cron_token')
    ),
    body    := '{"scheduled": true}'::jsonb,
    timeout_milliseconds := 20000
  );
$$;
revoke all on function private.trigger_morning_sync() from public, anon, authenticated;

select cron.schedule('rlyfe-sync-0630-cdt', '30 11 * * 1-5', $$ select private.trigger_morning_sync(); $$);
select cron.schedule('rlyfe-sync-0630-cst', '30 12 * * 1-5', $$ select private.trigger_morning_sync(); $$);
