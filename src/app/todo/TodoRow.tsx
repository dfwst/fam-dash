import { useState } from 'react';
import { accountLabel, gmailLink, type Account } from '../../lib/accounts';
import { ago, isUrgent, type Line, type TodoThread } from '../../lib/todos';

const senderName = (t: TodoThread) => t.from_name || t.from_email || 'Unknown sender';

function ThreadRow({ t, acct, showAccount }: { t: TodoThread; acct?: Account; showAccount: boolean }) {
  return (
    <a className="todo" href={acct ? gmailLink(acct.email, t.thread_id) : undefined} target="_blank" rel="noreferrer">
      <div className="todo-top">
        {isUrgent(t) ? <span className="badge urgent">{t.category === 'security' ? 'Security' : 'Payment'}</span>
          : t.priority ? <span className="badge soft">Priority</span> : null}
        <span className={t.unread ? 'todo-from' : 'todo-from read'}>{senderName(t)}</span>
        <span className="todo-meta">
          {showAccount && acct ? `${accountLabel(acct)} · ` : ''}{ago(t.last_message_at)}
        </span>
      </div>
      <div className="todo-subject">{t.subject}</div>
      <div className="todo-summary">{t.summary || t.snippet}</div>
    </a>
  );
}

export default function TodoRow({ line, accounts, showAccount }: {
  line: Line; accounts: Map<string, Account>; showAccount: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (line.kind === 'one') {
    return <li><ThreadRow t={line.thread} acct={accounts.get(line.thread.account_id)} showAccount={showAccount} /></li>;
  }

  const newest = line.threads[0];
  return (
    <li>
      <button className="todo group" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <div className="todo-top">
          <span className="todo-from">{line.label}</span>
          <span className="todo-meta">{ago(newest.last_message_at)} {open ? '▴' : '▾'}</span>
        </div>
        {!open && <div className="todo-summary">Latest: {newest.summary || newest.subject}</div>}
      </button>
      {open && (
        <ul className="sublist">
          {line.threads.map(t => (
            <li key={t.account_id + t.thread_id}>
              <ThreadRow t={t} acct={accounts.get(t.account_id)} showAccount={showAccount} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
