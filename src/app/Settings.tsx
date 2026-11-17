import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { callFn } from '../lib/functions';
import { supabase } from '../lib/supabase';
import GmailOpenTest from './GmailOpenTest';
import ConnectImap from './ConnectImap';
import OldMailCleanup from './OldMailCleanup';
import { loadAccounts, serviceName, type Account } from '../lib/accounts';
import AccountPurpose from './AccountPurpose';
import AboutYou from './AboutYou';
import Household from './Household';
import Rules from './Rules';
import SortingGuide from './SortingGuide';
import { ARCHIVE_NOTE, BUCKET_LABEL } from '../lib/buckets';

const ERRORS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  expired: 'That sign-in took too long. Try again.',
  'no-refresh-token': "Google didn't grant offline access. Try again.",
  'missing-scopes': 'Some permissions were unchecked on the Google screen. Try again and leave them all checked.',
  'connect-failed': "Couldn't save the account. Try again.",
  'ms-admin-approval': "Your organization's IT has to approve rlyfe before this work account can connect.",
  'ms-not-configured': "Microsoft sign-in isn't set up on the server yet.",
  'connected-by-someone-else': 'Someone else in your household already connected that address — it stays in their rlyfe.',
};

// What the MORNING SYNC may do on its own. Your own taps (Done, Ignore…) work on every account.
// Each choice says exactly what moves and what stays — no guessing.
const POLICY: Record<Account['policy'], { label: string; help: string }> = {
  read_only: { label: 'Off', help: 'rlyfe only sorts what you see here. Nothing in this inbox moves.' },
  junk_only: { label: `Clear ${BUCKET_LABEL[1]}`, help: `Each morning, ${BUCKET_LABEL[1]} leaves this inbox. ${BUCKET_LABEL[2]} and ${BUCKET_LABEL[3]} stay.` },
  full: { label: `Clear ${BUCKET_LABEL[1]} and ${BUCKET_LABEL[2]}`, help: `Each morning, ${BUCKET_LABEL[1]} and ${BUCKET_LABEL[2]} leave this inbox. ${BUCKET_LABEL[3]} always stays.` },
};

