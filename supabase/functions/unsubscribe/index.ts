// POST (signed in, 2FA) — unsubscribe from a sender's mailing list.
//   { accountId, threadId }   from an email you're reading
//   { retireItemId }          from the "Retire this address" checklist
// → { method: 'one-click' | 'email' | 'link' | 'none', ok, url? }
//
// one-click / email happen here; 'link' (only a web page) comes back for the app to open.
// Refuses: priority mail, personal addresses (a person isn't a mailing list), and anything the
// retire scan marked as likely phishing or spam — unsubscribing there only confirms your address.
import { accountFor, requireMember, type Ctx } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { NeedsReconnect } from '../_shared/accounts.ts';
import { isValidThreadId, openMailbox, type Mailbox } from '../_shared/mailbox.ts';
import { groupKey } from '../_shared/retire.ts';
import { findBodyUnsubLink, oneClick, planUnsubscribe, unsubHeadersOf } from '../_shared/unsubscribe.ts';
import { b64urlText, findPart } from '../_shared/gmail-parse.ts';

class Refused extends Error {}
const SCAMMY = /^likely (phishing|spam)/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;

  const body = await req.json().catch(() => ({}));
  let mb: Mailbox | null = null;
  try {
    let accountId: string, sender: string, itemId: string | null = null;
    let headers: { listUnsub?: string; listUnsubPost?: string };
    let bodyOf: () => Promise<string>; // the newest email's body, if we need its unsubscribe link

    if (body.retireItemId) {
      const { data: it } = await ctx.admin.from('retire_items')
        .select('id, account_id, sender, personal, kind, reason, sample_ref')
        .eq('id', String(body.retireItemId)).eq('household_id', ctx.householdId).maybeSingle();
      if (!it) throw new Refused('not-found');
      mb = await mailboxFor(ctx, it.account_id); // someone else's private account → not-found, before anything else
      if (it.personal || it.kind === 'person') throw new Refused('is-a-person');
      if (SCAMMY.test(it.reason ?? '')) throw new Refused('looks-like-spam');
      if (!it.sample_ref) throw new Refused('rescan-needed');
      accountId = it.account_id; sender = it.sender ?? ''; itemId = it.id;
      headers = await mb.messageUnsubHeaders(it.sample_ref);
      const m = mb, ref = it.sample_ref;
      bodyOf = () => m.messageBody(ref);
    } else {
      const { data: t } = await ctx.admin.from('email_threads')
        .select('account_id, thread_id, from_email, priority, last_from_me')
        .eq('account_id', String(body.accountId ?? '')).eq('thread_id', String(body.threadId ?? ''))
        .eq('household_id', ctx.householdId).maybeSingle();
      if (!t) throw new Refused('not-found');
      mb = await mailboxFor(ctx, t.account_id); // someone else's private account → not-found, before anything else
      if (t.priority) throw new Refused('priority-mail');
      if (groupKey(t.from_email ?? '').personal) throw new Refused('is-a-person');
      await refuseIfScammy(ctx, t.from_email ?? '');
      accountId = t.account_id; sender = t.from_email ?? '';
      if (!isValidThreadId(mb.provider, t.thread_id)) throw new Refused('not-found');
      const thread = await mb.getThread(t.thread_id);
      headers = unsubHeadersOf(thread);
      bodyOf = async () => {
        const last = thread.messages[thread.messages.length - 1];
        const part = last && (findPart(last.payload, 'text/html') ?? findPart(last.payload, 'text/plain'));
        return part?.body?.data ? b64urlText(part.body.data) : '';
      };
    }

    let plan = planUnsubscribe(headers.listUnsub, headers.listUnsubPost);
    // No unsubscribe header (typical before 2024) → look for the link in the email itself
    if (plan.method === 'none') {
      const link = findBodyUnsubLink(await bodyOf().catch(() => ''));
      if (link) plan = { method: 'link', url: link };
    }
    // Preview: say how it WOULD unsubscribe, change nothing
    if (body.dryRun) return json({ method: plan.method, ok: false, dryRun: true });
    let ok = false;
    if (plan.method === 'one-click') {
      ok = await oneClick(plan.url);
      // Sender's one-click endpoint failed → try its email unsubscribe, else hand back the link
      if (!ok) plan = planUnsubscribe(headers.listUnsub, '');
    }
    if (plan.method === 'email') {
      await mb.sendNew(plan.to, plan.subject, plan.body);
      ok = true;
    }
    const method = plan.method === 'none' ? 'none' : plan.method;

    if (method !== 'none') {
      await ctx.admin.from('action_log').insert({
        household_id: ctx.householdId, account_id: accountId, thread_id: body.threadId ?? null,
        action: 'unsubscribe', source: 'user', user_id: ctx.userId,
        reason: ok ? `Unsubscribed (${method})` : 'Opened unsubscribe page',
        payload: { sender, method, ok, host: 'url' in plan ? new URL(plan.url).host : 'to' in plan ? plan.to : null },
      });
    }
    if (itemId && method !== 'none') {
      const now = new Date().toISOString();
      await ctx.admin.from('retire_items').update({
        unsubscribe_method: method, ...(ok ? { unsubscribed_at: now, status: 'done', done_at: now } : {}), updated_at: now,
      }).eq('id', itemId);
    }
    return json({ method, ok, ...(plan.method === 'link' ? { url: plan.url } : {}) });
  } catch (e) {
    if (e instanceof Refused) return json({ error: e.message }, 400);
    if (e instanceof NeedsReconnect) return json({ error: 'needs-reconnect' }, 409);
    console.error('unsubscribe failed', e instanceof Error ? e.message : e);
    return json({ error: 'unsubscribe-failed' }, 502);
  } finally {
    await mb?.close?.();
  }
});

// Only accounts this person may use (their own, or shared)
async function mailboxFor(ctx: Ctx, accountId: string): Promise<Mailbox> {
  const acct = await accountFor<{ email: string; provider: 'google' | 'microsoft' | 'imap' }>(ctx, accountId);
  if (!acct) throw new Refused('not-found');
  return openMailbox(ctx.admin, acct);
}

// If any retire scan in this household judged the sender's domain to be phishing / spam, refuse
async function refuseIfScammy(ctx: Ctx, sender: string) {
  const { data } = await ctx.admin.from('retire_items').select('reason')
    .eq('household_id', ctx.householdId).eq('group_key', groupKey(sender).key);
  if ((data ?? []).some(r => SCAMMY.test(r.reason ?? ''))) throw new Refused('looks-like-spam');
}
