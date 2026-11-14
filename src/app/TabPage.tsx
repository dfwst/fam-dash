import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Tab } from './Shell';
import { accountLabel, gmailLink, loadAccounts, type Account } from '../lib/accounts';
import { ago, loadTabThreads, splitTodos, toLines, type TodoThread } from '../lib/todos';
import TodoRow from './todo/TodoRow';

// One tab's calm view:
//   - To-do: Real mail someone is waiting on you for. Top 5 lines, the rest behind "N more".
//   - Worth a glance: one line each, last 7 days.
//   - Waiting on others: threads where you replied last (collapsed).
// Read-only in M3: tapping a line opens it in Gmail. Done / Ignore / Remind arrive in M4.
const TOP = 5;

export default function TabPage({ tab }: { tab: Tab }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [inbox, setInbox] = useState<TodoThread[] | null>(null);
  const [glance, setGlance] = useState<TodoThread[]>([]);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showGlance, setShowGlance] = useState(false);
  const [showWaiting, setShowWaiting] = useState(false);

  const load = useCallback(async () => {
    try {
      const accts = await loadAccounts(tab.id);
      setAccounts(accts);
      const r = await loadTabThreads(accts.map(a => a.id));
      setInbox(r.inbox);
      setGlance(r.glance);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    }
  }, [tab.id]);

  useEffect(() => {
    setShowAll(false);
    load();
    // Coming back to the app (phone unlock, tab switch) → fresh list
    const onFocus = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [load]);

  const byId = useMemo(() => new Map((accounts ?? []).map(a => [a.id, a])), [accounts]);
  const showAccount = (accounts?.length ?? 0) > 1;
  const { todo, waiting } = useMemo(() => splitTodos(inbox ?? []), [inbox]);
  const lines = useMemo(() => toLines(todo), [todo]);

  if (error) return <p className="error">{error}</p>;
  if (!accounts || !inbox) return <p className="muted">Loading…</p>;

  if (accounts.length === 0) {
    return (
      <section className="caught-up" aria-label={tab.name}>
        <div className="check" aria-hidden>✓</div>
        <h2>All caught up.</h2>
        <p className="muted small">No mail accounts on this tab yet.</p>
      </section>
    );
  }

  const visible = showAll ? lines : lines.slice(0, TOP);
  const hidden = lines.length - visible.length;
  const glanceShown = showGlance ? glance : glance.slice(0, 3);

  return (
    <div className="stack-lg">
      {lines.length === 0 ? (
        <section className="caught-up" aria-label={tab.name}>
          <div className="check" aria-hidden>✓</div>
          <h2>All caught up.</h2>
        </section>
      ) : (
        <section className="stack">
          <ul className="todo-list">
            {visible.map(l => <TodoRow key={l.key} line={l} accounts={byId} showAccount={showAccount} />)}
          </ul>
          {hidden > 0 && (
            <button className="more" onClick={() => setShowAll(true)}>{hidden} more</button>
          )}
          {showAll && lines.length > TOP && (
            <button className="more" onClick={() => setShowAll(false)}>Show less</button>
          )}
        </section>
      )}

      {glance.length > 0 && (
        <section className="stack">
          <h3 className="section-title">Worth a glance</h3>
          <ul className="glance">
            {glanceShown.map(t => {
              const acct = byId.get(t.account_id);
              return (
                <li key={t.account_id + t.thread_id}>
                  <a href={acct ? gmailLink(acct.email, t.thread_id) : undefined} target="_blank" rel="noreferrer">
                    <span className="glance-from">{t.from_name || t.from_email}</span>
                    <span className="glance-text">{t.summary || t.subject}</span>
                    <span className="todo-meta">{ago(t.last_message_at)}</span>
                  </a>
                </li>
              );
            })}
          </ul>
          {glance.length > 3 && (
            <button className="more" onClick={() => setShowGlance(s => !s)}>
              {showGlance ? 'Show less' : `${glance.length - 3} more`}
            </button>
          )}
        </section>
      )}

      {waiting.length > 0 && (
        <section className="stack">
          <button className="section-toggle" onClick={() => setShowWaiting(s => !s)} aria-expanded={showWaiting}>
            Waiting on others · {waiting.length} {showWaiting ? '▴' : '▾'}
          </button>
          {showWaiting && (
            <ul className="glance">
              {waiting.map(t => {
                const acct = byId.get(t.account_id);
                return (
                  <li key={t.account_id + t.thread_id}>
                    <a href={acct ? gmailLink(acct.email, t.thread_id) : undefined} target="_blank" rel="noreferrer">
                      <span className="glance-from">{t.subject}</span>
                      <span className="glance-text">{t.summary}</span>
                      <span className="todo-meta">{showAccount && acct ? `${accountLabel(acct)} · ` : ''}{ago(t.last_message_at)}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
