import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { callFn } from '../lib/functions';
import { loadAccounts, type Account } from '../lib/accounts';

const ERRORS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  expired: 'That sign-in took too long. Try again.',
  'no-refresh-token': "Google didn't grant offline access. Try again.",
  'missing-scopes': 'Some permissions were unchecked on the Google screen. Try again and leave them all checked.',
  'connect-failed': "Couldn't save the account. Try again.",
};

const POLICY: Record<Account['policy'], string> = {
  read_only: 'Read only',
  junk_only: 'Junk cleanup only',
  full: 'Full cleanup',
};

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const connected = params.get('connected');
  const urlError = params.get('error');

  useEffect(() => {
    loadAccounts().then(setAccounts).catch(e => setError(e.message));
  }, []);

  async function connect(loginHint?: string) {
    setBusy(true);
    setError('');
    try {
      const { url } = await callFn<{ url: string }>('google-oauth-start', { loginHint });
      window.location.href = url; // off to Google; we come back to /settings
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <h2>Accounts</h2>

      {connected && (
        <p className="notice" onClick={() => setParams({})}>Connected {connected}. Mail is read only until we turn on cleanup.</p>
      )}
      {urlError && <p className="error">{ERRORS[urlError] ?? `Connect failed (${urlError}).`}</p>}
      {error && <p className="error">{error}</p>}

      {!accounts ? (
        <p className="muted">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="muted">No mail accounts connected yet.</p>
      ) : (
        <ul className="list">
          {accounts.map(a => (
            <li key={a.id} className="row">
              <div className="row-main">
                <div className="row-title">{a.email}</div>
                <div className="muted small">
                  {a.tabs?.name ?? 'No tab'} · {POLICY[a.policy]}
                </div>
              </div>
              {a.status === 'needs_reconnect' ? (
                <button className="pill warn" disabled={busy} onClick={() => connect(a.email)}>Reconnect</button>
              ) : (
                <span className="pill">Connected</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <button className="primary" disabled={busy} onClick={() => connect()}>
        {busy ? 'Opening Google…' : 'Connect a Gmail account'}
      </button>
      <p className="muted small">
        rlyfe can read mail, archive, and mark as read. It never sends anything without your tap.
        Each account starts read only.
      </p>
    </section>
  );
}
