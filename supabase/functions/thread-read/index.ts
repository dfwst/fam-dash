// POST (signed in, 2FA) { accountId, threadId } → the whole conversation, for reading inside rlyfe.
// Read-only: doesn't mark anything read and stores nothing — the body is fetched fresh each time
// and only travels to your browser.
import { requireMember } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { NeedsReconnect } from '../_shared/accounts.ts';
import { isValidThreadId, openMailbox } from '../_shared/mailbox.ts';
import { b64urlText, findPart, header, parseFrom, type Part } from '../_shared/gmail-parse.ts';
import { planUnsubscribe, unsubHeadersOf } from '../_shared/unsubscribe.ts';
import { groupKey } from '../_shared/retire.ts';

const MAX_HTML = 400_000; // characters per message — enough for any normal email

function attachments(p: Part, out: { name: string; size: number }[] = []) {
  if (p.filename) out.push({ name: p.filename, size: p.body?.size ?? 0 });
  for (const c of p.parts ?? []) attachments(c, out);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;

  const { accountId, threadId } = await req.json().catch(() => ({}));
  const { data: acct } = await ctx.admin.from('connected_accounts')
    .select('id, email, provider').eq('id', accountId ?? '').eq('household_id', ctx.householdId).maybeSingle();
  if (!acct || !isValidThreadId(acct.provider, threadId)) return json({ error: 'not-found' }, 404);

  try {
    const mb = await openMailbox(ctx.admin, acct);
    const t = await mb.getThread(threadId, { attachments: true });
    const messages = t.messages.map(m => {
      const html = findPart(m.payload, 'text/html');
      const plain = findPart(m.payload, 'text/plain');
      return {
        id: m.id,
        from: parseFrom(header(m, 'From')),
        to: header(m, 'To'),
        cc: header(m, 'Cc'),
        subject: header(m, 'Subject'),
        date: new Date(Number(m.internalDate)).toISOString(),
        unread: (m.labelIds ?? []).includes('UNREAD'),
        sentByYou: (m.labelIds ?? []).includes('SENT'),
        html: html ? b64urlText(html.body!.data!).slice(0, MAX_HTML) : null,
        text: plain ? b64urlText(plain.body!.data!).slice(0, MAX_HTML) : (html ? null : m.snippet ?? ''),
        attachments: attachments(m.payload),
      };
    });
    // Can this be unsubscribed from, and how? (mailing lists only — never a person)
    const u = unsubHeadersOf(t);
    const plan = planUnsubscribe(u.listUnsub, u.listUnsubPost);
    const lastFrom = messages[messages.length - 1]?.from.email ?? '';
    const unsubscribe = plan.method !== 'none' && !groupKey(lastFrom).personal ? plan.method : null;
    await mb.close?.();

    return json({
      threadId: t.id,
      account: acct.email,
      provider: acct.provider,
      webLink: t.webLink ?? null, // Outlook on the web link (Microsoft only)
      unsubscribe,                // 'one-click' | 'email' | 'link' | null
      subject: messages[0]?.subject || '(no subject)',
      messages,
    });
  } catch (e) {
    if (e instanceof NeedsReconnect) return json({ error: 'needs-reconnect' }, 409);
    console.error('thread-read failed', e instanceof Error ? e.message : e);
    return json({ error: 'gmail-failed' }, 502);
  }
});
