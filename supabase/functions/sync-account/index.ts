// Internal worker: sync + sort ONE account for ONE sync_run. Called by sync-run (and by itself).
// Auth: Bearer <service role key> — never called from the browser.
//
// Shadow mode (Milestone 2): reads Gmail, writes rlyfe's tables. Never changes mail.
//
// 1. discover  (first invocation only)
//    List INBOX threads from the last 30 days — each comes with a historyId (its version).
//    New or changed version → mark 'pending'. Threads no longer listed → in_inbox = false.
// 2. sort      Work through 'pending' threads ~110s at a time: rules first, Claude if needed.
// 3. chain     More left? Call ourselves again with chain+1 (keeps each call under the time limit).
// 4. finalize  Record counts + cost on the run.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { adminClient, SB_URL } from '../_shared/auth.ts';
import { json } from '../_shared/http.ts';
import { gmail } from '../_shared/google.ts';
import { accessTokenFor, NeedsReconnect } from '../_shared/accounts.ts';
import { threadFacts, type GmailThread } from '../_shared/gmail-parse.ts';
import { applyRules, safetyCheck, type Sort } from '../_shared/rules.ts';
import { classifyWithClaude } from '../_shared/classify.ts';

const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SELF = `${SB_URL}/functions/v1/sync-account`;
const WINDOW = 'newer_than:30d';
const BUDGET_MS = 110_000;
const CONCURRENCY = 5;
const MAX_CHAIN = 40;
const MAX_ATTEMPTS = 3;

type Acct = { id: string; email: string; policy: string; ai_context: string | null; household_id: string };
type Stats = Record<string, number>;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  if (req.headers.get('Authorization') !== `Bearer ${SERVICE_KEY}`) return json({ error: 'forbidden' }, 403);
  const { runId, chain = 0 } = await req.json().catch(() => ({}));
  if (!runId) return json({ error: 'runId required' }, 400);
  EdgeRuntime.waitUntil(work(runId, chain));
  return json({ accepted: true }, 202);
});

async function work(runId: string, chain: number) {
  const admin = adminClient();
  const started = Date.now();

  const { data: run } = await admin.from('sync_runs')
    .select('id, account_id, status, stats').eq('id', runId).single();
  if (!run || run.status !== 'running') return;

  const { data: acct } = await admin.from('connected_accounts')
    .select('id, email, policy, ai_context, household_id').eq('id', run.account_id).single<Acct>();
  if (!acct) return;

  const stats: Stats = { ...(run.stats ?? {}) };
  try {
    const token = await accessTokenFor(admin, acct.id);
    if (chain === 0) Object.assign(stats, await discover(admin, acct, token));

    const remaining = await sortPending(admin, acct, token, runId, started, stats);

    if (remaining > 0 && chain < MAX_CHAIN) {
      await admin.from('sync_runs').update({ stats, chain: chain + 1 }).eq('id', runId);
      await fetch(SELF, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, chain: chain + 1 }),
      });
      return;
    }

    await finalize(admin, acct, runId, stats, remaining);
  } catch (e) {
    const msg = e instanceof NeedsReconnect ? 'needs-reconnect' : (e instanceof Error ? e.message : String(e));
    console.error('sync-account failed', acct.email, msg);
    await admin.from('sync_runs')
      .update({ status: 'error', error: msg, stats, finished_at: new Date().toISOString() })
      .eq('id', runId);
  }
}

// ── 1. discover ─────────────────────────────────────────────────────

