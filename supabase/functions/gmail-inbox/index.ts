// POST (signed in, 2FA) { accountId } → { email, threads: [...] }
// Milestone 1: a live, read-only look at the newest inbox threads. Nothing is stored or changed.
import { requireMember } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { gmail } from '../_shared/google.ts';
import { accessTokenFor, NeedsReconnect } from '../_shared/accounts.ts';

type Header = { name: string; value: string };
type Msg = { labelIds?: string[]; internalDate: string; payload: { headers: Header[] } };

const header = (m: Msg, name: string) =>
  m.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;

  const { accountId } = await req.json().catch(() => ({}));
  const { data: acct } = await ctx.admin
    .from('connected_accounts')
    .select('id, email, status')
    .eq('id', accountId ?? '')
    .eq('household_id', ctx.householdId)   // never another household's account
    .maybeSingle();
  if (!acct) return json({ error: 'not-found' }, 404);

  try {
    const token = await accessTokenFor(ctx.admin, acct.id);
    const list = await gmail<{ threads?: { id: string; snippet: string }[] }>(
      'threads', token, { labelIds: 'INBOX', maxResults: '25' });

    const threads = await Promise.all((list.threads ?? []).map(async (t) => {
      const full = await gmail<{ messages: Msg[] }>(`threads/${t.id}`, token, {
        format: 'metadata', metadataHeaders: ['From', 'Subject'],
      });
      const first = full.messages[0];
      const last = full.messages[full.messages.length - 1];
      return {
        id: t.id,
        from: header(last, 'From'),
        subject: header(first, 'Subject') || '(no subject)',
        snippet: t.snippet,
        date: new Date(Number(last.internalDate)).toISOString(),
        messages: full.messages.length,
        unread: full.messages.some(m => m.labelIds?.includes('UNREAD')),
      };
    }));

    return json({ email: acct.email, threads });
  } catch (e) {
    if (e instanceof NeedsReconnect) return json({ error: 'needs-reconnect' }, 409);
    console.error('gmail-inbox failed', e instanceof Error ? e.message : e);
    return json({ error: 'gmail-failed' }, 502);
  }
});
