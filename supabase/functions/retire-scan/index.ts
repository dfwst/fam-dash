// POST (signed in, 2FA) — build the "Retire this address" checklist in resumable steps.
//   { accountId, action: 'start' }   reset counts, plan the scan        → { read, total }
//   { accountId, action: 'step' }    read the next batch of headers      → { read, total, done }
//   { accountId, action: 'finish' }  Claude sorts every sender group     → summary
// Headers only (sender, subject, date) — no message bodies, nothing in the mailbox changes.
// Items you've already ticked off, skipped or moved keep your decision on a rescan.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { requireMember, type Ctx } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { NeedsReconnect } from '../_shared/accounts.ts';
import {
  classifyGroups, groupRows, imapStart, imapStep, ruleKind, scanMailbox,
  type Group, type ImapScanState, type Kind, type Row,
} from '../_shared/retire.ts';

const BUDGET_MS = 100_000;
const AI_GROUPS = 480;
type State = ImapScanState & { done: boolean; provider: string };
type Acct = { id: string; email: string; provider: 'google' | 'microsoft' | 'imap'; retire_scan_state: State | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;
  const started = Date.now();

  const { accountId, action } = await req.json().catch(() => ({}));
  const { data: acct } = await ctx.admin.from('connected_accounts').select('id, email, provider, retire_scan_state')
    .eq('id', String(accountId ?? '')).eq('household_id', ctx.householdId).maybeSingle<Acct>();
  if (!acct) return json({ error: 'not-found' }, 404);

  try {
    if (action === 'start') return json(await start(ctx, acct));
    if (action === 'step') return json(await step(ctx, acct, started + BUDGET_MS));
    if (action === 'finish') return json(await finish(ctx, acct));
    return json({ error: 'unknown-action' }, 400);
  } catch (e) {
    if (e instanceof NeedsReconnect) return json({ error: 'needs-reconnect' }, 409);
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    console.error('retire-scan failed', action, msg);
    return json({ error: /auth|credential/i.test(msg) ? 'needs-reconnect' : 'scan-failed' }, 502);
  }
});

const saveState = (admin: SupabaseClient, id: string, state: State | null) =>
  admin.from('connected_accounts').update({ retire_scan_state: state }).eq('id', id);

async function start(ctx: Ctx, acct: Acct) {
  // Counts are rebuilt from scratch; your decisions (status, moved kinds) stay
  await ctx.admin.from('retire_items').update({
    message_count: 0, unsub_count: 0, account_signals: 0, wrote_to: false, samples: [],
  }).eq('account_id', acct.id);
  const state: State = acct.provider === 'imap'
    ? { ...(await imapStart(ctx.admin, acct.id)), done: false, provider: 'imap' }
    : { folders: [], wroteTo: [], read: 0, total: 0, done: false, provider: acct.provider };
  await saveState(ctx.admin, acct.id, state);
  return { read: 0, total: state.total };
}

async function step(ctx: Ctx, acct: Acct, budgetEnd: number) {
  const state = acct.retire_scan_state;
  if (!state || state.done) return { read: state?.read ?? 0, total: state?.total ?? 0, done: true };

  let rows: Row[];
  let wroteTo = new Set(state.wroteTo);
  if (acct.provider === 'imap') {
    rows = await imapStep(ctx.admin, acct.id, state, budgetEnd);
    state.done = state.folders.every(f => f.done);
  } else {
    // Gmail / Microsoft: one budgeted pass (newest mail first)
    const scan = await scanMailbox(ctx.admin, acct, budgetEnd);
    rows = scan.rows;
    wroteTo = scan.wroteTo;
    state.read = state.total = scan.rows.length;
    state.done = true;
  }
  await merge(ctx, acct, groupRows(rows, wroteTo, acct.email));
  await saveState(ctx.admin, acct.id, state);
  return { read: state.read, total: state.total, done: state.done };
}

