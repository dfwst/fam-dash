// POST (signed in, 2FA) — connect a Yahoo / AOL / iCloud / other IMAP account with an APP PASSWORD.
//   { service, email, password, imapHost?, imapPort?, smtpHost?, smtpPort? }   (hosts only for 'other')
// Tests the IMAP and SMTP sign-ins first; saves nothing unless both work. The password is stored
// encrypted (AES-256-GCM, same as Google/Microsoft tokens) and never sent back to the browser.
import { requireMember } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { encrypt } from '../_shared/crypto.ts';
import { defaultTabFor } from '../_shared/people.ts';
import { PRESETS, testCreds, type ImapCreds, type ImapService } from '../_shared/imap.ts';

const SERVICES: ImapService[] = ['yahoo', 'aol', 'icloud', 'other'];
const NICK: Record<ImapService, string> = { yahoo: 'Yahoo', aol: 'AOL', icloud: 'iCloud', other: '' };
// "other" servers: a real public host name and the standard secure mail ports only
const HOST_RX = /^(?!localhost$)(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;

  const b = await req.json().catch(() => ({}));
  const service = b.service as ImapService;
  const email = String(b.email ?? '').trim().toLowerCase();
  const pass = String(b.password ?? '').replace(/\s+/g, ''); // app passwords are often shown with spaces
  if (!SERVICES.includes(service) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || pass.length < 6 || pass.length > 200) {
    return json({ error: 'bad-input' }, 400);
  }

  let servers: Omit<ImapCreds, 'service' | 'user' | 'pass'>;
  if (service === 'other') {
    const imapHost = String(b.imapHost ?? '').trim(), smtpHost = String(b.smtpHost ?? '').trim();
    const imapPort = Number(b.imapPort ?? 993), smtpPort = Number(b.smtpPort ?? 465);
    if (!HOST_RX.test(imapHost) || !HOST_RX.test(smtpHost) || imapPort !== 993 || ![465, 587].includes(smtpPort)) {
      return json({ error: 'bad-server' }, 400);
    }
    servers = { imapHost, imapPort, smtpHost, smtpPort };
  } else {
    servers = PRESETS[service];
  }
  const creds: ImapCreds = { service, user: email, pass, ...servers };

  try {
    await testCreds(creds);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const text = `${msg} ${(e as { responseText?: string }).responseText ?? ''}`;
    console.error('imap-connect test failed', service, text.slice(0, 200));
    if (/auth|credential|login|password|535|534/i.test(text)) return json({ error: 'imap-auth' }, 400);
    return json({ error: 'imap-unreachable' }, 502);
  }

  const { data: existing } = await ctx.admin.from('connected_accounts').select('id, owner_id')
    .eq('household_id', ctx.householdId).eq('provider', 'imap').eq('email', email).maybeSingle();
  // Someone else in the household already connected this address — it's theirs, not yours
  if (existing && existing.owner_id !== ctx.userId) return json({ error: 'connected-by-someone-else' }, 409);
  let accountId = existing?.id as string | undefined;
  if (accountId) {
    await ctx.admin.from('connected_accounts')
      .update({ status: 'active', mail_service: service, connected_by: ctx.userId, updated_at: new Date().toISOString() })
      .eq('id', accountId);
  } else {
    const { data: created, error } = await ctx.admin.from('connected_accounts').insert({
      household_id: ctx.householdId, provider: 'imap', mail_service: service, email, owner_id: ctx.userId,
      default_tab_id: await defaultTabFor(ctx.admin, ctx.householdId, ctx.userId, 'life'), connected_by: ctx.userId,
      nickname: NICK[service] || email.split('@')[1].split('.')[0].slice(0, 24),
    }).select('id').single();
    if (error) return json({ error: 'connect-failed' }, 500);
    accountId = created.id;
  }

  const { error: secErr } = await ctx.admin.from('account_secrets').upsert({
    account_id: accountId,
    refresh_token_enc: await encrypt(JSON.stringify(creds)),
    scopes: `imap:${servers.imapHost} smtp:${servers.smtpHost}`,
    updated_at: new Date().toISOString(),
  });
  if (secErr) return json({ error: 'connect-failed' }, 500);

  return json({ connected: email });
});
