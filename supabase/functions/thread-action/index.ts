// POST (signed in, 2FA) — your quick actions on one thread. Each one is logged with what's
// needed to undo it. Cleanup policy (read_only, …) only limits the AUTOMATIC morning
// archive; these are your own explicit taps, so they work on every account.
//
//   { action: 'done',   accountId, threadId }   archive + mark read          → { logId }
//   { action: 'ignore', accountId, threadId }   same, and count it against the sender
//                                                → { logId, offerAlwaysIgnore, sender }
//   { action: 'snooze', accountId, threadId, until }  hide from rlyfe until then (Gmail untouched)
//   { action: 'unsnooze', accountId, threadId }
//   { action: 'always_ignore', sender }         mailbox rule "skip inbox + mark read" (Gmail filter /
//                                                Outlook inbox rule) in each
//                                                account that gets this sender's mail, and
//                                                archive what's already there
//   { action: 'undo', logId }                    reverse any of the above
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { requireMember, type Ctx } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { NeedsReconnect } from '../_shared/accounts.ts';
import { openMailbox, type Mailbox } from '../_shared/mailbox.ts';

const OFFER_AFTER = 2; // offer "Always ignore?" from the 2nd ignore of the same sender

class Refused extends Error {}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;

  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'done':
      case 'ignore':        return json(await archive(ctx, body.accountId, body.threadId, body.action));
      case 'snooze':        return json(await snooze(ctx, body.accountId, body.threadId, body.until));
      case 'unsnooze':      return json(await snooze(ctx, body.accountId, body.threadId, null));
      case 'always_ignore': return json(await alwaysIgnore(ctx, String(body.sender ?? '').toLowerCase()));
      case 'undo':          return json(await undo(ctx, Number(body.logId)));
      default:              return json({ error: 'unknown-action' }, 400);
    }
  } catch (e) {
    if (e instanceof NeedsReconnect) return json({ error: 'needs-reconnect' }, 409);
    if (e instanceof Refused) return json({ error: e.message }, 400);
    console.error('thread-action failed', body.action, e instanceof Error ? e.message : e);
    return json({ error: 'action-failed' }, 502);
  }
});

async function loadThread(ctx: Ctx, accountId: string, threadId: string) {
  const { data: t } = await ctx.admin.from('email_threads')
    .select('account_id, thread_id, household_id, subject, from_name, from_email, unread, priority, bucket, user_bucket')
    .eq('account_id', accountId ?? '').eq('thread_id', threadId ?? '')
    .eq('household_id', ctx.householdId)          // never another household's mail
    .maybeSingle();
  if (!t) throw new Refused('not-found');
  return t;
}

// The account's mailbox (Gmail or Microsoft) — only ever this household's accounts
async function mailboxFor(ctx: Ctx, accountId: string): Promise<Mailbox> {
  const { data } = await ctx.admin.from('connected_accounts').select('id, email, provider')
    .eq('id', accountId).eq('household_id', ctx.householdId).maybeSingle();
  if (!data) throw new Refused('not-found');
  return openMailbox(ctx.admin, data);
}

async function log(admin: SupabaseClient, row: Record<string, unknown>): Promise<number> {
  const { data, error } = await admin.from('action_log').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}

// ── Done / Ignore ───────────────────────────────────────────────────

async function archive(ctx: Ctx, accountId: string, threadId: string, kind: 'done' | 'ignore') {
  const t = await loadThread(ctx, accountId, threadId);
  await (await mailboxFor(ctx, t.account_id)).archive(t.thread_id);

  const now = new Date().toISOString();
  await ctx.admin.from('email_threads').update({
    in_inbox: false, acted: kind === 'done' ? 'done' : 'ignored', acted_at: now, snoozed_until: null, updated_at: now,
  }).eq('account_id', t.account_id).eq('thread_id', t.thread_id);

  const logId = await log(ctx.admin, {
    household_id: ctx.householdId, account_id: t.account_id, thread_id: t.thread_id,
    action: 'archive', source: 'user', user_id: ctx.userId, reason: kind === 'done' ? 'Done' : 'Ignored',
    payload: { was_unread: !!t.unread, subject: t.subject, from_name: t.from_name, from_email: t.from_email },
  });

  if (kind === 'done' || !t.from_email) return { logId };

  // Count the ignore against the sender
  const { data: pref } = await ctx.admin.from('sender_prefs')
    .select('ignore_count, always_ignore').eq('household_id', ctx.householdId).eq('sender_email', t.from_email).maybeSingle();
  const count = (pref?.ignore_count ?? 0) + 1;
  await ctx.admin.from('sender_prefs').upsert({
    household_id: ctx.householdId, sender_email: t.from_email, ignore_count: count, updated_at: now,
  });
  const offerAlwaysIgnore = count >= OFFER_AFTER && !pref?.always_ignore && !(await senderHasPriority(ctx, t.from_email));
  return { logId, offerAlwaysIgnore, sender: t.from_email, senderName: t.from_name, ignoreCount: count };
}

// Never offer (or allow) a filter for a sender that has ever sent priority mail —
// a filter would silently bury the next security alert or declined payment.
async function senderHasPriority(ctx: Ctx, sender: string) {
  const { count } = await ctx.admin.from('email_threads').select('thread_id', { count: 'exact', head: true })
    .eq('household_id', ctx.householdId).eq('from_email', sender).eq('priority', true);
  return (count ?? 0) > 0;
}

