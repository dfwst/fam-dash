// POST (signed in, 2FA) { accountId } — disconnect a mail account from rlyfe.
//
// Removes rlyfe's copy of everything about it: the sign-in (encrypted token / app password),
// sorted emails, sync history, activity log. To-Do items made from its emails stay (unlinked).
// The mailbox itself is NOT touched — nothing is deleted or moved in Gmail/Outlook/Yahoo.
// Google: the sign-in is also revoked at Google, so the access is dead, not just forgotten.
import { requireMember } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { decrypt } from '../_shared/crypto.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;

  const { accountId } = await req.json().catch(() => ({}));
  const { data: acct } = await ctx.admin.from('connected_accounts').select('id, email, provider, owner_id, shared')
    .eq('id', String(accountId ?? '')).eq('household_id', ctx.householdId).maybeSingle();
  if (!acct || (acct.owner_id !== ctx.userId && !acct.shared)) return json({ error: 'not-found' }, 404);
  // Only the person who connected it can remove it (a shared account is still theirs)
  if (acct.owner_id !== ctx.userId) return json({ error: 'not-yours' }, 403);

  // Revoke Google's grant (best effort — the account is removed either way)
  if (acct.provider === 'google') {
    try {
      const { data: s } = await ctx.admin.from('account_secrets').select('refresh_token_enc').eq('account_id', acct.id).maybeSingle();
      if (s) {
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: await decrypt(s.refresh_token_enc) }),
        });
      }
    } catch (e) {
      console.error('google revoke failed', e instanceof Error ? e.message : e);
    }
  }

  // "Always ignore" bookkeeping: forget this account's filter/rule ids
  const { data: prefs } = await ctx.admin.from('sender_prefs').select('sender_email, gmail_filters')
    .eq('household_id', ctx.householdId).eq('owner_id', ctx.userId).not('gmail_filters', 'is', null);
  for (const p of (prefs ?? []).filter(p => (p.gmail_filters as Record<string, string>)?.[acct.id])) {
    const filters = { ...(p.gmail_filters as Record<string, string>) };
    delete filters[acct.id];
    await ctx.admin.from('sender_prefs')
      .update({ gmail_filters: filters, always_ignore: Object.keys(filters).length > 0, updated_at: new Date().toISOString() })
      .eq('household_id', ctx.householdId).eq('owner_id', ctx.userId).eq('sender_email', p.sender_email);
  }

  // Cascades: account_secrets, email_threads, sync_runs, action_log. tasks.account_id → null.
  const { error } = await ctx.admin.from('connected_accounts').delete().eq('id', acct.id);
  if (error) return json({ error: 'remove-failed' }, 500);
  return json({ removed: acct.email, provider: acct.provider });
});
