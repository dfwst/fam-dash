// GET from Google: ?code=…&state=…  (no Supabase login on this request —
// the one-time `state` is what proves who started it. Deployed with verify_jwt = false.)
//
// 1. Look up and delete the state (single use, 10-minute expiry)
// 2. Swap the code for tokens
// 3. Ask Gmail which address this is
// 4. Save the account (new accounts start read_only) + encrypted refresh token
// 5. Send the browser back to rlyfe → Settings
import { adminClient } from '../_shared/auth.ts';
import { encrypt } from '../_shared/crypto.ts';
import { exchangeCode, gmail, SCOPES } from '../_shared/google.ts';
import { defaultTabFor } from '../_shared/people.ts';

const TAB_BY_DOMAIN: Record<string, string> = { 'dfwsmarttech.com': 'dfw' }; // everything else → life

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const admin = adminClient();

  const stateParam = url.searchParams.get('state') ?? '';
  const { data: st } = await admin
    .from('oauth_states')
    .delete()
    .eq('state', stateParam)
    .gt('expires_at', new Date().toISOString())
    .select('user_id, household_id, return_to')
    .maybeSingle();

  const back = (base: string, q: Record<string, string>) =>
    Response.redirect(`${base}/settings?${new URLSearchParams(q)}`, 302);

  if (!st) return back('https://rlyfe.app', { error: 'expired' });
  if (url.searchParams.get('error')) return back(st.return_to, { error: url.searchParams.get('error')! });

  try {
    const tok = await exchangeCode(url.searchParams.get('code') ?? '');
    if (!tok.refresh_token) return back(st.return_to, { error: 'no-refresh-token' });

    const granted = tok.scope.split(' ');
    if (!SCOPES.every(s => granted.includes(s))) return back(st.return_to, { error: 'missing-scopes' });

    const profile = await gmail<{ emailAddress: string; historyId: string }>('profile', tok.access_token);
    const email = profile.emailAddress.toLowerCase();

    const { data: existing } = await admin
      .from('connected_accounts')
      .select('id, owner_id')
      .eq('household_id', st.household_id).eq('provider', 'google').eq('email', email)
      .maybeSingle();
    // Someone else in the household already connected this address — it stays theirs
    if (existing && existing.owner_id !== st.user_id) return back(st.return_to, { error: 'connected-by-someone-else' });

    let accountId = existing?.id as string | undefined;
    if (accountId) {
      // Reconnect: keep tab + policy the household already chose
      await admin.from('connected_accounts')
        .update({ status: 'active', connected_by: st.user_id, updated_at: new Date().toISOString() })
        .eq('id', accountId);
    } else {
      const slug = TAB_BY_DOMAIN[email.split('@')[1]] ?? 'life';
      const { data: created, error } = await admin.from('connected_accounts').insert({
        household_id: st.household_id, provider: 'google', email, owner_id: st.user_id,
        default_tab_id: await defaultTabFor(admin, st.household_id, st.user_id, slug), connected_by: st.user_id,
      }).select('id').single();
      if (error) throw error;
      accountId = created.id;
    }

    const { error: secErr } = await admin.from('account_secrets').upsert({
      account_id: accountId,
      refresh_token_enc: await encrypt(tok.refresh_token),
      scopes: tok.scope,
      updated_at: new Date().toISOString(),
    });
    if (secErr) throw secErr;

    return back(st.return_to, { connected: email });
  } catch (e) {
    console.error('oauth callback failed', e instanceof Error ? e.message : e);
    return back(st.return_to, { error: 'connect-failed' });
  }
});
