// Who is calling? Every browser-facing function starts with requireMember().
//   - token must be a real, current Supabase session (checked with Auth)
//   - session must have passed 2FA (aal2), same rule as the database
//   - caller must belong to a household
// Returns a service-role client for server-side work, or a Response to send back.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { json } from './http.ts';

export const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export const adminClient = (): SupabaseClient =>
  createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

export type Ctx = { admin: SupabaseClient; userId: string; householdId: string };

function jwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(atob(b64));
}

export async function requireMember(req: Request): Promise<Ctx | Response> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'signed-out' }, 401);

  const admin = adminClient();
  const { data: { user }, error } = await admin.auth.getUser(jwt);
  if (error || !user) return json({ error: 'signed-out' }, 401);

  // getUser() just validated this token with Auth, so reading its payload is safe.
  if (jwtPayload(jwt).aal !== 'aal2') return json({ error: 'needs-2fa' }, 403);

  const { data: m } = await admin
    .from('household_members')
    .select('household_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  if (!m) return json({ error: 'no-household' }, 403);

  return { admin, userId: user.id, householdId: m.household_id };
}

// A mail account this person may use: in their household AND (theirs, or marked shared).
// Every function that touches an account goes through this — the service-role client skips
// row-level security, so the check has to happen here too.
export async function accountFor<T extends Record<string, unknown> = Record<string, unknown>>(
  ctx: Ctx, accountId: unknown, cols = 'id, email, provider, owner_id, shared',
): Promise<(T & { id: string; owner_id: string; shared: boolean }) | null> {
  if (typeof accountId !== 'string' || !accountId) return null;
  const { data } = await ctx.admin.from('connected_accounts').select(cols.includes('owner_id') ? cols : `${cols}, owner_id, shared`)
    .eq('id', accountId).eq('household_id', ctx.householdId).maybeSingle();
  const row = data as (T & { id: string; owner_id: string; shared: boolean }) | null;
  if (!row || (row.owner_id !== ctx.userId && !row.shared)) return null;
  return row;
}
