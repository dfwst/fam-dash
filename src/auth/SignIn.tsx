import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { getJoinToken } from '../lib/join';
import Logo from '../app/Logo';

// Sign in — or, when you arrived from an invite link, create your login first.
export default function SignIn() {
  const invited = !!getJoinToken();
  const [mode, setMode] = useState<'in' | 'create'>(invited ? 'create' : 'in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(''); setNote('');
    if (mode === 'create') {
      if (password.length < 10) return setError('Use at least 10 characters for your password.');
      if (password !== confirm) return setError('The two passwords don’t match.');
    }
    setBusy(true);
    if (mode === 'in') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    } else {
      const { data, error } = await supabase.auth.signUp({
        email, password, options: { emailRedirectTo: window.location.origin },
      });
      if (error) setError(error.message);
      // Email confirmation on: no session yet — they confirm, then sign in here
      else if (!data.session) {
        setNote(`Check ${email} for a confirmation link, then come back and sign in.`);
        setMode('in');
      }
    }
    setBusy(false);
    // On success AuthGate hears the auth change and moves to the 2FA step.
  }

  return (
    <main className="card-page">
      <form className="card" onSubmit={submit}>
        <h1 className="card-logo"><Logo height={52} /></h1>
        {invited && <p className="muted small">You’ve been invited to rlyfe. {mode === 'create' ? 'Create your login to join.' : 'Sign in to join.'}</p>}
        <label>
          Email
          <input type="email" autoComplete="username" value={email}
                 onChange={e => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete={mode === 'create' ? 'new-password' : 'current-password'} value={password}
                 onChange={e => setPassword(e.target.value)} required />
        </label>
        {mode === 'create' && (
          <label>
            Password again
            <input type="password" autoComplete="new-password" value={confirm}
                   onChange={e => setConfirm(e.target.value)} required />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        {note && <p className="notice">{note}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'One moment…' : mode === 'create' ? 'Create my login' : 'Sign in'}
        </button>
        {invited && (
          <button type="button" className="link" onClick={() => { setMode(m => (m === 'in' ? 'create' : 'in')); setError(''); }}>
            {mode === 'create' ? 'I already have a login' : 'Create a new login instead'}
          </button>
        )}
        {mode === 'create' && <p className="muted small">Next you’ll set up a 6-digit code app (2-step sign-in) to keep your mail safe.</p>}
      </form>
    </main>
  );
}
