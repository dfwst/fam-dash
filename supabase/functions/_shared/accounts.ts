// Load a connected account's Google access token (server side only).
// A revoked or expired grant marks the account 'needs_reconnect' so the UI can say so.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { decrypt } from './crypto.ts';
import { GoogleError, refreshAccess } from './google.ts';

export class NeedsReconnect extends Error {}

export async function accessTokenFor(admin: SupabaseClient, accountId: string): Promise<string> {
  const { data: s, error } = await admin
    .from('account_secrets')
    .select('refresh_token_enc')
    .eq('account_id', accountId)
    .single();
  if (error || !s) throw new NeedsReconnect('no-token');

  try {
    const tok = await refreshAccess(await decrypt(s.refresh_token_enc));
    return tok.access_token;
  } catch (e) {
    if (e instanceof GoogleError && e.code === 'invalid_grant') {
      await admin.from('connected_accounts')
        .update({ status: 'needs_reconnect', updated_at: new Date().toISOString() })
        .eq('id', accountId);
      throw new NeedsReconnect('invalid_grant');
    }
    throw e;
  }
}
