import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/functions';

// Who's in this household, and inviting someone new. Each person's email stays private
// unless they mark an account "shared"; the Shared tab and its To-Dos are for everyone.
type Member = { user_id: string; display_name: string | null; role: string };
type Invite = { id: string; name: string; expires_at: string; accepted_at: string | null };

export default function Household() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [name, setName] = useState('');
  const [family, setFamily] = useState('');
  const [kids, setKids] = useState('');
  const [church, setChurch] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [fromId, setFromId] = useState('');
  const [mine, setMine] = useState<{ id: string; email: string }[]>([]);
  const [sent, setSent] = useState('');

  const load = () => {
    supabase.from('household_members').select('user_id, display_name, role').then(({ data }) => setMembers(data ?? []));
    supabase.from('household_invites').select('id, name, expires_at, accepted_at').is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()).then(({ data }) => setInvites(data ?? []));
  };
  useEffect(load, []);
  // Your own connected accounts — the invite email goes out from one of these
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) =>
      supabase.from('connected_accounts').select('id, email').eq('owner_id', user?.id ?? '').eq('status', 'active').order('email')
        .then(({ data }) => { setMine(data ?? []); if (data?.[0]) setFromId(f => f || data[0].id); }));
  }, []);

  async function create() {
    setBusy(true); setError(''); setLink(''); setSent('');
    try {
      const profile = Object.fromEntries(Object.entries({ family, kids, church }).filter(([, v]) => v.trim()));
      const r = await callFn<{ link: string; emailed?: string; emailError?: string }>('invite', {
        action: 'create', name, profile, ...(email.trim() ? { email: email.trim(), fromAccountId: fromId } : {}),
      });
      setLink(r.link);
      if (r.emailed) setSent(`Emailed the invite to ${r.emailed} from ${mine.find(m => m.id === fromId)?.email}.`);
      if (r.emailError) setError(`The invite was created, but the email didn’t send (${r.emailError}). Copy the link below and send it another way.`);
      load();
    } catch (e) {
      const m = e instanceof Error ? e.message : 'failed';
      setError(m === 'bad-email' ? 'Check the email address.' : m === 'pick-from-account' ? 'Pick one of your accounts to send from.' : m);
    } finally { setBusy(false); }
  }

  async function cancel(id: string) {
    await callFn('invite', { action: 'cancel', id }).catch(() => {});
    load();
  }

  return (
    <section className="stack">
      <ul className="list">
        {members.map(m => (
          <li key={m.user_id} className="row"><span className="row-title">{m.display_name || 'Member'}</span>
            <span className="muted small">{m.role === 'owner' ? 'Set up rlyfe' : 'Member'}</span></li>
        ))}
        {invites.map(i => (
          <li key={i.id} className="row"><span className="row-title">{i.name} <span className="muted small">· invited</span></span>
            <button className="link small" onClick={() => cancel(i.id)}>Cancel invite</button></li>
        ))}
      </ul>
      <p className="muted small">
        Everyone’s email is private — only you see your accounts. The <strong>Shared</strong> tab (and its To-Dos) is for everyone.
      </p>

      {!open ? (
        <button onClick={() => setOpen(true)}>Invite someone…</button>
      ) : (
        <div className="add-todo invite">
          <label className="field"><span className="muted small">Their first name</span>
            <input value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="Blake" /></label>
          <label className="field"><span className="muted small">Their email (optional — rlyfe emails the invite from your account)</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="them@example.com" /></label>
          {email.trim() && mine.length > 0 && (
            <label className="field"><span className="muted small">Send from</span>
              <select value={fromId} onChange={e => setFromId(e.target.value)}>
                {mine.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}
              </select></label>
          )}
          <p className="muted small">Optional — what you already know helps their sorting from day one (they can edit it):</p>
          <label className="field"><span className="muted small">Family</span>
            <input value={family} onChange={e => setFamily(e.target.value)} placeholder="Married to Jason; sons Clay (11) and Mayer (9)" /></label>
          <label className="field"><span className="muted small">Kids & school</span>
            <input value={kids} onChange={e => setKids(e.target.value)} placeholder="School, schedule, activities" /></label>
          <label className="field"><span className="muted small">Church & volunteering</span>
            <input value={church} onChange={e => setChurch(e.target.value)} placeholder="Sunday school, prayer team…" /></label>
          {error && <p className="error">{error}</p>}
          {link ? (
            <div className="stack">
              <p className="notice small">
                {sent || `Send ${name} this link (works once, for 7 days).`} They’ll create a login and set up 2-step sign-in.
                {sent && ' The link is below too, in case it lands in spam.'}
              </p>
              <input readOnly value={link} onFocus={e => e.target.select()} />
              <div className="row-buttons">
                <button className="primary" onClick={() => navigator.clipboard?.writeText(link)}>Copy link</button>
                {'share' in navigator && <button onClick={() => navigator.share({ title: 'Join rlyfe', url: link }).catch(() => {})}>Share…</button>}
                <button className="link" onClick={() => { setOpen(false); setLink(''); setName(''); setFamily(''); setKids(''); setChurch(''); setEmail(''); setSent(''); }}>Done</button>
              </div>
            </div>
          ) : (
            <div className="row-buttons">
              <button className="primary" disabled={busy || !name.trim()} onClick={create}>
                {busy ? 'Working…' : email.trim() ? 'Create & email invite' : 'Create invite link'}
              </button>
              <button className="link" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
