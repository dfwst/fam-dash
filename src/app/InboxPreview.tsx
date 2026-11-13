import { useEffect, useState } from 'react';
import { callFn } from '../lib/functions';
import { gmailLink, type Account } from '../lib/accounts';

// Milestone 1: live, read-only peek at an account's inbox. Replaced by the to-do list in M3.
type Thread = {
  id: string; from: string; subject: string; snippet: string;
  date: string; messages: number; unread: boolean;
};

const senderName = (from: string) => from.replace(/<.*>/, '').replace(/"/g, '').trim() || from;

function when(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function InboxPreview({ account }: { account: Account }) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    callFn<{ threads: Thread[] }>('gmail-inbox', { accountId: account.id })
      .then(r => setThreads(r.threads))
      .catch(e => setError(e.message));
  }, [account.id]);

  return (
    <section className="stack">
      <div className="section-head">
        <h3>{account.email}</h3>
        <span className="muted small">{threads ? `${threads.length} in inbox (newest 25)` : ''}</span>
      </div>

      {error === 'needs-reconnect' ? (
        <p className="error">Google sign-in for this account expired. Reconnect it in Settings.</p>
      ) : error ? (
        <p className="error">Couldn't load this inbox ({error}).</p>
      ) : !threads ? (
        <p className="muted">Loading inbox…</p>
      ) : threads.length === 0 ? (
        <p className="muted">Inbox is empty.</p>
      ) : (
        <ul className="list">
          {threads.map(t => (
            <li key={t.id}>
              <a className="row thread" href={gmailLink(account.email, t.id)} target="_blank" rel="noreferrer">
                <div className="row-main">
                  <div className="row-top">
                    <span className={t.unread ? 'row-title' : 'row-title read'}>{senderName(t.from)}</span>
                    {t.messages > 1 && <span className="muted small">{t.messages}</span>}
                    <span className="muted small push">{when(t.date)}</span>
                  </div>
                  <div className="ellipsis">{t.subject}</div>
                  <div className="muted small ellipsis">{t.snippet}</div>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
