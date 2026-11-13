// Google OAuth + Gmail API helpers.
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (Edge Function secrets).

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',         // read, archive, mark read, drafts, send
  'https://www.googleapis.com/auth/gmail.settings.basic', // create "always ignore" filters (M4)
];

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
// Netlify proxies this to the google-oauth-callback function (see netlify.toml),
// so the Supabase project address never appears on Google's screens.
export const REDIRECT_URI = 'https://rlyfe.app/oauth/google/callback';

export function authUrl(state: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',   // we need a refresh token for the morning job
    prompt: 'consent',        // forces Google to issue a refresh token every time
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

type TokenResponse = { access_token: string; refresh_token?: string; scope: string; expires_in: number };

async function tokenCall(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const body = await res.json();
  if (!res.ok) throw new GoogleError(body.error ?? 'token-failed', res.status);
  return body;
}

export const exchangeCode = (code: string) =>
  tokenCall({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI });

export const refreshAccess = (refreshToken: string) =>
  tokenCall({ refresh_token: refreshToken, grant_type: 'refresh_token' });

export class GoogleError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Thin Gmail GET wrapper: gmail('threads', token, { labelIds: 'INBOX' })
// Gmail limits each mailbox to a burst rate; when it says "slow down" (429, or 403
// with a rate/quota reason) we wait 1s, 2s, 4s, 8s, 16s (+ jitter) and try again.
export async function gmail<T = any>(path: string, accessToken: string, query: Record<string, string | string[]> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) qs.append(k, x);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}?${qs}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) return res.json();
    const body = await res.json().catch(() => ({}));
    const reason: string = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '';
    const slowDown = res.status === 429 || (res.status === 403 && /rate|quota|limit/i.test(reason));
    if (slowDown && attempt < 5) {
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
      continue;
    }
    throw new GoogleError(`gmail-${res.status}${reason ? `:${reason}` : ''}`, res.status);
  }
}
