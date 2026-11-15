// Microsoft sign-in (Entra ID) + Microsoft Graph mail helpers.
// Secrets: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET (Edge Function secrets).
// One app registration (in the DFW Smart Tech directory, multitenant + personal accounts)
// serves work/school accounts (ABLe, once its IT approves) and Outlook.com / Hotmail.

export const MS_SCOPES = [
  'openid',                      // who signed in (tells work accounts from Outlook.com)
  'offline_access',              // refresh token for the morning sync
  'User.Read',                   // which address this is
  'Mail.ReadWrite',              // read, archive, mark read
  'Mail.Send',                   // replies (only when you tap Send)
  'MailboxSettings.ReadWrite',   // "Always ignore" inbox rules
];

const CLIENT_ID = Deno.env.get('MICROSOFT_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('MICROSOFT_CLIENT_SECRET') ?? '';
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
// Netlify proxies this to the ms-oauth-callback function (see netlify.toml)
export const MS_REDIRECT_URI = 'https://rlyfe.app/oauth/microsoft/callback';

// Personal Microsoft accounts (Outlook.com, Hotmail) all sign in through this tenant id
export const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export function msAuthUrl(state: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: MS_REDIRECT_URI,
    response_mode: 'query',
    scope: MS_SCOPES.join(' '),
    prompt: 'select_account', // Windows may be signed in to a different account
    state,
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${AUTHORITY}/authorize?${p}`;
}

export type MsToken = { access_token: string; refresh_token?: string; scope: string; id_token?: string };

export class MsError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

async function tokenCall(params: Record<string, string>): Promise<MsToken> {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: MS_SCOPES.join(' '), ...params }),
  });
  const body = await res.json();
  if (!res.ok) throw new MsError(body.error ?? 'token-failed', res.status);
  return body;
}

export const msExchangeCode = (code: string) =>
  tokenCall({ code, grant_type: 'authorization_code', redirect_uri: MS_REDIRECT_URI });

// Microsoft usually hands back a NEW refresh token each time — the caller saves it.
export const msRefresh = (refreshToken: string) =>
  tokenCall({ refresh_token: refreshToken, grant_type: 'refresh_token' });

// The tenant this account belongs to (personal accounts → CONSUMER_TENANT)
export function tenantOf(idToken?: string): string | null {
  try {
    const part = (idToken ?? '').split('.')[1] ?? '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(b64)).tid ?? null;
  } catch { return null; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Graph wrapper. ImmutableId keeps a message's id the same when it moves folders
// (archive/undo), so our stored ids never go stale. Backs off when Graph says "slow down".
export async function graph<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, token: string, body?: unknown,
): Promise<T> {
  const url = path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0/${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'IdType="ImmutableId"',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return (res.status === 202 || res.status === 204 ? undefined : await res.json()) as T;
    if ((res.status === 429 || res.status === 503) && attempt < 5) {
      const wait = Number(res.headers.get('Retry-After')) * 1000 || 1000 * 2 ** attempt;
      await sleep(Math.min(wait, 20_000) + Math.random() * 300);
      continue;
    }
    const err = await res.json().catch(() => ({}));
    throw new MsError(`graph-${res.status}:${err?.error?.code ?? ''}`, res.status);
  }
}