// Add this batch's counts into the checklist
async function merge(ctx: Ctx, acct: Acct, groups: Group[]) {
  const now = new Date().toISOString();
  for (let i = 0; i < groups.length; i += 200) {
    const chunk = groups.slice(i, i + 200);
    const { data: existing } = await ctx.admin.from('retire_items')
      .select('group_key, kind, reason, message_count, first_seen, last_seen, samples, unsub_count, account_signals, wrote_to, unsubscribe, name, sender')
      .eq('account_id', acct.id).in('group_key', chunk.map(g => g.key));
    const known = new Map((existing ?? []).map(e => [e.group_key, e]));
    const rows = chunk.map(g => {
      const e = known.get(g.key);
      const first = g.first ? new Date(g.first).toISOString() : null;
      const last = g.last ? new Date(g.last).toISOString() : null;
      const base = {
        household_id: ctx.householdId, account_id: acct.id, group_key: g.key, personal: g.personal, updated_at: now,
      };
      if (!e) {
        return {
          ...base, name: (g.name || g.key).slice(0, 120), kind: ruleKind(g), reason: null,
          message_count: g.count, first_seen: first, last_seen: last, samples: g.subjects.slice(0, 3).map(s => s.slice(0, 140)),
          sender: g.sender, unsubscribe: g.unsub ?? null, unsub_count: g.unsubCount, account_signals: g.accountSignals,
          wrote_to: g.wroteTo,
        };
      }
      const newer = last && (!e.last_seen || last > e.last_seen);
      // Every row in one upsert must carry the same columns — keep the existing kind/reason
      return {
        ...base,
        kind: e.kind, reason: e.reason,
        name: newer ? (g.name || e.name).slice(0, 120) : e.name,
        sender: newer ? g.sender : e.sender,
        message_count: e.message_count + g.count,
        first_seen: [e.first_seen, first].filter(Boolean).sort()[0] ?? null,
        last_seen: [e.last_seen, last].filter(Boolean).sort().pop() ?? null,
        samples: (e.samples.length ? e.samples : g.subjects.slice(0, 3).map(s => s.slice(0, 140))),
        unsubscribe: e.unsubscribe ?? g.unsub ?? null,
        unsub_count: e.unsub_count + g.unsubCount,
        account_signals: e.account_signals + g.accountSignals,
        wrote_to: e.wrote_to || g.wroteTo,
      };
    });
    const { error } = await ctx.admin.from('retire_items').upsert(rows, { onConflict: 'account_id,group_key' });
    if (error) throw error;
  }
}

async function finish(ctx: Ctx, acct: Acct) {
  const { data: items } = await ctx.admin.from('retire_items').select('*').eq('account_id', acct.id).gt('message_count', 0);
  const all = (items ?? []).sort((a, b) => b.message_count - a.message_count);
  const asGroup = (it: Record<string, any>): Group => ({ // deno-lint-ignore no-explicit-any
    key: it.group_key, personal: it.personal, name: it.name, sender: it.sender ?? '', count: it.message_count,
    first: Date.parse(it.first_seen ?? '') || 0, last: Date.parse(it.last_seen ?? '') || 0, subjects: it.samples ?? [],
    unsub: it.unsubscribe ?? undefined, unsubCount: it.unsub_count, accountSignals: it.account_signals, wroteTo: it.wrote_to,
  });

  // Claude sorts the senders you haven't decided on yourself (biggest first); the tail uses rules
  const open = all.filter(it => it.status === 'todo' && !it.kind_by_you);
  const ai = await classifyGroups(open.slice(0, AI_GROUPS).map(asGroup), acct.email).catch(e => {
    console.error('retire classify failed', e instanceof Error ? e.message : e);
    return { map: new Map<string, { name: string; kind: string; reason: string }>(), cost: 0, input: 0, output: 0 };
  });
  if (ai.input) {
    await ctx.admin.from('ai_usage').insert({
      household_id: ctx.householdId, account_id: acct.id, purpose: 'retire_scan', model: 'claude-haiku-5-5',
      input_tokens: ai.input, output_tokens: ai.output, cost_usd: ai.cost,
    });
  }
  const now = new Date().toISOString();
  const updates = open.map(it => {
    const c = ai.map.get(it.group_key);
    const g = asGroup(it);
    return {
      ...it,
      kind: (c?.kind as Kind | undefined) ?? ruleKind(g),
      name: (c?.name || it.name).slice(0, 120),
      reason: (c?.reason ?? (g.accountSignals ? 'account emails' : g.unsubCount ? 'mailing list' : '')).slice(0, 200),
      updated_at: now,
    };
  });
  for (let i = 0; i < updates.length; i += 500) {
    const { error } = await ctx.admin.from('retire_items').upsert(updates.slice(i, i + 500), { onConflict: 'account_id,group_key' });
    if (error) throw error;
  }
  await ctx.admin.from('connected_accounts').update({ retire_scanned_at: now, retire_scan_state: null }).eq('id', acct.id);

  const final = all.map(it => updates.find(u => u.id === it.id) ?? it);
  const by = (k: string) => final.filter(r => r.kind === k).length;
  const state = acct.retire_scan_state;
  return {
    messages: final.reduce((n, r) => n + r.message_count, 0), groups: final.length, read: state?.read ?? 0,
    update: by('update'), unsubscribe: by('unsubscribe'), person: by('person'), ignore: by('ignore'),
    cost: Number(ai.cost.toFixed(4)), partial: false,
  };
}
