// Unsubscribe from a mailing list the standard ways, safest first:
//
//   one-click  RFC 8058: the sender lists an https unsubscribe URL AND "List-Unsubscribe-Post:
//              List-Unsubscribe=One-Click". We POST exactly that body — no page, no form. Gmail and
//              Yahoo have required this of bulk senders since 2024, so most real lists support it.
//   email      RFC 2369 mailto: — we send a short "unsubscribe" email from the account.
//   link       only a web page — we can't safely click through forms/CAPTCHAs, so the app opens it.
//
// Never used on spam / phishing (callers check) — unsubscribing there only confirms your address.

export type UnsubPlan =
  | { method: 'one-click'; url: string }
  | { method: 'email'; to: string; subject: string; body: string }
  | { method: 'link'; url: string }
  | { method: 'none' };

const SAFE_HOST = /^(?!localhost$)(?!\d+\.\d+\.\d+\.\d+$)(?!\[)[a-z0-9.-]+\.[a-z]{2,}$/i;

export function planUnsubscribe(listUnsub: string | undefined, listUnsubPost: string | undefined): UnsubPlan {
  if (!listUnsub) return { method: 'none' };
  const links = [...listUnsub.matchAll(/<([^>]+)>/g)].map(m => m[1].trim());
  const https = links.find(l => {
    try { const u = new URL(l); return u.protocol === 'https:' && SAFE_HOST.test(u.hostname); } catch { return false; }
  });
  const mailto = links.find(l => l.toLowerCase().startsWith('mailto:'));

  if (https && /List-Unsubscribe\s*=\s*One-Click/i.test(listUnsubPost ?? '')) return { method: 'one-click', url: https };
  if (mailto) {
    try {
      const u = new URL(mailto);
      const to = decodeURIComponent(u.pathname);
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        return {
          method: 'email', to,
          subject: u.searchParams.get('subject') || 'unsubscribe',
          body: u.searchParams.get('body') || 'unsubscribe',
        };
      }
    } catch { /* fall through */ }
  }
  if (https) return { method: 'link', url: https };
  return { method: 'none' };
}

// The one-click POST. Success = the sender's server accepted it (2xx/3xx).
export async function oneClick(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'rlyfe-unsubscribe/1.0' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      signal: ctrl.signal,
    });
    await res.body?.cancel();
    return res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Headers of the newest message in a (Gmail-shaped) thread that carries an unsubscribe header
export function unsubHeadersOf(t: { messages: { payload: { headers?: { name: string; value: string }[] } }[] }) {
  for (const m of [...t.messages].reverse()) {
    const h = (n: string) => m.payload.headers?.find(x => x.name.toLowerCase() === n)?.value ?? '';
    if (h('list-unsubscribe')) return { listUnsub: h('list-unsubscribe'), listUnsubPost: h('list-unsubscribe-post') };
  }
  return { listUnsub: undefined, listUnsubPost: undefined };
}
