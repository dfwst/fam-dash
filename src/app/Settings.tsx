import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { callFn } from '../lib/functions';
import { supabase } from '../lib/supabase';
import { loadAccounts, type Account } from '../lib/accounts';

const ERRORS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  expired: 'That sign-in took too long. Try again.',
  'no-refresh-token': "Google didn't grant offline access. Try again.",
  'missing-scopes': 'Some permissions were unchecked on the Google screen. Try again and leave them all checked.',
  'connect-failed': "Couldn't save the account. Try again.",
};

// What the MORNING SYNC may do on its own. Your own taps (Done, Ignore…) work on every account.
const POLICY: Record<Account['policy'], { label: string; help: string }> = {
  read_only: { label: 'Off (read only)', help: 'The morning sync never changes this mailbox.' },
  junk_only: { label: 'Junk only', help: 'Archives + marks read Junk. Glance and Real stay in the inbox.' },
  full: { label: 'Junk + Glance', help: 'Archives + marks read Junk and Glance. Real always stays in the inbox.' },
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

  async function setPolicy(a: Account, policy: Account['policy']) {
    if (policy === a.policy) return;
    if (policy !== 'read_only' && !confirm(
      `Turn on "${POLICY[policy].label}" cleanup for ${a.email}?\n\n${POLICY[policy].help}\n\n`
      + 'It starts at the next sync (6:30 weekdays, or Sync now on Review). Archived mail stays in All Mail, '
      + 'and every archive can be put back from Review → Activity.')) return;
    setError('');
    const { error } = await supabase.from('connected_accounts').update({ policy }).eq('id', a.id);
    if (error) return setError(error.message);
    setAccounts(list => list?.map(x => (x.id === a.id ? { ...x, policy } : x)) ?? null);
  }

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
                <div className="row-title ellipsis">{a.email}</div>
                <div className="muted small">{a.tabs?.name ?? 'No tab'}</div>
                <label className="policy">
                  <span className="muted small">Morning cleanup</span>
                  <select value={a.policy} onChange={e => setPolicy(a, e.target.value as Account['policy'])}>
                    {(Object.keys(POLICY) as Account['policy'][]).map(p => (
                      <option key={p} value={p}>{POLICY[p].label}</option>
                    ))}
                  </select>
                </label>
                <div className="muted small">{POLICY[a.policy].help}</div>
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
        rlyfe can read mail, archive, and mark as read — never delete. It never sends anything without your tap.
        Each account starts with morning cleanup off.
      </p>
    </section>
  );
}
