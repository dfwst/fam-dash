// Load a connected account's access token (server side only) — Google or Microsoft.
// A revoked or expired grant marks the account 'needs_reconnect' so the UI can say so.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { decrypt, encrypt } from './crypto.ts';
import { GoogleError, refreshAccess } from './google.ts';
import { MsError, msRefresh } from './microsoft.ts';

export class NeedsReconnect extends Error {}

export type Provider = 'google' | 'microsoft' | 'imap';

export async function accessTokenFor(admin: SupabaseClient, accountId: string): Promise<string> {
  const [{ data: s, error }, { data: acct }] = await Promise.all([
    admin.from('account_secrets').select('refresh_token_enc').eq('account_id', accountId).single(),
    admin.from('connected_accounts').select('provider').eq('id', accountId).single(),
  ]);
  if (error || !s) throw new NeedsReconnect('no-token');

  const markReconnect = async (): Promise<never> => {
    await admin.from('connected_accounts')
      .update({ status: 'needs_reconnect', updated_at: new Date().toISOString() })
      .eq('id', accountId);
    throw new NeedsReconnect('invalid_grant');
  };

  if (acct?.provider === 'microsoft') {
    try {
      const tok = await msRefresh(await decrypt(s.refresh_token_enc));
      if (tok.refresh_token) {
        // Microsoft rotates refresh tokens — keep the newest so the grant never ages out
        await admin.from('account_secrets').update({
          refresh_token_enc: await encrypt(tok.refresh_token), updated_at: new Date().toISOString(),
        }).eq('account_id', accountId);
      }
      return tok.access_token;
    } catch (e) {
      if (e instanceof MsError && (e.code === 'invalid_grant' || e.code === 'interaction_required')) return markReconnect();
      throw e;
    }
  }

  try {
    const tok = await refreshAccess(await decrypt(s.refresh_token_enc));
    return tok.access_token;
  } catch (e) {
    if (e instanceof GoogleError && e.code === 'invalid_grant') return markReconnect();
    throw e;
  }
}
