import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as tasksApi from '../lib/tasks';
import { ago, isResurfaced, isUrgent, loadNeedsYou, threadPath, type TodoThread } from '../lib/todos';
import { useOnRefresh } from '../lib/refresh';
import type { Tab } from './Shell';

// The home screen: what needs you right now, from every tab, on one page.
//   1. Needs you — urgent mail (money, security, always-important) and reminders that are due
//   2. Due — to-dos that are overdue or due today
//   3. Waiting — which tabs have mail waiting on you, with a tap through
export default function Today({ tabs, waiting, name }: {
  tabs: Tab[]; waiting: Map<string, number>; name: string | null;
}) {
  const [needs, setNeeds] = useState<{ thread: TodoThread; tabId: string | null }[] | null>(null);
  const [tasks, setTasks] = useState<tasksApi.Task[]>([]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ text: string; undo?: () => Promise<unknown> } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [n, t] = await Promise.all([loadNeedsYou(), tasksApi.loadAllTasks()]);
      setNeeds(n);
      setTasks(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useOnRefresh(load);

  if (error) return <p className="error">{error}</p>;
  if (!needs) return <TodaySkeleton />;

  const tabName = (id: string | null) => tabs.find(t => t.id === id)?.name;
  const today = new Date().toLocaleDateString('en-CA'); // yyyy-mm-dd, local
  const due = tasks.filter(t => t.due_on && t.due_on <= today).sort((a, b) => a.due_on!.localeCompare(b.due_on!));
  const later = tasks.length - due.length;
  const withMail = tabs.filter(t => (waiting.get(t.id) ?? 0) > 0);
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const allClear = needs.length === 0 && due.length === 0 && withMail.length === 0;

  const done = (t: tasksApi.Task) => {
    setTasks(list => list.filter(x => x.id !== t.id));
    tasksApi.setDone(t.id, true).catch(() => load());
    setToast({ text: `Done: ${t.title}`, undo: async () => { await tasksApi.setDone(t.id, false); await load(); } });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 7000);
  };

  return (
    <div className="stack-lg today">
      <p className="today-hello">
        {hello}{name ? `, ${name}` : ''}.
        <span className="muted"> {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span>
      </p>

      {allClear && (
        <section className="caught-up">
          <div className="check" aria-hidden>✓</div>
          <h2>All clear.</h2>
          <p className="muted small">Nothing needs you right now.</p>
        </section>
      )}

      {needs.length > 0 && (
        <section className="stack">
          <h3 className="section-title">Needs you</h3>
          <ul className="today-list">
            {needs.map(({ thread: t, tabId }) => (
              <li key={t.account_id + t.thread_id}>
                <Link to={threadPath(t.account_id, t.thread_id)} className={isUrgent(t) ? 'today-row urgent' : 'today-row'}>
                  <span className="today-row-top">
                    {isUrgent(t) ? <span className="badge urgent">{t.category === 'security' ? 'Security' : 'Payment'}</span>
                      : isResurfaced(t) ? <span className="badge back">Reminder</span>
                      : <span className="badge soft">Priority</span>}
                    <span className="today-from">{t.from_name || t.from_email}</span>
                    <span className="todo-meta">{[tabName(tabId), ago(t.last_message_at)].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="today-text">{t.summary || t.subject}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {due.length > 0 && (
        <section className="stack">
          <h3 className="section-title">Due</h3>
          <ul className="today-list">
            {due.map(t => {
              const d = tasksApi.dueLabel(t.due_on);
              return (
                <li key={t.id} className="today-row task-row">
                  <input type="checkbox" aria-label={`Done: ${t.title}`} onChange={() => done(t)} />
                  <span className="today-task">{t.title}</span>
                  <span className="todo-meta">
                    {tabName(t.tab_id)}{d && <> · <span className={d.late ? 'task-due late' : 'task-due'}>{d.text}</span></>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {withMail.length > 0 && (
        <section className="stack">
          <h3 className="section-title">Mail waiting on you</h3>
          <ul className="today-list">
            {withMail.map(t => (
              <li key={t.id}>
                <Link to={`/${t.slug}`} className="today-row line">
                  <span className="today-from">{t.name}</span>
                  <span className="today-count">{waiting.get(t.id)}</span>
                  <span className="chev" aria-hidden>›</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {later > 0 && (
        <Link className="today-more muted small" to="/todos">{later} more to-do{later === 1 ? '' : 's'} with no rush ›</Link>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button onClick={() => { const u = toast.undo!; setToast(null); u(); }}>Undo</button>}
        </div>
      )}
    </div>
  );
}

// Grey placeholder rows while loading — the page keeps its shape instead of flashing "Loading…"
function TodaySkeleton() {
  return (
    <div className="stack-lg" aria-busy="true" aria-label="Loading">
      <div className="skel" style={{ width: '60%', height: 22 }} />
      <div className="skel" style={{ height: 68 }} />
      <div className="skel" style={{ height: 68 }} />
      <div className="skel" style={{ height: 48 }} />
    </div>
  );
}
