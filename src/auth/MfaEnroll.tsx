import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import Logo from '../app/Logo';

// First sign-in: set up an authenticator app (Google Authenticator, 1Password, etc.)
export default function MfaEnroll({ onDone }: { onDone: () => void }) {
  const [factorId, setFactorId] = useState('');
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const started = useRef(false); // React dev mode mounts twice; enroll only once

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      // Clear half-finished setups from earlier attempts, or enroll() refuses
      const { data: list } = await supabase.auth.mfa.listFactors();
      for (const f of list?.all ?? []) {
        if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator' });
      if (error) return setError(error.message);
      setFactorId(data.id);
      setQr(data.totp.qr_code);
      setSecret(data.totp.secret);
    })();
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
        <div className="card-logo small"><Logo height={30} /></div>
        <h1>Set up 2-step sign-in</h1>
        <p className="muted">Scan this with your authenticator app, then type the 6-digit code it shows.</p>
        {qr ? <img className="qr" src={qr} alt="Authenticator QR code" /> : <div className="qr muted center">…</div>}
        {secret && <p className="muted small">Can't scan? Enter this key: <code>{secret}</code></p>}
        <label>
          Code
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                 value={code} onChange={e => setCode(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={!factorId}>Turn on 2-step sign-in</button>
        <button type="button" className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </form>
    </main>
  );
}
