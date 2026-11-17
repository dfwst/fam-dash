// POST (signed in, 2FA) — household rules.
//   { action: 'save',   id?, name, tabId? | newTabName?, phrases[], senders[], description?,
//                       share_matches, always_real, gmail_label? }          → { id, tabId }
//   { action: 'delete', id }      (its emails go back to their usual tab and stop being shared)
//   { action: 'apply',  id, days? } apply to existing mail (last 30 days) → { matched, exact, smart, cost }
// Rules are household settings; a rule that shares matches makes just those emails visible to
// everyone in the household. A rule that doesn't share only ever touches its creator's own mail.
import { requireMember, type Ctx } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { appliesTo, exactMatch, markMatch, type HouseholdRule } from '../_shared/household-rules.ts';
import { matchRuleBulk } from '../_shared/classify.ts';
import { openMailbox, type Mailbox } from '../_shared/mailbox.ts';

class Refused extends Error {}
const list = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean).slice(0, max).map(x => x.slice(0, 120));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === 'save') return json(await save(ctx, body));
    if (body.action === 'delete') {
      await ctx.admin.from('rules').delete().eq('id', String(body.id ?? '')).eq('household_id', ctx.householdId);
      return json({ deleted: true });
    }
    if (body.action === 'apply') return json(await apply(ctx, String(body.id ?? ''), Math.min(90, Number(body.days) || 30)));
    return json({ error: 'unknown-action' }, 400);
  } catch (e) {
    if (e instanceof Refused) return json({ error: e.message }, 400);
    console.error('rules failed', body.action, e instanceof Error ? e.message : e);
    return json({ error: 'rules-failed' }, 502);
  }
});

async function save(ctx: Ctx, b: Record<string, unknown>) {
  const name = String(b.name ?? '').trim().slice(0, 60);
  if (!name) throw new Refused('name-required');
  const phrases = list(b.phrases, 20), senders = list(b.senders, 40).map(s => s.toLowerCase());
  const description = String(b.description ?? '').trim().slice(0, 1000) || null;
  if (!phrases.length && !senders.length && !description) throw new Refused('nothing-to-match');
  const share = b.share_matches !== false;

  // Target tab: a new one (Shared if the rule shares, else yours), or one you can see
  let tabId: string | null = null;
  if (typeof b.newTabName === 'string' && b.newTabName.trim()) {
    const tabName = b.newTabName.trim().slice(0, 30);
    const { data: taken } = await ctx.admin.from('tabs').select('slug').eq('household_id', ctx.householdId);
    const used = new Set((taken ?? []).map(t => t.slug));
    const base = tabName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tab';
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    const { data: tab, error } = await ctx.admin.from('tabs').insert({
      household_id: ctx.householdId, slug, name: tabName, sort_order: 50, owner_id: share ? null : ctx.userId,
    }).select('id').single();
    if (error) throw error;
    tabId = tab.id;
  } else if (typeof b.tabId === 'string') {
    const { data: tab } = await ctx.admin.from('tabs').select('id, owner_id').eq('id', b.tabId).eq('household_id', ctx.householdId).maybeSingle();
    if (!tab || (tab.owner_id && tab.owner_id !== ctx.userId)) throw new Refused('bad-tab');
    tabId = tab.id;
  }

  const row = {
    household_id: ctx.householdId, name, tab_id: tabId, phrases, senders, description,
    share_matches: share, always_real: b.always_real !== false,
    gmail_label: typeof b.gmail_label === 'string' && b.gmail_label.trim() ? b.gmail_label.trim().slice(0, 40) : null,
    updated_at: new Date().toISOString(),
  };
  if (typeof b.id === 'string' && b.id) {
    const { error } = await ctx.admin.from('rules').update(row).eq('id', b.id).eq('household_id', ctx.householdId);
    if (error) throw error;
    return { id: b.id, tabId };
  }
  const { data, error } = await ctx.admin.from('rules').insert({ ...row, created_by: ctx.userId }).select('id').single();
  if (error) throw error;
  return { id: data.id, tabId };
}

// Apply a rule to mail already in rlyfe: exact matches on what's stored, then Claude over the rest
async function apply(ctx: Ctx, id: string, days: number) {
  const { data: rule } = await ctx.admin.from('rules')
    .select('id, name, tab_id, phrases, senders, description, share_matches, always_real, gmail_label, created_by')
    .eq('id', id).eq('household_id', ctx.householdId).maybeSingle<HouseholdRule>();
  if (!rule) throw new Refused('not-found');

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: rows } = await ctx.admin.from('email_threads')
    .select('account_id, thread_id, owner_id, from_email, from_name, subject, summary, snippet, rule_id')
    .eq('household_id', ctx.householdId).eq('status', 'classified').gte('last_message_at', since).limit(3000);
  const candidates = (rows ?? []).filter(t => !t.rule_id && appliesTo(rule, t.owner_id));

  const exactHits = candidates.filter(t => exactMatch([rule], {
    fromEmail: t.from_email ?? '', fromName: t.from_name ?? '', subject: t.subject ?? '', text: `${t.summary ?? ''} ${t.snippet ?? ''}`,
  }));
  let smartHits: typeof candidates = [];
  let cost = 0;
  if (rule.description?.trim()) {
    const rest = candidates.filter(t => !exactHits.includes(t));
    const r = await matchRuleBulk({ id: rule.id, name: rule.name, description: rule.description.trim() },
      rest.map((t, idx) => ({ idx, from: `${t.from_name ?? ''} <${t.from_email ?? ''}>`, subject: t.subject ?? '', summary: t.summary ?? t.snippet ?? '' })));
    smartHits = rest.filter((_, idx) => r.matched.has(idx));
    cost = r.cost;
    if (r.input) {
      await ctx.admin.from('ai_usage').insert({
        household_id: ctx.householdId, purpose: 'rule_apply', model: 'claude-haiku-5-5',
        input_tokens: r.input, output_tokens: r.output, cost_usd: r.cost,
      });
    }
  }

  // Mark them; Gmail labels need each account's mailbox (opened once per account)
  const boxes = new Map<string, Promise<Mailbox | undefined>>();
  const boxFor = (accountId: string) => {
    if (!rule.gmail_label) return Promise.resolve(undefined);
    if (!boxes.has(accountId)) {
      boxes.set(accountId, Promise.resolve(ctx.admin.from('connected_accounts').select('id, email, provider').eq('id', accountId).single())
        .then(({ data }) => (data?.provider === 'google' ? openMailbox(ctx.admin, data) : undefined)).catch(() => undefined));
    }
    return boxes.get(accountId)!;
  };
  for (const t of [...exactHits, ...smartHits]) {
    await markMatch(ctx.admin, t.account_id, t.thread_id, rule, await boxFor(t.account_id));
  }
  return { matched: exactHits.length + smartHits.length, exact: exactHits.length, smart: smartHits.length, checked: candidates.length, cost: Number(cost.toFixed(4)) };
}
