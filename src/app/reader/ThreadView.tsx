import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { callFn } from '../../lib/functions';
import { supabase } from '../../lib/supabase';
import * as act from '../../lib/actions';
import { gmailUrl, opensInNewTab } from '../../lib/gmailOpen';
import EmailBody from './EmailBody';
import ReplyBox from './ReplyBox';
import AddTodo from '../todo/AddTodo';
import { addTask } from '../../lib/tasks';
import { UNSUB_ERRORS, unsubLabel, unsubscribeThread } from '../../lib/unsubscribe';

// Read a conversation inside rlyfe. Nothing is marked read in Gmail by looking at it.
// Done / Ignore / Remind me work here just like on the to-do list; Reply (M5) sends from here.

type Msg = {
  id: string; from: { name: string; email: string }; to: string; cc: string; subject: string;
  date: string; unread: boolean; sentByYou: boolean; html: string | null; text: string | null;
  attachments: { name: string; size: number }[];
};
type ThreadData = {
  threadId: string; account: string; provider: 'google' | 'microsoft' | 'imap'; webLink: string | null;
  unsubscribe: 'one-click' | 'email' | 'link' | null;
  subject: string; messages: Msg[];
};

const when = (iso: string) => new Date(iso).toLocaleString([], {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

export default function ThreadView() {
  const { accountId = '', threadId = '' } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<ThreadData | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [remind, setRemind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');
  const [version, setVersion] = useState(0); // bump to re-read the thread after a reply

  useEffect(() => {
    supabase.from('connected_accounts').select('default_tab_id').eq('id', accountId).maybeSingle()
      .then(({ data }) => setTabId(data?.default_tab_id ?? null));
  }, [accountId]);

  useEffect(() => {
    callFn<ThreadData>('thread-read', { accountId, threadId })
      .then(d => {
        setData(d);
        // Expand the latest message (and any unread ones); older ones start collapsed
        const last = d.messages[d.messages.length - 1];
        setOpen(new Set([...(last ? [last.id] : []), ...d.messages.filter(m => m.unread).map(m => m.id)]));
      })
      .catch(e => setError(e instanceof Error ? e.message : 'failed'));
    supabase.from('email_threads').select('summary').eq('account_id', accountId).eq('thread_id', threadId)
      .maybeSingle().then(({ data }) => setSummary(data?.summary ?? null));
  }, [accountId, threadId, version]);

  const ref = { account_id: accountId, thread_id: threadId };

  const [unsub, setUnsub] = useState<{ busy?: boolean; msg?: string; url?: string } | null>(null);

  // Unsubscribe from this sender's list, then archive this email (Done, with Undo in Activity)
  async function unsubscribe() {
    const from = data?.messages[data.messages.length - 1]?.from;
    if (!confirm(`Unsubscribe from ${from?.name || from?.email || 'this sender'}?\n\n`
      + 'rlyfe uses the sender’s official unsubscribe, then archives this email.')) return;
    setUnsub({ busy: true });
    try {
      const r = await unsubscribeThread(accountId, threadId);
      setUnsub({ msg: unsubLabel(r), url: r.url });
      if (r.ok) await run(() => act.done(ref));
    } catch (e) {
      const m = e instanceof Error ? e.message : 'failed';
      setUnsub({ msg: UNSUB_ERRORS[m] ?? `Couldn’t unsubscribe (${m}).` });
    }
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); nav(-1); }
    catch (e) { setError(e instanceof Error ? e.message : 'failed'); setBusy(false); }
  }

  if (error) {
    return (
      <section className="stack">
        <button className="link back" onClick={() => nav(-1)}>← Back</button>
        <p className="error">
          {error === 'needs-reconnect' ? 'Google sign-in expired for this account — reconnect it in Settings.' : `Couldn't load this email (${error}).`}
        </p>
      </section>
    );
  }
  if (!data) return <p className="muted">Loading email…</p>;

  const outlook = data.provider === 'microsoft';
  const href = data.provider === 'imap' ? null : outlook ? data.webLink : gmailUrl(data.account, data.threadId, undefined, data.subject);

  return (
    <section className="reader">
      <div className="reader-head">
        <button className="link back" onClick={() => nav(-1)}>← Back</button>
        <span className="reader-head-right">
          {data.unsubscribe && !unsub?.msg && (
            <button className="link" disabled={unsub?.busy} onClick={unsubscribe}>{unsub?.busy ? 'Unsubscribing…' : 'Unsubscribe'}</button>
          )}
          {href && <a className="link" href={href} {...(outlook || opensInNewTab() ? { target: '_blank', rel: 'noreferrer' } : {})}>Open in {outlook ? 'Outlook' : 'Gmail'} ↗</a>}
        </span>
      </div>
      {unsub?.msg && (
        <p className="notice">
          {unsub.msg}{unsub.url && <> — <a href={unsub.url} target="_blank" rel="noreferrer">open their unsubscribe page ↗</a></>}
        </p>
      )}
      <h2 className="reader-subject">{data.subject}</h2>
      <p className="muted small">{data.account} · {data.messages.length} message{data.messages.length > 1 ? 's' : ''}</p>
      {summary && <p className="reader-summary">{summary}</p>}

      <ol className="msgs">
        {data.messages.map(m => {
          const isOpen = open.has(m.id);
          return (
            <li key={m.id} className={isOpen ? 'msg open' : 'msg'}>
              <button className="msg-head" onClick={() => setOpen(s => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}>
                <span className="msg-from">{m.sentByYou ? 'You' : (m.from.name || m.from.email)}</span>
                <span className="muted small push">{when(m.date)}</span>
              </button>
              {isOpen ? (
                <div className="msg-body">
                  <div className="muted small msg-to">
                    {m.from.email}{m.to ? ` → ${m.to}` : ''}{m.cc ? ` · cc ${m.cc}` : ''}
                  </div>
                  <EmailBody html={m.html} text={m.text} />
                  {m.attachments.length > 0 && (
                    <ul className="attach">
                      {m.attachments.map(a => <li key={a.name}>📎 {a.name} <span className="muted">({kb(a.size)})</span></li>)}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="muted small msg-peek ellipsis">{(m.text ?? '').slice(0, 140) || 'Tap to read'}</div>
              )}
            </li>
          );
        })}
      </ol>

      {note && <p className="notice" onClick={() => setNote('')}>{note}</p>}

      {replying ? (
        <ReplyBox accountId={accountId} threadId={threadId} onClose={() => setReplying(false)}
                  onSent={r => {
                    if (r.done) window.setTimeout(() => nav(-1), 1500);
                    else window.setTimeout(() => { setReplying(false); setVersion(v => v + 1); }, 1500);
                  }} />
      ) : (
        <div className="reader-actions">
          <button className="primary" disabled={busy} onClick={() => { setReplying(true); setAdding(false); setRemind(false); }}>Reply</button>
          <button disabled={busy} onClick={() => run(() => act.done(ref))}>Done</button>
          <button disabled={busy} onClick={() => run(() => act.ignore(ref))}>Ignore</button>
          <button disabled={busy} onClick={() => { setAdding(a => !a); setRemind(false); }}>+ To-Do</button>
          <button disabled={busy} onClick={() => { setRemind(r => !r); setAdding(false); }}>Remind me</button>
        </div>
      )}
      {adding && (
        <div className="reader-remind"><AddTodo initialTitle={data.subject} onClose={() => setAdding(false)}
                 onSave={async todo => {
                   setAdding(false);
                   try {
                     await addTask({ title: todo.title, due_on: todo.due_on, tab_id: tabId, account_id: accountId, thread_id: threadId });
                     if (todo.alsoDone) await run(() => act.done(ref));
                     else setNote('Added to To-Do.');
                   } catch (e) { setError(e instanceof Error ? e.message : 'failed'); }
                 }} /></div>
      )}
      {remind && (
        <div className="remind reader-remind">
          {act.remindPresets().map(p => (
            <button key={p.label} onClick={() => run(() => act.snooze(ref, p.when))}>{p.label}</button>
          ))}
          <button className="link" onClick={() => setRemind(false)}>Cancel</button>
        </div>
      )}
    </section>
  );
}