// Settings is split into sections with a sub-nav; ?s= keeps your place (and the back button works)
const SECTIONS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'about', label: 'About you' },
  { id: 'rules', label: 'Rules' },
  { id: 'invites', label: 'Invites' },
  { id: 'more', label: 'More' },
] as const;
type SectionId = typeof SECTIONS[number]['id'];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const section: SectionId = SECTIONS.some(x => x.id === params.get('s')) ? params.get('s') as SectionId : 'accounts';
  const go = (id: SectionId) => setParams(id === 'accounts' ? {} : { s: id });
  const [openAcct, setOpenAcct] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imapFor, setImapFor] = useState<string | null>(null); // '' = new account, email = reconnect
  const [justConnected, setJustConnected] = useState('');
  const [tabs, setTabs] = useState<{ id: string; name: string; slug: string; owner_id: string | null }[]>([]);
  const [notice, setNotice] = useState('');
  const [cleanupFor, setCleanupFor] = useState<string | null>(null);
  const [myId, setMyId] = useState('');
  const [me, setMe] = useState<{ display_name: string | null; profile: Record<string, string>; onboarded_at: string | null } | null>(null);

  const connected = params.get('connected') || justConnected;
  const urlError = params.get('error');
  const welcome = params.get('welcome');

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setMyId(user?.id ?? '');
      supabase.from('household_members').select('display_name, profile, onboarded_at').eq('user_id', user?.id ?? '')
        .maybeSingle().then(({ data }) => setMe(data as typeof me));
    });
    loadAccounts().then(setAccounts).catch(e => setError(e.message));
    supabase.from('tabs').select('id, name, slug, owner_id').eq('is_active', true).order('sort_order')
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

  // Share an account with the household (its mail shows for everyone, on the tab you pick)
  async function setShared(a: Account, shared: boolean) {
    if (shared && !confirm(`Share ${a.email} with your household?\n\nEveryone in the household will see its mail, sorting and history.`)) return;
    // Shared mail has to land on a tab everyone sees — move it off a private tab onto Shared
    const onPrivate = !!tabs.find(t => t.id === a.default_tab_id)?.owner_id;
    const sharedTab = tabs.find(t => !t.owner_id && t.slug === 'shared') ?? tabs.find(t => !t.owner_id);
    const move = shared && onPrivate && sharedTab ? { default_tab_id: sharedTab.id } : {};
    const { error } = await supabase.from('connected_accounts').update({ shared, ...move }).eq('id', a.id);
    if (error) return setError(error.message);
    setAccounts(list => list?.map(x => (x.id === a.id
      ? { ...x, shared, ...(sharedTab && 'default_tab_id' in move ? { default_tab_id: sharedTab.id, tabs: { name: sharedTab.name } } : {}) }
      : x)) ?? null);
  }

  return (
    <section className="stack">
      <nav className="subnav" aria-label="Settings sections">
        {SECTIONS.map(x => (
          <button key={x.id} className={section === x.id ? 'subnav-item active' : 'subnav-item'}
                  aria-current={section === x.id ? 'page' : undefined} onClick={() => go(x.id)}>{x.label}</button>
        ))}
      </nav>

      {section === 'about' && (me ? <AboutYou me={me} onSaved={m => setMe(x => (x ? { ...x, ...m } : x))} /> : <p className="muted">Loading…</p>)}
      {section === 'rules' && <Rules />}
      {section === 'invites' && <Household />}
      {section === 'more' && (
        <div className="stack">
          <h3 className="section-title">How rlyfe sorts your mail</h3>
          <SortingGuide />
          <h3 className="section-title">What rlyfe can and can’t do</h3>
          <p className="muted small hint">
            rlyfe can read mail, archive it, and mark it read — it never deletes, and never sends anything without your tap.
            Every account starts with Morning cleanup off. Work Microsoft accounts may need your IT department to approve rlyfe.
          </p>
          <GmailOpenTest />
          <button className="signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      )}

      {section === 'accounts' && <>
      {welcome && (
        <p className="notice" onClick={() => setParams({})}>
          Thanks! Now connect your email below — Gmail, Outlook, or Yahoo / iCloud / AOL. After each one, rlyfe asks
          what it’s for, then <strong>Review → Sync now</strong> brings the mail in.
        </p>
      )}

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
                <button className="acct-head" aria-expanded={openAcct === a.id} onClick={() => setOpenAcct(o => (o === a.id ? null : a.id))}>
                  <span className="row-title ellipsis">{a.email}</span>
                  <span className="muted small">
                    {serviceName(a)} · {a.tabs?.name ?? (a.default_tab_id ? 'their tab' : 'no tab')}{a.nickname ? ` · “${a.nickname}”` : ''}{a.shared ? ' · shared' : ''}
                  </span>
                  <span className="acct-chevron" aria-hidden>{openAcct === a.id ? '▴' : '▾'}</span>
                </button>
                {!a.ai_context && a.owner_id === myId && (
                  <AccountPurpose account={a} onSaved={ai_context => setAccounts(l => l?.map(x => (x.id === a.id ? { ...x, ai_context } : x)) ?? null)} />
                )}
                {openAcct === a.id && <div className="acct-form">
                  <NicknameField account={a} onSave={n => setNickname(a, n)} />
                  <label className="field">
                    <span className="field-label">Shows on tab</span>
                    <select value={a.default_tab_id ?? ''} onChange={e => setTab(a, e.target.value)}>
                      {!a.default_tab_id && <option value="">— none —</option>}
                      {/* a shared account can only show on a tab everyone sees */}
                      {tabs.filter(t => !a.shared || !t.owner_id || t.id === a.default_tab_id).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>

                  <fieldset className="choices">
                    <legend className="field-label">Morning cleanup</legend>
                    {(Object.keys(POLICY) as Account['policy'][]).map(p => (
                      <label key={p} className={a.policy === p ? 'choice on' : 'choice'}>
                        <input type="radio" name={`policy-${a.id}`} checked={a.policy === p} onChange={() => setPolicy(a, p)} />
                        <span className="choice-text">
                          <span className="choice-title">{POLICY[p].label}</span>
                          <span className="choice-help">{POLICY[p].help}</span>
                        </span>
                      </label>
                    ))}
                    <p className="field-help">{ARCHIVE_NOTE}</p>
                  </fieldset>

                  {a.owner_id === myId && (
                    <label className="switch-row">
                      <span className="choice-text">
                        <span className="choice-title">Shared with household</span>
                        <span className="choice-help">Everyone in your household sees this account’s mail.</span>
                      </span>
                      <input type="checkbox" className="switch" checked={a.shared} onChange={e => setShared(a, e.target.checked)} />
                    </label>
                  )}

                  <div className="acct-links">
                    {a.provider === 'imap' && (
                      <button className="acct-link" onClick={() => setCleanupFor(c => (c === a.id ? null : a.id))}>
                        <span>{cleanupFor === a.id ? 'Close cleanup' : 'Clean up old mail'}</span><span className="chev" aria-hidden>›</span>
                      </button>
                    )}
                    {cleanupFor === a.id && <OldMailCleanup accountId={a.id} email={a.email} />}
                    <Link className="acct-link" to={`/retire/${a.id}`}><span>Retire this address</span><span className="chev" aria-hidden>›</span></Link>
                    {a.owner_id === myId && (
                      <button className="acct-link danger" disabled={busy} onClick={() => remove(a)}><span>Remove account</span></button>
                    )}
                  </div>
                </div>}
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
      <p className="muted small">rlyfe never deletes mail and never sends without your tap. Tap an account to change its settings.</p>
      </>}
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
    <label className="field">
      <span className="field-label">Label on emails <span className="nick-state" aria-live="polite">{saved ? 'Saved ✓' : ''}</span></span>
      <input value={value} maxLength={24} placeholder={account.email.split('@')[0]}
             onChange={e => setValue(e.target.value)} onBlur={commit}
             onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <span className="field-help">A short name shown on each email so you can tell which account it came from.</span>
    </label>
  );
}
