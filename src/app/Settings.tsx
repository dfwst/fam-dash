import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { callFn } from '../lib/functions';
import { supabase } from '../lib/supabase';
import GmailOpenTest from './GmailOpenTest';
import ConnectImap from './ConnectImap';
import { loadAccounts, serviceName, type Account } from '../lib/accounts';

const ERRORS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  expired: 'That sign-in took too long. Try again.',
  'no-refresh-token': "Google didn't grant offline access. Try again.",
  'missing-scopes': 'Some permissions were unchecked on the Google screen. Try again and leave them all checked.',
  'connect-failed': "Couldn't save the account. Try again.",
  'ms-admin-approval': "Your organization's IT has to approve rlyfe before this work account can connect.",
  'ms-not-configured': "Microsoft sign-in isn't set up on the server yet.",
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
  const [imapFor, setImapFor] = useState<string | null>(null); // '' = new account, email = reconnect
  const [justConnected, setJustConnected] = useState('');
  const [tabs, setTabs] = useState<{ id: string; name: string }[]>([]);
  const [notice, setNotice] = useState('');

  const connected = params.get('connected') || justConnected;
  const urlError = params.get('error');

  useEffect(() => {
    loadAccounts().then(setAccounts).catch(e => setError(e.message));
    supabase.from('tabs').select('id, name').eq('is_active', true).order('sort_order')
      .then(({ data }) => setTabs(data ?? []));
  }, []);

  // Which tab this account's mail shows on — takes effect right away, no re-sync needed
  async function setTab(a: Account, tabId: string) {
    if (tabId === a.default_tab_id) return;
    setError('');
    const { error } = await supabase.from('connected_accounts').update({ default_tab_id: tabId }).eq('id', a.id);
    if (error) return setError(error.message);
    const name = tabs.find(t => t.id === tabId)?.name ?? '';
    setAccounts(list => list?.map(x => (x.id === a.id ? { ...x, default_tab_id: tabId, tabs: { name } } : x)) ?? null);
  }

  async function remove(a: Account) {
    if (!confirm(
      `Remove ${a.email} from rlyfe?\n\n`
      + 'rlyfe forgets its sign-in, its sorted emails and its history. Your mailbox itself is not touched — '
      + 'nothing is deleted or moved there. To-Do items made from its emails stay.\n\n'
      + 'You can connect it again any time (sorting starts fresh).')) return;
    setError(''); setBusy(true);
    try {
      await callFn('account-remove', { accountId: a.id });
      setAccounts(list => list?.filter(x => x.id !== a.id) ?? null);
      setNotice(`Removed ${a.email}.`);
    } catch (e) {
      setError(`Couldn't remove it (${e instanceof Error ? e.message : 'failed'}).`);
    } finally {
      setBusy(false);
    }
  }

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

  async function setNickname(a: Account, nickname: string) {
    const next = nickname.trim().slice(0, 24) || null;
    if (next === a.nickname) return;
    setError('');
    const { error } = await supabase.from('connected_accounts').update({ nickname: next }).eq('id', a.id);
    if (error) return setError(error.message);
    setAccounts(list => list?.map(x => (x.id === a.id ? { ...x, nickname: next } : x)) ?? null);
  }

  async function connect(provider: Account['provider'], loginHint?: string) {
    setBusy(true);
    setError('');
    try {
      const fn = provider === 'microsoft' ? 'ms-oauth-start' : 'google-oauth-start';
      const { url } = await callFn<{ url: string }>(fn, { loginHint });
      window.location.href = url; // off to Google; we come back to /settings
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong';
      setError(ERRORS[msg] ?? msg);
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
      {notice && <p className="notice" onClick={() => setNotice('')}>{notice}</p>}

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
                <div className="muted small">{serviceName(a)}</div>
                <NicknameField account={a} onSave={n => setNickname(a, n)} />
                <label className="policy">
                  <span className="muted small">Shows on tab</span>
                  <select value={a.default_tab_id ?? ''} onChange={e => setTab(a, e.target.value)}>
                    {!a.default_tab_id && <option value="">— none —</option>}
                    {tabs.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
                <label className="policy">
                  <span className="muted small">Morning cleanup</span>
                  <select value={a.policy} onChange={e => setPolicy(a, e.target.value as Account['policy'])}>
                    {(Object.keys(POLICY) as Account['policy'][]).map(p => (
                      <option key={p} value={p}>{POLICY[p].label}</option>
                    ))}
                  </select>
                </label>
                <div className="muted small">{POLICY[a.policy].help}</div>
                <button className="link danger small remove-acct" disabled={busy} onClick={() => remove(a)}>Remove account</button>
              </div>
              {a.status === 'needs_reconnect' ? (
                <button className="pill warn" disabled={busy} onClick={() => (a.provider === 'imap' ? setImapFor(a.email) : connect(a.provider, a.email))}>Reconnect</button>
              ) : (
                <span className="pill">Connected</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="connect-buttons">
        <button className="primary" disabled={busy} onClick={() => connect('google')}>
          {busy ? 'Opening sign-in…' : 'Connect Gmail'}
        </button>
        <button className="primary" disabled={busy} onClick={() => connect('microsoft')}>
          Connect Outlook / Microsoft 365
        </button>
        <button className="primary" disabled={busy} onClick={() => setImapFor(f => (f === null ? '' : null))}>
          Connect Yahoo, iCloud, AOL…
        </button>
      </div>
      {imapFor !== null && (
        <ConnectImap initialEmail={imapFor || undefined} onCancel={() => setImapFor(null)}
                     onDone={email => {
                       setImapFor(null);
                       setJustConnected(email);
                       loadAccounts().then(setAccounts).catch(e => setError(e.message));
                     }} />
      )}
      <p className="muted small">
        rlyfe can read mail, archive, and mark as read — never delete. It never sends anything without your tap.
        Each account starts with morning cleanup off. Work Microsoft accounts may need your IT department to approve rlyfe.
      </p>

      <GmailOpenTest />
    </section>
  );
}

// The short name shown on each email ("tsagmail"). Saves when you leave the field or press Enter.
function NicknameField({ account, onSave }: { account: Account; onSave: (n: string) => void }) {
  const [value, setValue] = useState(account.nickname ?? '');
  const [saved, setSaved] = useState(false);
  useEffect(() => setValue(account.nickname ?? ''), [account.nickname]);

  const commit = () => {
    if (value.trim() === (account.nickname ?? '')) return;
    onSave(value);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <label className="policy">
      <span className="muted small">Label on emails</span>
      <input value={value} maxLength={24} placeholder={account.email.split('@')[0]}
             onChange={e => setValue(e.target.value)} onBlur={commit}
             onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <span className="muted small nick-state" aria-live="polite">{saved ? 'Saved ✓' : ''}</span>
    </label>
  );
}
