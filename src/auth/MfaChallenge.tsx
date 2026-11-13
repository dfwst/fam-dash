import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

// Every new sign-in: enter the current code from the authenticator app
export default function MfaChallenge({ onDone }: { onDone: () => void }) {
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (error) return setError(error.message);
      const totp = data.totp[0]; // verified authenticator factors only
      if (totp) setFactorId(totp.id);
    });
  }, []);

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError('');
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    if (error) return setError(error.message);
    onDone();
  }

  return (
    <main className="card-page">
      <form className="card" onSubmit={verify}>
        <h1>Enter your code</h1>
        <p className="muted">From your authenticator app.</p>
        <label>
          Code
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                 value={code} onChange={e => setCode(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={!factorId}>Continue</button>
        <button type="button" className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </form>
    </main>
  );
}
