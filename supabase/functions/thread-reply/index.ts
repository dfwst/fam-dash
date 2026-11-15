// POST (signed in, 2FA) — reply to an email from inside rlyfe.
//
//   { action: 'prepare', accountId, threadId }            who a Reply / Reply all would go to
//   { action: 'draft',   accountId, threadId, rough }   Claude drafts (rough empty) or polishes
//                                                        your rough note — never sends
//   { action: 'send',    accountId, threadId, body, replyAll, done }
//        sends from the account that got the email, in the same conversation;
//        done=true also archives it (with an Undo, like the Done button)
//
// Nothing here runs on a schedule: 'send' only happens when you tap Send.
import { requireMember, type Ctx } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { NeedsReconnect, type Provider } from '../_shared/accounts.ts';
import { isValidThreadId, openMailbox, type Mailbox, type MailThread } from '../_shared/mailbox.ts';
import { recipients } from '../_shared/reply.ts';
import { DRAFT_MODEL, draftReply } from '../_shared/draft.ts';

const MAX_BODY = 20_000;
class Refused extends Error {}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;

  const body = await req.json().catch(() => ({}));
  try {
    const acct = await loadAccount(ctx, body.accountId, body.threadId);
    const mb = await openMailbox(ctx.admin, acct);
    const thread = await mb.getThread(body.threadId);

    switch (body.action) {
      case 'prepare': {
        const one = recipients(thread, acct.email, false);
        const all = recipients(thread, acct.email, true);
        return json({ from: acct.email, provider: acct.provider, reply: one, replyAll: all });
      }
      case 'draft':
        return json(await draft(ctx, acct, thread, String(body.rough ?? '')));
      case 'send':
        return json(await send(ctx, acct, mb, thread, String(body.body ?? ''), !!body.replyAll, !!body.done));
      default:
        return json({ error: 'unknown-action' }, 400);
    }
  } catch (e) {
    if (e instanceof NeedsReconnect) return json({ error: 'needs-reconnect' }, 409);
    if (e instanceof Refused) return json({ error: e.message }, 400);
    console.error('thread-reply failed', body.action, e instanceof Error ? e.message : e);
    return json({ error: body.action === 'send' ? 'send-failed' : 'reply-failed' }, 502);
  }
});

type Acct = { id: string; email: string; provider: Provider; ai_context: string | null };

async function loadAccount(ctx: Ctx, accountId: unknown, threadId: unknown): Promise<Acct> {
  const { data } = await ctx.admin.from('connected_accounts')
    .select('id, email, provider, ai_context').eq('id', String(accountId ?? '')).eq('household_id', ctx.householdId).maybeSingle();
  if (!data || !isValidThreadId(data.provider, threadId)) throw new Refused('not-found');
  return data;
}

async function draft(ctx: Ctx, acct: Acct, thread: MailThread, rough: string) {
  const r = await draftReply(thread, acct.email, acct.ai_context, rough);
  await ctx.admin.from('ai_usage').insert({
    household_id: ctx.householdId, account_id: acct.id, thread_id: thread.id, purpose: rough.trim() ? 'polish_reply' : 'draft_reply',
    model: DRAFT_MODEL, input_tokens: r.usage.input, output_tokens: r.usage.output, cost_usd: r.cost,
  });
  if (!r.text) throw new Refused('no-draft');
  return { body: r.text, cost: r.cost };
}

async function send(ctx: Ctx, acct: Acct, mb: Mailbox, thread: MailThread, text: string, replyAll: boolean, done: boolean) {
  if (!text.trim()) throw new Refused('empty');
  if (text.length > MAX_BODY) throw new Refused('too-long');

  const { to, cc } = recipients(thread, acct.email, replyAll);
  if (!to.length) throw new Refused('no-recipient');

  const sent = await mb.sendReply(thread, to, cc, text);
  const first = thread.messages[0];
  const subject = first?.payload.headers?.find(h => h.name === 'Subject')?.value ?? '';

  const now = new Date().toISOString();
  const wasUnread = thread.messages.some(m => (m.labelIds ?? []).includes('UNREAD'));
  await ctx.admin.from('action_log').insert({
    household_id: ctx.householdId, account_id: acct.id, thread_id: thread.id,
    action: 'reply', source: 'user', user_id: ctx.userId, reason: replyAll ? 'Replied all' : 'Replied',
    payload: { message_id: sent.id, subject, to, cc, undo: false },
  });

  // You've answered — it moves to "Waiting on others" until they write back
  const update: Record<string, unknown> = { last_from_me: true, last_message_at: now, unread: false, updated_at: now };
  let logId: number | null = null;
  if (done) {
    await mb.archive(thread.id);
    Object.assign(update, { in_inbox: false, acted: 'done', acted_at: now, snoozed_until: null });
    const { data } = await ctx.admin.from('action_log').insert({
      household_id: ctx.householdId, account_id: acct.id, thread_id: thread.id,
      action: 'archive', source: 'user', user_id: ctx.userId, reason: 'Replied + Done',
      payload: { was_unread: wasUnread, subject },
    }).select('id').single();
    logId = data?.id ?? null;
  } else if (wasUnread) {
    await mb.markRead(thread.id); // you clearly read it
  }
  await ctx.admin.from('email_threads').update(update).eq('account_id', acct.id).eq('thread_id', thread.id);

  return { sent: sent.id, to, cc, logId };
}
