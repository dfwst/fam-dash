// Start a sync for every connected account. Two callers:
//   - pg_cron, weekdays at 11:30 and 12:30 UTC, with header x-cron-token.
//     Only the call that lands at 6am in the household's timezone does anything
//     (that's how 6:30 Central works through daylight saving time).
//   - The Review screen's "Sync now" button (signed in, 2FA).
// Each account gets its own sync_run and its own sync-account worker. Returns right away.
import { adminClient, requireMember, SB_URL } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';

const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WORKER = `${SB_URL}/functions/v1/sync-account`;

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const localHour = (tz: string) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const admin = adminClient();

  let householdIds: string[];
  let trigger: 'scheduled' | 'manual';

  const cronToken = req.headers.get('x-cron-token');
  if (cronToken) {
    const { data } = await admin.from('app_secrets').select('value').eq('name', 'cron_token').single();
    if (!data || !sameSecret(cronToken, data.value)) return json({ error: 'forbidden' }, 403);
    trigger = 'scheduled';
    const { data: hhs } = await admin.from('households').select('id, timezone');
    householdIds = (hhs ?? []).filter(h => localHour(h.timezone) === 6).map(h => h.id);
    if (!householdIds.length) return json({ skipped: 'not 6am local time' });
  } else {
    const ctx = await requireMember(req);
    if (ctx instanceof Response) return ctx;
    householdIds = [ctx.householdId];
    trigger = 'manual';
  }

  // Runs stuck in 'running' for 30+ minutes died somewhere — close them out
  await admin.from('sync_runs')
    .update({ status: 'error', error: 'timed out', finished_at: new Date().toISOString() })
    .eq('status', 'running').lt('started_at', new Date(Date.now() - 30 * 60_000).toISOString());

  const { data: accounts } = await admin.from('connected_accounts')
    .select('id, household_id').in('household_id', householdIds)
    .eq('status', 'active');

  const runIds: string[] = [];
  let skipped = 0;
  for (const a of accounts ?? []) {
    const { data: busy } = await admin.from('sync_runs').select('id')
      .eq('account_id', a.id).eq('status', 'running').limit(1);
    if (busy?.length) { skipped++; continue; } // already syncing — don't double up

    const { data: run, error } = await admin.from('sync_runs')
      .insert({ household_id: a.household_id, account_id: a.id, trigger }).select('id').single();
    if (error || !run) continue;

    await fetch(WORKER, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: run.id, chain: 0 }),
    });
    runIds.push(run.id);
  }

  return json({ started: runIds.length, skipped, runIds });
});
