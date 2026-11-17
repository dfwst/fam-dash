import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as tasksApi from '../lib/tasks';
import { ago, isResurfaced, isUrgent, loadNeedsYou, threadPath, type Need } from '../lib/todos';
import * as act from '../lib/actions';
import { useSwipeAway } from '../lib/useSwipeAway';
import { useOnRefresh } from '../lib/refresh';
import type { Tab } from './Shell';

// The home screen: what needs you right now, from every tab, on one page.
//   1. Needs you — urgent mail (money, security, always-important) and reminders that are due
//   2. Due — to-dos that are overdue or due today
//   3. Waiting — which tabs have mail waiting on you, with a tap through
export default function Today({ tabs, waiting, name }: {
  tabs: Tab[]; waiting: Map<string, number>; name: string | null;
}) {
  const [needs, setNeeds] = useState<Need[] | null>(null);
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
  const open = tasks.filter(t => !t.done_at);
  const due = open.filter(t => t.due_on && t.due_on <= today).sort((a, b) => a.due_on!.localeCompare(b.due_on!));
  // What you ticked off today stays in view, crossed out — the day's wins
  const doneToday = tasks.filter(t => t.done_at && new Date(t.done_at).toLocaleDateString('en-CA') === today);
  const later = open.length - due.length;
  const withMail = tabs.filter(t => (waiting.get(t.id) ?? 0) > 0);
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const allClear = needs.length === 0 && due.length === 0 && doneToday.length === 0 && withMail.length === 0;

  const say = (text: string, undo?: () => Promise<unknown>) => {
    setToast({ text, undo });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 7000);
  };
  const setDone = (t: tasksApi.Task, isDone: boolean) => {
    setTasks(list => list.map(x => (x.id === t.id ? { ...x, done_at: isDone ? new Date().toISOString() : null } : x)));
    tasksApi.setDone(t.id, isDone).catch(() => load());
  };
  // Clear an email without opening it = Done (archived, with Undo)
  const clearMail = async (n: Need) => {
    setNeeds(list => list?.filter(x => x !== n) ?? null);
    try {
      const r = await act.done(n.thread);
      say('Done · archived', async () => { await act.undo(r.logId); await load(); });
    } catch { say('Couldn’t do that — try again'); load(); }
  };

  return (
    <div className="stack-lg today">
      <header className="today-hero">
        <h2 className="today-hello">{hello}{name ? `, ${name}` : ''}.</h2>
        <p className="today-sum">
          {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          {needs.length > 0 && <> · {needs.length} need{needs.length === 1 ? 's' : ''} you</>}
          {due.length > 0 && <> · {due.length} due</>}
          {doneToday.length > 0 && <> · <span className="today-won">{doneToday.length} done today</span></>}
        </p>
      </header>

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
            {needs.map(n => (
              <NeedRow key={n.thread.account_id + n.thread.thread_id} n={n} tab={tabName(n.tabId)} onClear={() => clearMail(n)} />
            ))}
          </ul>
        </section>
      )}

      {(due.length > 0 || doneToday.length > 0) && (
        <section className="stack">
          <h3 className="section-title">{due.length > 0 ? "Due" : "Done today"}</h3>
          <ul className="today-list">
            {due.map(t => {
              const d = tasksApi.dueLabel(t.due_on);
              return (
                <li key={t.id} className="today-row task-row">
                  <input type="checkbox" aria-label={`Done: ${t.title}`} onChange={() => setDone(t, true)} />
                  <span className="today-task">{t.title}</span>
                  <span className="todo-meta">
                    {tabName(t.tab_id)}{d && <> · <span className={d.late ? 'task-due late' : 'task-due'}>{d.text}</span></>}
                  </span>
                </li>
              );
            })}
            {doneToday.map(t => (
              <li key={t.id} className="today-row task-row done">
                <input type="checkbox" checked aria-label={`Not done: ${t.title}`} onChange={() => setDone(t, false)} />
                <span className="today-task">{t.title}</span>
                <span className="todo-meta">{tabName(t.tab_id)}</span>
              </li>
            ))}
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

// One "Needs you" email. Tap to read; swipe either way (phone) or ✕ to clear it without opening.
function NeedRow({ n, tab, onClear }: { n: Need; tab?: string; onClear: () => void }) {
  const t = n.thread;
  const s = useSwipeAway(onClear, n.canAct);
  return (
    <li className={`glance-row${s.leaving ? ' leaving' : ''}`}>
      {s.dx !== 0 && <div className="glance-hint" aria-hidden>✓ Clear</div>}
      <div className={isUrgent(t) ? 'need-slide urgent' : 'need-slide'} style={s.style} {...s.handlers}>
        <Link to={threadPath(t.account_id, t.thread_id)} className="today-row" draggable={false}
              onClick={e => { if (s.swiped) e.preventDefault(); }}>
          <span className="today-row-top">
            {isUrgent(t) ? <span className="badge urgent">{t.category === 'security' ? 'Security' : 'Payment'}</span>
              : isResurfaced(t) ? <span className="badge back">Reminder</span>
              : <span className="badge soft">Priority</span>}
            <span className="today-from">{t.from_name || t.from_email}</span>
            <span className="todo-meta">{[tab, ago(t.last_message_at)].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="today-text">{t.summary || t.subject}</span>
        </Link>
        {n.canAct && <button className="glance-x" aria-label={`Clear: ${t.subject ?? 'email'}`} title="Clear (archive)" onClick={s.dismiss}>✕</button>}
      </div>
    </li>
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
