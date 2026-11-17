// POST { token, email, password } — create a login FROM AN INVITE (no sign-in needed).
// Public sign-ups are off for this project, so this is the only way in: a valid, unused,
// unexpired invite can create exactly ONE login. The person then signs in, sets up 2-step
// sign-in, and invite-accept joins them to the household (only this same login can).
// Deployed with verify_jwt = false — the invite token is what authorizes it.
import { adminClient } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const { token, email, password } = await req.json().catch(() => ({}));
  if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return json({ error: 'bad-invite' }, 400);
  const addr = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return json({ error: 'bad-email' }, 400);
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) return json({ error: 'weak-password' }, 400);

  const admin = adminClient();
  const hash = await sha256(token);
  const { data: inv } = await admin.from('household_invites').select('id, signup_user_id')
    .eq('token_hash', hash).is('accepted_at', null).gt('expires_at', new Date().toISOString()).maybeSingle();
  if (!inv) return json({ error: 'invite-expired' }, 400);
  if (inv.signup_user_id) return json({ error: 'already-signed-up' }, 409); // one login per invite — sign in instead

  // The invite link is proof enough of the address's owner for this household, so it's confirmed now
  const { data, error } = await admin.auth.admin.createUser({ email: addr, password, email_confirm: true });
  if (error || !data.user) {
    const msg = /already|registered|exists/i.test(error?.message ?? '') ? 'email-in-use' : 'signup-failed';
    console.error('invite-signup failed', error?.message);
    return json({ error: msg }, 400);
  }

  // Claim the invite for this login (if two tabs race, only one wins; the loser's login is removed)
  const { data: claimed } = await admin.from('household_invites').update({ signup_user_id: data.user.id })
    .eq('id', inv.id).is('signup_user_id', null).select('id').maybeSingle();
  if (!claimed) {
    await admin.auth.admin.deleteUser(data.user.id);
    return json({ error: 'already-signed-up' }, 409);
  }
  return json({ created: true });
});
