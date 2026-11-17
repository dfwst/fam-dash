// POST (signed in, 2FA, household member) — invite someone into your household.
//   { action: 'create', name, profile?, email?, fromAccountId? }  → { link, emailed? }
//       one-time link, good for 7 days. With email + fromAccountId, the link is also emailed to
//       them FROM one of your own connected accounts (so it comes from you, not a stranger).
//   { action: 'cancel', id }
// The link's token is shown once; only its SHA-256 is stored, so a database leak can't be used to join.
import { accountFor, requireMember } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { NeedsReconnect } from '../_shared/accounts.ts';
import { openMailbox } from '../_shared/mailbox.ts';
import { loadPerson } from '../_shared/people.ts';

const RETURN_ALLOWED = ['https://rlyfe.app', 'https://rlyfe.netlify.app', 'http://localhost:5173'];
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;

  const body = await req.json().catch(() => ({}));
  if (body.action === 'cancel') {
    await ctx.admin.from('household_invites').delete()
      .eq('id', String(body.id ?? '')).eq('household_id', ctx.householdId).is('accepted_at', null);
    return json({ cancelled: true });
  }
  if (body.action !== 'create') return json({ error: 'unknown-action' }, 400);

  const name = String(body.name ?? '').trim().slice(0, 40);
  if (!name) return json({ error: 'name-required' }, 400);
  const profile = typeof body.profile === 'object' && body.profile ? body.profile : {};
  const email = String(body.email ?? '').trim().toLowerCase();
  if (email && !EMAIL_RX.test(email)) return json({ error: 'bad-email' }, 400);
  // Sending from: one of YOUR accounts (checked before anything is created)
  const from = email ? await accountFor<{ email: string; provider: 'google' | 'microsoft' | 'imap' }>(ctx, body.fromAccountId) : null;
  if (email && (!from || from.owner_id !== ctx.userId)) return json({ error: 'pick-from-account' }, 400);

  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
  const { error } = await ctx.admin.from('household_invites').insert({
    household_id: ctx.householdId, token_hash: await sha256(token), name, profile, created_by: ctx.userId,
  });
  if (error) return json({ error: 'invite-failed' }, 500);

  const origin = req.headers.get('Origin') ?? '';
  const base = RETURN_ALLOWED.includes(origin) ? origin : RETURN_ALLOWED[0];
  const link = `${base}/join/${token}`;

  if (!email || !from) return json({ link });

  // Email it from your own account — a short, plain note in your name
  try {
    const me = await loadPerson(ctx.admin, ctx.userId);
    const mb = await openMailbox(ctx.admin, from);
    await mb.sendNew(email, `${me.name} invited you to rlyfe`, [
      `Hi ${name},`,
      '',
      `I set up rlyfe — it sorts email into a calm to-do list (and helps clean up old inboxes). Your email stays private to you.`,
      '',
      'Open this link on your phone or computer to create your login (it works once, for 7 days):',
      link,
      '',
      'You’ll set a password and a 2-step sign-in code app, then answer a few quick questions so it sorts your mail well.',
      '',
      me.name,
    ].join('\n'));
    await mb.close?.();
    return json({ link, emailed: email });
  } catch (e) {
    // The invite exists either way — the app shows the link to send another way
    const msg = e instanceof NeedsReconnect ? 'needs-reconnect' : 'send-failed';
    console.error('invite email failed', e instanceof Error ? e.message : e);
    return json({ link, emailError: msg });
  }
});
