// POST (signed in, 2FA) { accountId, threadId } → the whole conversation, for reading inside rlyfe.
// Read-only: doesn't mark anything read and stores nothing — the body is fetched fresh each time
// and only travels to your browser.
import { requireMember } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { gmail } from '../_shared/google.ts';
import { accessTokenFor, NeedsReconnect } from '../_shared/accounts.ts';
import { b64urlText, findPart, header, parseFrom, type GmailThread, type Part } from '../_shared/gmail-parse.ts';

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
    .select('id, email').eq('id', accountId ?? '').eq('household_id', ctx.householdId).maybeSingle();
  if (!acct || typeof threadId !== 'string' || !/^[0-9a-f]+$/i.test(threadId)) return json({ error: 'not-found' }, 404);

  try {
    const token = await accessTokenFor(ctx.admin, acct.id);
    const t = await gmail<GmailThread>(`threads/${threadId}`, token, { format: 'full' });
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
    return json({
      threadId: t.id,
      account: acct.email,
      subject: messages[0]?.subject || '(no subject)',
      messages,
    });
  } catch (e) {
    if (e instanceof NeedsReconnect) return json({ error: 'needs-reconnect' }, 409);
    console.error('thread-read failed', e instanceof Error ? e.message : e);
    return json({ error: 'gmail-failed' }, 502);
  }
});
