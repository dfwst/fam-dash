// POST (signed in, 2FA) { loginHint? } → { url }
// Same one-time `state` as Google, then the browser goes to Microsoft's sign-in.
import { requireMember } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { msAuthUrl } from '../_shared/microsoft.ts';

const RETURN_ALLOWED = ['https://rlyfe.app', 'https://rlyfe.netlify.app', 'http://localhost:5173'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;
  if (!Deno.env.get('MICROSOFT_CLIENT_ID') || !Deno.env.get('MICROSOFT_CLIENT_SECRET')) return json({ error: 'ms-not-configured' }, 503);

  const { loginHint } = await req.json().catch(() => ({}));
  const origin = req.headers.get('Origin') ?? '';
  const returnTo = RETURN_ALLOWED.includes(origin) ? origin : RETURN_ALLOWED[0];

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const state = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

  await ctx.admin.from('oauth_states').delete().lt('expires_at', new Date().toISOString());
  const { error } = await ctx.admin.from('oauth_states').insert({
    state, user_id: ctx.userId, household_id: ctx.householdId, return_to: returnTo,
  });
  if (error) return json({ error: 'state-failed' }, 500);

  return json({ url: msAuthUrl(state, typeof loginHint === 'string' ? loginHint : undefined) });
});
