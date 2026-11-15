// Internal worker: sync + sort ONE account (Gmail or Microsoft) for ONE sync_run.
// Called by sync-run (and by itself). Talks to mail only through the Mailbox layer.
// Auth: Bearer <service role key> — never called from the browser.
//
// Changes mail ONLY in step 4, and only on accounts whose cleanup policy isn't read_only:
//   junk_only → archive Junk;  full → archive Junk + Glance.  Real is never touched.
//
// 1. discover  (first invocation only)
//    List INBOX threads from the last 30 days — each comes with a historyId (its version).
//    New or changed version → mark 'pending'. Threads no longer listed → in_inbox = false.
// 2. sort      Work through 'pending' threads ~110s at a time:
//              learned sender preference → free rules → Claude (with your corrections as examples)
//              → safety net (priority mail always bucket 3).
// 3. chain     More left? Call ourselves again with chain+1 (keeps each call under the time limit).
// 4. archive   Clean up per the account's policy (archive + mark read, logged with undo).
// 5. finalize  Record counts + cost on the run.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { adminClient, SB_URL } from '../_shared/auth.ts';
import { json } from '../_shared/http.ts';
import { NeedsReconnect, type Provider } from '../_shared/accounts.ts';
import { openMailbox, type Mailbox } from '../_shared/mailbox.ts';
import { threadFacts } from '../_shared/gmail-parse.ts';
import { applyRules, safetyCheck, type Sort } from '../_shared/rules.ts';
import { classifyWithClaude, type Correction } from '../_shared/classify.ts';
import { flagArrival } from '../_shared/retire.ts';

const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SELF = `${SB_URL}/functions/v1/sync-account`;
const WINDOW_DAYS = 30;
const BUDGET_MS = 110_000;
const CONCURRENCY = 3; // per-mailbox rate limits; both providers' helpers also back off if we hit them
const MAX_CHAIN = 40;
const MAX_ATTEMPTS = 3;

type Acct = {
  id: string; email: string; provider: Provider; policy: string; ai_context: string | null; household_id: string;
  retiring: boolean; retire_scanned_at: string | null;
};
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
    .select('id, email, provider, policy, ai_context, household_id, retiring, retire_scanned_at').eq('id', run.account_id).single<Acct>();
  if (!acct) return;

  const stats: Stats = { ...(run.stats ?? {}) };
  let mb: Mailbox | null = null;
  try {
    mb = await openMailbox(admin, acct);
    if (chain === 0) Object.assign(stats, await discover(admin, acct, mb));

    const remaining = await sortPending(admin, acct, mb, runId, started, stats);

    if (remaining > 0 && chain < MAX_CHAIN) {
      await admin.from('sync_runs').update({ stats, chain: chain + 1 }).eq('id', runId);
      await fetch(SELF, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, chain: chain + 1 }),
      });
      return;
    }

    if (acct.provider === 'imap') await applyIgnoreRules(admin, acct, mb, runId, stats);
    await autoArchive(admin, acct, mb, runId, stats);
    await finalize(admin, acct, runId, stats, remaining);
  } catch (e) {
    const msg = e instanceof NeedsReconnect ? 'needs-reconnect' : (e instanceof Error ? e.message : String(e));
    console.error('sync-account failed', acct.email, msg);
    await admin.from('sync_runs')
      .update({ status: 'error', error: msg, stats, finished_at: new Date().toISOString() })
      .eq('id', runId);
  } finally {
    await mb?.close?.();
  }
}

// ── 1. discover ─────────────────────────────────────────────────────

