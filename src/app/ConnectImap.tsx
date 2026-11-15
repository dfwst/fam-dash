import { useState } from 'react';
import { callFn } from '../lib/functions';

// Connect Yahoo / AOL / iCloud / other with an APP PASSWORD — a separate password the
// service generates just for rlyfe. Your real password is never typed here, and the app
// password can be revoked on its own at the service any time.
type Service = 'yahoo' | 'aol' | 'icloud' | 'other';

const HELP: Record<Service, { name: string; link?: string; steps: string }> = {
  yahoo: {
    name: 'Yahoo',
    link: 'https://login.yahoo.com/myaccount/security/app-password',
    steps: 'Yahoo → Account security → Generate app password → name it “rlyfe” → copy the 16 letters.',
  },
  aol: {
    name: 'AOL',
    link: 'https://login.aol.com/myaccount/security/app-password',
    steps: 'AOL → Account security → Generate app password → name it “rlyfe” → copy it.',
  },
  icloud: {
    name: 'iCloud',
    link: 'https://account.apple.com/account/manage',
    steps: 'Apple Account → Sign-In and Security → App-Specific Passwords → + → name it “rlyfe” → copy it.',
  },
  other: { name: 'Other', steps: 'Use an app password if your provider offers one. Server names are in its help pages.' },
};

const ERRORS: Record<string, string> = {
  'imap-auth': "The service said no to that address + password. Use an APP password (not your normal one) and check the address.",
  'imap-unreachable': "Couldn't reach the mail server. Check the server names, or try again in a minute.",
  'bad-input': 'Check the email address and password.',
  'bad-server': 'Server names must be real host names (like imap.example.com); ports 993 for IMAP and 465 or 587 for SMTP.',
  'connect-failed': "Couldn't save the account. Try again.",
};

export default function ConnectImap({ initialEmail, onDone, onCancel }: {
  initialEmail?: string; onDone: (email: string) => void; onCancel: () => void;
}) {
  const [service, setService] = useState<Service>(initialEmail?.endsWith('@icloud.com') || initialEmail?.endsWith('@me.com') ? 'icloud'
    : initialEmail?.endsWith('@aol.com') ? 'aol' : 'yahoo');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(465);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const help = HELP[service];

  async function submit() {
    setBusy(true); setError('');
    try {
      const r = await callFn<{ connected: string }>('imap-connect', {
        service, email, password,
        ...(service === 'other' ? { imapHost, imapPort: 993, smtpHost, smtpPort } : {}),
      });
      setPassword('');
      onDone(r.connected);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'failed';
      setError(ERRORS[m] ?? `Couldn't connect (${m}).`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-todo connect-imap" onSubmit={e => { e.preventDefault(); submit(); }}>
      <div className="chips" role="group" aria-label="Mail service">
        {(Object.keys(HELP) as Service[]).map(s => (
          <button type="button" key={s} className={service === s ? 'chip active' : 'chip'} onClick={() => setService(s)}>
            {HELP[s].name}
          </button>
        ))}
      </div>

      <p className="muted small">
        <strong>1. Get an app password.</strong> {help.steps}{' '}
        {help.link && <a href={help.link} target="_blank" rel="noreferrer">Open {help.name} ↗</a>}
      </p>

      <label className="field">
        <span className="muted small">Email address</span>
        <input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)}
               placeholder={service === 'icloud' ? 'you@icloud.com' : service === 'aol' ? 'you@aol.com' : 'you@yahoo.com'} />
      </label>
      <label className="field">
        <span className="muted small">2. App password</span>
        <input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}
               placeholder="xxxx xxxx xxxx xxxx" />
      </label>

      {service === 'other' && (
        <>
          <label className="field">
            <span className="muted small">Incoming (IMAP) server · port 993</span>
            <input value={imapHost} onChange={e => setImapHost(e.target.value)} placeholder="imap.example.com" />
          </label>
          <label className="field">
            <span className="muted small">Outgoing (SMTP) server</span>
            <input value={smtpHost} onChange={e => setSmtpHost(e.target.value)} placeholder="smtp.example.com" />
          </label>
          <label className="check-line">
            <span className="muted small">SMTP port</span>
            <select value={smtpPort} onChange={e => setSmtpPort(Number(e.target.value))}>
              <option value={465}>465 (SSL)</option>
              <option value={587}>587 (STARTTLS)</option>
            </select>
          </label>
        </>
      )}

      {error && <p className="error">{error}</p>}
      <p className="muted small">rlyfe tests the sign-in before saving. The app password is stored encrypted and never shown again.</p>
      <div className="row-buttons">
        <button type="submit" className="primary" disabled={busy || !email || !password}>
          {busy ? 'Checking sign-in…' : `Connect ${help.name}`}
        </button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
