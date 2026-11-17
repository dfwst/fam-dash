// POST { token } — join the household an invite link points to.
// Caller must be signed in WITH 2FA (aal2) but is not yet a member (so not requireMember).
// Creates their membership + their own "Life" tab; their profile starts with what the inviter
// already knew (they can edit it in Settings → About you).
import { adminClient } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

function jwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(atob(b64));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'signed-out' }, 401);
  const admin = adminClient();
  const { data: { user }, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !user) return json({ error: 'signed-out' }, 401);
  if (jwtPayload(jwt).aal !== 'aal2') return json({ error: 'needs-2fa' }, 403);

  const { data: already } = await admin.from('household_members').select('household_id').eq('user_id', user.id).limit(1).maybeSingle();
  if (already) return json({ joined: true, already: true });

  const { token } = await req.json().catch(() => ({}));
  if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return json({ error: 'bad-invite' }, 400);

  // Claim the invite atomically: only an unexpired, unused one, and only once
  const { data: inv } = await admin.from('household_invites')
    .update({ accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq('token_hash', await sha256(token)).is('accepted_at', null).gt('expires_at', new Date().toISOString())
    .select('household_id, name, profile').maybeSingle();
  if (!inv) return json({ error: 'invite-expired' }, 400);

  const { error: mErr } = await admin.from('household_members').insert({
    household_id: inv.household_id, user_id: user.id, role: 'member', display_name: inv.name, profile: inv.profile,
  });
  if (mErr) return json({ error: 'join-failed' }, 500);

  // Their own Life tab (tab addresses are unique per household, so pick a free one)
  const { data: taken } = await admin.from('tabs').select('slug').eq('household_id', inv.household_id);
  const used = new Set((taken ?? []).map(t => t.slug));
  const base = inv.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home';
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  await admin.from('tabs').insert({ household_id: inv.household_id, slug, name: 'Life', sort_order: 1, owner_id: user.id });

  return json({ joined: true });
});