// gmail_history_id holds each thread's version (Gmail historyId, or Microsoft's newest-change stamp)
async function discover(admin: SupabaseClient, acct: Acct, mb: Mailbox): Promise<Stats> {
  const listed = (await mb.listInbox(WINDOW_DAYS)).map(t => ({ id: t.id, historyId: t.version }));

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
  admin: SupabaseClient, acct: Acct, mb: Mailbox, runId: string, started: number, stats: Stats,
): Promise<number> {
  const bump = (k: string, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };
  const failed = new Set<string>(); // failed this invocation → retried by the next one, not now

  // What you've taught it: sender → bucket, plus recent corrections to show Claude
  const { data: prefRows } = await admin.from('sender_prefs')
    .select('sender_email, bucket').eq('household_id', acct.household_id).not('bucket', 'is', null);
  const learned = new Map<string, 1 | 2 | 3>((prefRows ?? []).map(p => [p.sender_email, p.bucket]));
  // Company-wide choices from the Review queue ("everything from linkedin.com is Junk")
  const { data: domainRows } = await admin.from('domain_prefs')
    .select('domain, bucket').eq('household_id', acct.household_id);
  const domainPref = new Map<string, 1 | 2 | 3>((domainRows ?? []).map(d => [d.domain, d.bucket]));
  const { data: corrRows } = await admin.from('email_threads')
    .select('subject, from_name, from_email, bucket, user_bucket')
    .eq('household_id', acct.household_id).not('user_bucket', 'is', null)
    .order('updated_at', { ascending: false }).limit(200);
  const corrections = (corrRows ?? []) as Correction[];
  const examplesFor = (fromEmail: string) => {
    const domain = '@' + (fromEmail.split('@')[1] ?? '');
    const same = corrections.filter(c => c.from_email?.endsWith(domain));
    const rest = corrections.filter(c => !c.from_email?.endsWith(domain));
    return [...same.slice(0, 5), ...rest].slice(0, 8);
  };

  while (Date.now() - started < BUDGET_MS) {
    let q = admin.from('email_threads')
      .select('thread_id, last_message_id, bucket, attempts')
      .eq('account_id', acct.id).in('status', ['pending', 'error']).lt('attempts', MAX_ATTEMPTS);
    if (failed.size) q = q.not('thread_id', 'in', `(${[...failed].map(id => `"${id}"`).join(',')})`); // quoted: Microsoft ids hold = + /
    const { data: batch } = await q.order('first_seen_at', { ascending: false }).limit(CONCURRENCY * 4);
    const todo = (batch ?? []) as Row[];
    if (!todo.length) break;

    await pool(todo, CONCURRENCY, async (row) => {
      if (Date.now() - started > BUDGET_MS) return;
      try {
        const full = await mb.getThread(row.thread_id);
        const f = threadFacts(full, acct.email);
        const base = {
          ...(full.historyId ? { gmail_history_id: full.historyId } : {}), // Microsoft: keep discover's version
          web_link: full.webLink ?? null,
          last_message_id: f.lastMessageId,
          subject: f.subject.slice(0, 300), from_name: f.fromName.slice(0, 200), from_email: f.fromEmail,
          snippet: f.snippet.slice(0, 300), last_message_at: f.date.toISOString(),
          message_count: f.messageCount, unread: f.unread, last_from_me: f.lastFromMe,
          labels: f.labels, has_unsubscribe: f.hasUnsubscribe,
          status: 'classified', attempts: 0, last_error: null, updated_at: new Date().toISOString(),
        };

        // Retiring this address: new mail from anyone goes on (or back on) the checklist
        if (acct.retiring && !f.lastFromMe && row.last_message_id !== f.lastMessageId
            && f.date.getTime() > Date.parse(acct.retire_scanned_at ?? '1970-01-01')) {
          await flagArrival(admin, acct, f).catch(e => console.error('retire flag failed', e instanceof Error ? e.message : e));
        }

        // Only read/label changes since last sort → refresh the details, keep the sort (no AI cost)
        if (row.bucket != null && row.last_message_id === f.lastMessageId) {
          await save(admin, acct.id, row.thread_id, base);
          bump('unchanged');
          return;
        }

        // Your sender preference wins over rules and Claude (but not over the safety net,
        // and not for conversations you're part of)
        // Exact sender first, then the sender's company (domain_prefs never holds gmail.com etc.)
        const domain = f.fromEmail.split('@')[1] ?? '';
        const senderPref = f.lastFromMe ? undefined : learned.get(f.fromEmail);
        const companyPref = f.lastFromMe || senderPref ? undefined : domainPref.get(domain);
        const pref = senderPref ?? companyPref;
        const prefReason = !pref ? ''
          : senderPref ? `You sort this sender as ${['', 'Junk', 'Glance', 'Real'][pref]}`
          : `You sort ${domain} as ${['', 'Junk', 'Glance', 'Real'][pref]}`;

        let sort: Sort | null = pref === 1 || pref === 2
          ? { bucket: pref, priority: false, category: 'learned', group_key: null, by: 'learned',
              summary: f.snippet.slice(0, 140), reason: prefReason }
          : pref ? null : applyRules(f);

        if (sort) {
          bump(sort.by === 'learned' ? 'by_learned' : 'by_rule');
        } else {
          // Learned "Real" still goes to Claude — for the 2–3 line summary
          const ai = await classifyWithClaude(f, acct, examplesFor(f.fromEmail));
          sort = pref === 3 ? { ...ai.sort, bucket: 3, by: 'learned', reason: prefReason } : ai.sort;
          bump(sort.by === 'ai' ? 'by_ai' : sort.by === 'learned' ? 'by_learned' : 'fallback');
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

// ── 4. archive ──────────────────────────────────────────────────────

const MAX_ARCHIVE_PER_RUN = 300;
const BUCKET_NAME = ['', 'Junk', 'Glance', 'Real'];

async function autoArchive(admin: SupabaseClient, acct: Acct, mb: Mailbox, runId: string, stats: Stats) {
  const allowed = acct.policy === 'full' ? [1, 2] : acct.policy === 'junk_only' ? [1] : [];
  if (!allowed.length) return; // read_only: never touch mail

  const rows = await selectAll<{
    thread_id: string; bucket: number | null; user_bucket: number | null; priority: boolean;
    last_from_me: boolean | null; unread: boolean | null; reason: string | null;
    subject: string | null; from_name: string | null; from_email: string | null;
  }>(admin, 'email_threads',
    'thread_id, bucket, user_bucket, priority, last_from_me, unread, reason, subject, from_name, from_email',
    q => q.eq('account_id', acct.id).eq('in_inbox', true).eq('status', 'classified'));

  const targets = rows.filter(t => {
    const b = t.user_bucket ?? t.bucket;
    return b != null && allowed.includes(b)
      && !t.priority             // safety net: priority mail is never auto-archived
      && !t.last_from_me;        // nor a conversation you're in
  }).slice(0, MAX_ARCHIVE_PER_RUN);

  let archived = 0;
  await pool(targets, CONCURRENCY, async (t) => {
    try {
      await mb.archive(t.thread_id);
      const now = new Date().toISOString();
      await save(admin, acct.id, t.thread_id, { in_inbox: false, acted: 'archived', acted_at: now, updated_at: now });
      const b = t.user_bucket ?? t.bucket ?? 0;
      await admin.from('action_log').insert({
        household_id: acct.household_id, account_id: acct.id, thread_id: t.thread_id,
        action: 'archive', source: 'sync', reason: `${BUCKET_NAME[b]}: ${t.reason ?? ''}`.slice(0, 200),
        payload: { was_unread: !!t.unread, subject: t.subject, from_name: t.from_name, from_email: t.from_email, bucket: b, run_id: runId },
      });
      archived++;
    } catch (e) {
      console.error('auto-archive failed', t.thread_id, e instanceof Error ? e.message : e);
      stats.archive_errors = (stats.archive_errors ?? 0) + 1;
    }
  });
  stats.archived = (stats.archived ?? 0) + archived;
}

// ── 4b. "Always ignore" for IMAP accounts ───────────────────────────
// Gmail and Outlook keep a real filter/rule on the server. IMAP can't, so rlyfe does the
// filter's job here: anything from an always-ignored sender leaves the inbox at each sync.
async function applyIgnoreRules(admin: SupabaseClient, acct: Acct, mb: Mailbox, runId: string, stats: Stats) {
  const { data: prefs } = await admin.from('sender_prefs')
    .select('sender_email, gmail_filters').eq('household_id', acct.household_id).eq('always_ignore', true);
  const senders = (prefs ?? [])
    .filter(p => (p.gmail_filters as Record<string, string> | null)?.[acct.id])
    .map(p => p.sender_email);
  if (!senders.length) return;

  const { data: rows } = await admin.from('email_threads')
    .select('thread_id, unread, subject, from_name, from_email, user_bucket')
    .eq('account_id', acct.id).eq('in_inbox', true).in('from_email', senders);
  let n = 0;
  for (const t of (rows ?? []).filter(r => r.user_bucket !== 3)) {
    try {
      await mb.archive(t.thread_id);
      const now = new Date().toISOString();
      await save(admin, acct.id, t.thread_id, { in_inbox: false, acted: 'ignored', acted_at: now, updated_at: now });
      await admin.from('action_log').insert({
        household_id: acct.household_id, account_id: acct.id, thread_id: t.thread_id,
        action: 'archive', source: 'sync', reason: `Always ignore ${t.from_email}`,
        payload: { was_unread: !!t.unread, subject: t.subject, from_name: t.from_name, from_email: t.from_email, run_id: runId },
      });
      n++;
    } catch (e) {
      console.error('ignore-rule archive failed', t.thread_id, e instanceof Error ? e.message : e);
    }
  }
  stats.ignored_by_rule = (stats.ignored_by_rule ?? 0) + n;
}

// ── 5. finalize ─────────────────────────────────────────────────────

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