async function discover(admin: SupabaseClient, acct: Acct, token: string): Promise<Stats> {
  const listed: { id: string; historyId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const r = await gmail<{ threads?: { id: string; historyId: string }[]; nextPageToken?: string }>(
      'threads', token,
      { labelIds: 'INBOX', q: WINDOW, maxResults: '500', ...(pageToken ? { pageToken } : {}) });
    listed.push(...(r.threads ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken && listed.length < 5000);

  const existing = await selectAll<{ thread_id: string; gmail_history_id: string | null; in_inbox: boolean }>(
    admin, 'email_threads', 'thread_id, gmail_history_id, in_inbox', q => q.eq('account_id', acct.id));
  const known = new Map(existing.map(r => [r.thread_id, r]));

  const now = new Date().toISOString();
  const changed = listed.filter(t => {
    const k = known.get(t.id);
    return !k || k.gmail_history_id !== t.historyId || !k.in_inbox;
  });
  for (const chunk of chunks(changed, 500)) {
    const { error } = await admin.from('email_threads').upsert(chunk.map(t => ({
      account_id: acct.id, thread_id: t.id, household_id: acct.household_id,
      gmail_history_id: t.historyId, in_inbox: true, status: 'pending', attempts: 0, updated_at: now,
    })));
    if (error) throw error;
  }

  const listedIds = new Set(listed.map(t => t.id));
  const gone = existing.filter(r => r.in_inbox && !listedIds.has(r.thread_id)).map(r => r.thread_id);
  for (const chunk of chunks(gone, 200)) {
    await admin.from('email_threads').update({ in_inbox: false, updated_at: now })
      .eq('account_id', acct.id).in('thread_id', chunk);
  }

  return { inbox_threads: listed.length, new_or_changed: changed.length, left_inbox: gone.length };
}

// ── 2. sort ─────────────────────────────────────────────────────────

type Row = { thread_id: string; last_message_id: string | null; bucket: number | null; attempts: number };

async function sortPending(
  admin: SupabaseClient, acct: Acct, token: string, runId: string, started: number, stats: Stats,
): Promise<number> {
  const bump = (k: string, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };
  const failed = new Set<string>(); // failed this invocation → retried by the next one, not now

  while (Date.now() - started < BUDGET_MS) {
    let q = admin.from('email_threads')
      .select('thread_id, last_message_id, bucket, attempts')
      .eq('account_id', acct.id).in('status', ['pending', 'error']).lt('attempts', MAX_ATTEMPTS);
    if (failed.size) q = q.not('thread_id', 'in', `(${[...failed].join(',')})`);
    const { data: batch } = await q.order('first_seen_at', { ascending: false }).limit(CONCURRENCY * 4);
    const todo = (batch ?? []) as Row[];
    if (!todo.length) break;

    await pool(todo, CONCURRENCY, async (row) => {
      if (Date.now() - started > BUDGET_MS) return;
      try {
        const full = await gmail<GmailThread>(`threads/${row.thread_id}`, token, { format: 'full' });
        const f = threadFacts(full, acct.email);
        const base = {
          gmail_history_id: full.historyId, last_message_id: f.lastMessageId,
          subject: f.subject.slice(0, 300), from_name: f.fromName.slice(0, 200), from_email: f.fromEmail,
          snippet: f.snippet.slice(0, 300), last_message_at: f.date.toISOString(),
          message_count: f.messageCount, unread: f.unread, last_from_me: f.lastFromMe,
          labels: f.labels, has_unsubscribe: f.hasUnsubscribe,
          status: 'classified', attempts: 0, last_error: null, updated_at: new Date().toISOString(),
        };

        // Only read/label changes since last sort → refresh the details, keep the sort (no AI cost)
        if (row.bucket != null && row.last_message_id === f.lastMessageId) {
          await save(admin, acct.id, row.thread_id, base);
          bump('unchanged');
          return;
        }

        let sort: Sort | null = applyRules(f);
        if (sort) {
          bump('by_rule');
        } else {
          const ai = await classifyWithClaude(f, acct);
          sort = ai.sort;
          bump(sort.by === 'ai' ? 'by_ai' : 'fallback');
          await admin.from('ai_usage').insert({
            household_id: acct.household_id, run_id: runId, account_id: acct.id, thread_id: row.thread_id,
            purpose: 'classify', model: sort.model ?? 'unknown',
            input_tokens: ai.usage.input, output_tokens: ai.usage.output,
            cache_read_tokens: ai.usage.cacheRead, cache_write_tokens: ai.usage.cacheWrite,
            cost_usd: ai.usage.cost,
          });
        }
        sort = safetyCheck(f, sort);

        await save(admin, acct.id, row.thread_id, {
          ...base,
          bucket: sort.bucket, priority: sort.priority, category: sort.category,
          summary: sort.summary.slice(0, 600), reason: sort.reason.slice(0, 200), group_key: sort.group_key,
          classified_by: sort.by, model: sort.model ?? null,
          classified_at: new Date().toISOString(), classified_run_id: runId,
        });
        bump('sorted');
      } catch (e) {
        if (e instanceof NeedsReconnect) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        console.error('sort failed', row.thread_id, msg);
        failed.add(row.thread_id);
        bump('errors');
        await save(admin, acct.id, row.thread_id, {
          status: 'error', attempts: row.attempts + 1, last_error: msg.slice(0, 300),
          updated_at: new Date().toISOString(),
        }).catch(() => {});
      }
    });
  }

  const { count } = await admin.from('email_threads')
    .select('thread_id', { count: 'exact', head: true })
    .eq('account_id', acct.id).in('status', ['pending', 'error']).lt('attempts', MAX_ATTEMPTS);
  return count ?? 0;
}

async function save(admin: SupabaseClient, accountId: string, threadId: string, values: Record<string, unknown>) {
  const { error } = await admin.from('email_threads').update(values)
    .eq('account_id', accountId).eq('thread_id', threadId);
  if (error) throw error;
}

// ── 4. finalize ─────────────────────────────────────────────────────

async function finalize(admin: SupabaseClient, acct: Acct, runId: string, stats: Stats, remaining: number) {
  const usage = await selectAll<{ cost_usd: number }>(admin, 'ai_usage', 'cost_usd', q => q.eq('run_id', runId));
  const inbox = await selectAll<{ bucket: number | null; priority: boolean }>(
    admin, 'email_threads', 'bucket, priority',
    q => q.eq('account_id', acct.id).eq('in_inbox', true).eq('status', 'classified'));

  const final = {
    ...stats,
    ai_calls: usage.length,
    cost_usd: Number(usage.reduce((s, u) => s + Number(u.cost_usd), 0).toFixed(6)),
    inbox_bucket_1: inbox.filter(t => t.bucket === 1).length,
    inbox_bucket_2: inbox.filter(t => t.bucket === 2).length,
    inbox_bucket_3: inbox.filter(t => t.bucket === 3).length,
    inbox_priority: inbox.filter(t => t.priority).length,
    unfinished: remaining,
  };
  const now = new Date().toISOString();
  await admin.from('sync_runs').update({ status: 'done', stats: final, finished_at: now }).eq('id', runId);
  await admin.from('connected_accounts').update({ last_synced_at: now }).eq('id', acct.id);
}

// ── helpers ─────────────────────────────────────────────────────────

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// PostgREST returns at most 1000 rows per request — page through everything
// deno-lint-ignore no-explicit-any
async function selectAll<T>(admin: SupabaseClient, table: string, cols: string, filter: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(admin.from(table).select(cols)).range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}
