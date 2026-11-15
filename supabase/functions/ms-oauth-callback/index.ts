// GET from Microsoft: ?code=…&state=…  (no Supabase login on this request — the one-time
// `state` proves who started it. Deployed with verify_jwt = false.)
//
// 1. Look up and delete the state (single use, 10-minute expiry)
// 2. Swap the code for tokens; make sure mail permissions were granted
// 3. Ask Microsoft Graph which address this is
// 4. Save the account (new accounts start read_only) + encrypted refresh token
//    Work/school accounts land on the ABLe tab, Outlook.com/Hotmail on Life
// 5. Send the browser back to rlyfe → Settings
import { adminClient } from '../_shared/auth.ts';
import { encrypt } from '../_shared/crypto.ts';
import { CONSUMER_TENANT, graph, MsError, msExchangeCode, tenantOf } from '../_shared/microsoft.ts';

const ERROR_MAP: Record<string, string> = {
  access_denied: 'access_denied',
  consent_required: 'ms-admin-approval',
  interaction_required: 'ms-admin-approval',
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const admin = adminClient();

  const { data: st } = await admin
    .from('oauth_states')
    .delete()
    .eq('state', url.searchParams.get('state') ?? '')
    .gt('expires_at', new Date().toISOString())
    .select('user_id, household_id, return_to')
    .maybeSingle();

  const back = (base: string, q: Record<string, string>) =>
    Response.redirect(`${base}/settings?${new URLSearchParams(q)}`, 302);

  if (!st) return back('https://rlyfe.app', { error: 'expired' });
  const err = url.searchParams.get('error');
  if (err) return back(st.return_to, { error: ERROR_MAP[err] ?? err });

  try {
    const tok = await msExchangeCode(url.searchParams.get('code') ?? '');
    if (!tok.refresh_token) return back(st.return_to, { error: 'no-refresh-token' });

    const granted = tok.scope.toLowerCase();
    if (!['mail.readwrite', 'mail.send'].every(s => granted.includes(s))) return back(st.return_to, { error: 'missing-scopes' });

    const me = await graph<{ mail?: string; userPrincipalName?: string }>('GET', 'me?$select=mail,userPrincipalName', tok.access_token);
    const email = (me.mail || me.userPrincipalName || '').toLowerCase();
    if (!email.includes('@')) return back(st.return_to, { error: 'connect-failed' });

    const { data: existing } = await admin.from('connected_accounts').select('id')
      .eq('household_id', st.household_id).eq('provider', 'microsoft').eq('email', email).maybeSingle();

    let accountId = existing?.id as string | undefined;
    if (accountId) {
      await admin.from('connected_accounts')
        .update({ status: 'active', connected_by: st.user_id, updated_at: new Date().toISOString() })
        .eq('id', accountId);
    } else {
      const personal = tenantOf(tok.id_token) === CONSUMER_TENANT;
      const { data: tab } = await admin.from('tabs').select('id')
        .eq('household_id', st.household_id).eq('slug', personal ? 'life' : 'able').maybeSingle();
      const { data: created, error } = await admin.from('connected_accounts').insert({
        household_id: st.household_id, provider: 'microsoft', email,
        default_tab_id: tab?.id ?? null, connected_by: st.user_id,
        nickname: personal ? 'Outlook' : email.split('@')[1].split('.')[0].toUpperCase().slice(0, 24),
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
    console.error('ms oauth callback failed', e instanceof MsError ? e.code : e instanceof Error ? e.message : e);
    return back(st.return_to, { error: 'connect-failed' });
  }
});