// ── Remind me ───────────────────────────────────────────────────────

async function snooze(ctx: Ctx, accountId: string, threadId: string, until: string | null) {
  const t = await loadThread(ctx, accountId, threadId);
  if (until && !(Date.parse(until) > Date.now())) throw new Refused('bad-time');
  await ctx.admin.from('email_threads').update({ snoozed_until: until, updated_at: new Date().toISOString() })
    .eq('account_id', t.account_id).eq('thread_id', t.thread_id);
  const logId = await log(ctx.admin, {
    household_id: ctx.householdId, account_id: t.account_id, thread_id: t.thread_id,
    action: until ? 'snooze' : 'unsnooze', source: 'user', user_id: ctx.userId,
    reason: until ? `Remind me ${until}` : 'Back to the list', payload: { subject: t.subject },
  });
  return { logId };
}

// ── Always ignore ───────────────────────────────────────────────────

async function alwaysIgnore(ctx: Ctx, sender: string) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) throw new Refused('bad-sender');
  if (await senderHasPriority(ctx, sender)) throw new Refused('priority-sender');

  // Every account (in this household) that has received mail from this sender
  const { data: rows } = await ctx.admin.from('email_threads')
    .select('account_id, thread_id, in_inbox, unread, subject, from_name, user_bucket')
    .eq('household_id', ctx.householdId).eq('from_email', sender);
  const accountIds = [...new Set((rows ?? []).map(r => r.account_id))];

  const { data: pref } = await ctx.admin.from('sender_prefs')
    .select('gmail_filters').eq('household_id', ctx.householdId).eq('sender_email', sender).maybeSingle();
  const filters: Record<string, string> = { ...(pref?.gmail_filters ?? {}) };
  const now = new Date().toISOString();
  let archived = 0;

  for (const accountId of accountIds) {
    const mb = await mailboxFor(ctx, accountId);
    if (!filters[accountId]) {
      const ruleId = await mb.addIgnoreRule(sender);
      filters[accountId] = ruleId;
      await log(ctx.admin, {
        household_id: ctx.householdId, account_id: accountId, action: 'create_filter', source: 'user',
        user_id: ctx.userId, reason: `Always ignore ${sender}`, payload: { filter_id: ruleId, sender },
      });
    }
    // Clear what's already in the inbox (except anything you marked Real)
    for (const r of (rows ?? []).filter(r => r.account_id === accountId && r.in_inbox && r.user_bucket !== 3)) {
      await mb.archive(r.thread_id);
      await ctx.admin.from('email_threads').update({ in_inbox: false, acted: 'ignored', acted_at: now, updated_at: now })
        .eq('account_id', accountId).eq('thread_id', r.thread_id);
      await log(ctx.admin, {
        household_id: ctx.householdId, account_id: accountId, thread_id: r.thread_id,
        action: 'archive', source: 'user', user_id: ctx.userId, reason: `Always ignore ${sender}`,
        payload: { was_unread: !!r.unread, subject: r.subject, from_name: r.from_name, from_email: sender },
      });
      archived++;
    }
  }

  await ctx.admin.from('sender_prefs').upsert({
    household_id: ctx.householdId, sender_email: sender, always_ignore: true, gmail_filters: filters, updated_at: now,
  });
  return { filters: Object.keys(filters).length, archived };
}

// ── Undo ────────────────────────────────────────────────────────────

async function undo(ctx: Ctx, logId: number) {
  const { data: entry } = await ctx.admin.from('action_log').select('*')
    .eq('id', logId).eq('household_id', ctx.householdId).is('undone_at', null).maybeSingle();
  if (!entry) throw new Refused('nothing-to-undo');
  const now = new Date().toISOString();

  if (entry.action === 'archive') {
    await (await mailboxFor(ctx, entry.account_id)).unarchive(entry.thread_id, !!entry.payload?.was_unread);
    const back: Record<string, unknown> = { in_inbox: true, acted: null, acted_at: null, updated_at: now };
    // Rescuing something the morning sync archived means "this was Real" — that also teaches the sender
    if (entry.source === 'sync') back.user_bucket = 3;
    await ctx.admin.from('email_threads').update(back).eq('account_id', entry.account_id).eq('thread_id', entry.thread_id);
  } else if (entry.action === 'snooze') {
    await ctx.admin.from('email_threads').update({ snoozed_until: null, updated_at: now })
      .eq('account_id', entry.account_id).eq('thread_id', entry.thread_id);
  } else if (entry.action === 'create_filter') {
    const mb = await mailboxFor(ctx, entry.account_id);
    await mb.removeIgnoreRule(entry.payload.filter_id).catch(() => {}); // already gone is fine
    const { data: pref } = await ctx.admin.from('sender_prefs').select('gmail_filters')
      .eq('household_id', ctx.householdId).eq('sender_email', entry.payload.sender).maybeSingle();
    const filters = { ...(pref?.gmail_filters ?? {}) };
    delete filters[entry.account_id];
    await ctx.admin.from('sender_prefs').update({
      gmail_filters: filters, always_ignore: Object.keys(filters).length > 0, updated_at: now,
    }).eq('household_id', ctx.householdId).eq('sender_email', entry.payload.sender);
  } else {
    throw new Refused('cannot-undo');
  }

  await ctx.admin.from('action_log').update({ undone_at: now }).eq('id', logId);
  return { undone: logId };
}
