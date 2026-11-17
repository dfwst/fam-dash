import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

// "Help rlyfe sort": a few plain questions. The answers go into Claude's instructions for YOUR
// mail only (sorting, reply drafts, the retire scan). Shown once on first sign-in (/welcome),
// and any time from Settings → About you.
type Profile = Record<string, string>;
type Me = { display_name: string | null; profile: Profile; onboarded_at: string | null };

const QUESTIONS: { key: string; label: string; hint: string }[] = [
  { key: 'family', label: 'Family', hint: 'Who’s in your household? e.g. “Married to Jason; sons Clay (11) and Mayer (9)”' },
  { key: 'kids', label: 'Kids & school', hint: 'Schools, teams, activities, schedules — e.g. “The Oaks Tutorials, on campus Mon & Thu”' },
  { key: 'church', label: 'Church & volunteering', hint: 'e.g. “Teach Sunday school, prayer team”' },
  { key: 'work', label: 'Work', hint: 'Your job or business, clients, side work — or leave blank' },
  { key: 'important', label: 'Always important', hint: 'Senders or topics that should never be missed — e.g. “the boys’ teachers, doctor’s office, our bank”' },
  { key: 'noise', label: 'Usually noise', hint: 'Things you never want to see — e.g. “store promos, Nextdoor, political email”' },
];

export default function AboutYou({ me, first = false, onSaved }: {
  me: Me; first?: boolean; onSaved?: (m: Partial<Me>) => void;
}) {
  const nav = useNavigate();
  const [name, setName] = useState(me.display_name ?? '');
  const [profile, setProfile] = useState<Profile>(me.profile ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true); setError('');
    const { data: { user } } = await supabase.auth.getUser();
    const clean = Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, v.trim().slice(0, 600)]).filter(([, v]) => v));
    // display_name is required — a blank box keeps the name you had
    const change = { display_name: name.trim().slice(0, 40) || me.display_name || 'Me', profile: clean, onboarded_at: me.onboarded_at ?? new Date().toISOString() };
    const { error } = await supabase.from('household_members').update(change).eq('user_id', user?.id ?? '');
    setBusy(false);
    if (error) return setError(error.message);
    onSaved?.(change);
    setSaved(true);
    if (first) nav('/settings?welcome=1');
  }

  return (
    <section className="stack about-you">
      {first ? (
        <>
          <h2>Welcome to rlyfe{name ? `, ${name}` : ''}</h2>
          <p className="muted">A few quick questions so rlyfe knows what matters to you. Answer what you like — you can change these any time in Settings.</p>
        </>
      ) : (
        <>
          <h2>About you</h2>
          <p className="muted small">Used only to sort <strong>your</strong> mail and write your reply drafts. Nobody else in your household sees your email.</p>
        </>
      )}

      <label className="field">
        <span className="muted small">What should rlyfe call you?</span>
        <input value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="First name" />
      </label>

      {QUESTIONS.map(q => (
        <label key={q.key} className="field">
          <span className="small"><strong>{q.label}</strong></span>
          <textarea rows={2} maxLength={600} value={profile[q.key] ?? ''} placeholder={q.hint}
                    onChange={e => setProfile(p => ({ ...p, [q.key]: e.target.value }))} />
        </label>
      ))}

      {error && <p className="error">{error}</p>}
      <div className="row-buttons">
        <button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : first ? 'Save and connect my email' : 'Save'}</button>
        {saved && !first && <span className="muted small">Saved ✓ — new mail is sorted with this from now on.</span>}
      </div>
    </section>
  );
}
