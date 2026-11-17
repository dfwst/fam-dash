import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Account } from '../lib/accounts';

// "Help rlyfe sort this account": one quick question per account. The answer becomes the
// account note Claude reads before sorting (ai_context). Asked right after connecting.
const PURPOSES = [
  { key: 'personal', label: 'Everyday personal', note: 'Everyday personal email: family, friends, appointments, bills.' },
  { key: 'family', label: 'Family & school', note: 'Family and school logistics: kids’ school, activities, church, appointments. Never junk school, church, family or appointment mail.' },
  { key: 'work', label: 'Work', note: 'Work email: clients, coworkers, vendors, projects.' },
  { key: 'signups', label: 'Shopping & sign-ups', note: 'Used mostly for shopping and sign-ups: receipts and account notices matter, promotions are junk.' },
  { key: 'old', label: 'Old — moving away from it', note: 'An old address being retired: account notices, security alerts and real people matter; promotions and newsletters are junk.' },
];

export default function AccountPurpose({ account, onSaved }: { account: Account; onSaved: (ai_context: string) => void }) {
  const [pick, setPick] = useState<string | null>(null);
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function save() {
    const base = PURPOSES.find(p => p.key === pick)?.note ?? '';
    const text = [base, extra.trim()].filter(Boolean).join(' ').slice(0, 600);
    if (!text) return;
    setBusy(true);
    const { error } = await supabase.from('connected_accounts').update({ ai_context: text }).eq('id', account.id);
    setBusy(false);
    if (!error) { setDone(pick); onSaved(text); }
  }

  if (done) {
    return (
      <p className="notice small">
        Thanks — rlyfe will sort this account with that in mind. Next: <strong>Review → Sync now</strong> to bring its mail in.
        {done === 'old' && <> Moving away from it? <Link to={`/retire/${account.id}`}>Retire this address →</Link></>}
      </p>
    );
  }

  return (
    <div className="purpose">
      <p className="small"><strong>Help rlyfe sort this account:</strong> what is it mostly for?</p>
      <div className="chips" role="group">
        {PURPOSES.map(p => (
          <button type="button" key={p.key} className={pick === p.key ? 'chip active' : 'chip'} onClick={() => setPick(p.key)}>{p.label}</button>
        ))}
      </div>
      <input value={extra} maxLength={300} onChange={e => setExtra(e.target.value)}
             placeholder="Anything else? e.g. “the boys’ school emails come here”" />
      <button className="primary" disabled={busy || (!pick && !extra.trim())} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  );
}
