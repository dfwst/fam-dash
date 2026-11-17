// POST (signed in, 2FA, household member) — invite someone into your household.
//   { action: 'create', name, profile? }  → { link }   one-time link, good for 7 days
//   { action: 'cancel', id }
// The link's token is shown once; only its SHA-256 is stored, so a database leak can't be used to join.
import { requireMember } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';

const RETURN_ALLOWED = ['https://rlyfe.app', 'https://rlyfe.netlify.app', 'http://localhost:5173'];

export async function sha256(s: string) {
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

  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
  const { error } = await ctx.admin.from('household_invites').insert({
    household_id: ctx.householdId, token_hash: await sha256(token), name, profile, created_by: ctx.userId,
  });
  if (error) return json({ error: 'invite-failed' }, 500);

  const origin = req.headers.get('Origin') ?? '';
  const base = RETURN_ALLOWED.includes(origin) ? origin : RETURN_ALLOWED[0];
  return json({ link: `${base}/join/${token}` });
});
