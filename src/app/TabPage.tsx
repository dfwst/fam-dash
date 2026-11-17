import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tab } from './Shell';
import { Link } from 'react-router-dom';
import { accountLabel, loadAccounts, type Account } from '../lib/accounts';
import { ago, loadTabThreads, splitTodos, toLines, type TodoThread, threadPath } from '../lib/todos';
import * as act from '../lib/actions';
import TodoRow, { type RowAction } from './todo/TodoRow';
import TaskList from './todo/TaskList';
import * as tasksApi from '../lib/tasks';
import { useOnRefresh } from '../lib/refresh';

// One tab's calm view:
//   - To-do: Real mail someone is waiting on you for. Top 5 lines, the rest behind "N more".
//   - Worth a glance: one line each, last 7 days.
//   - Waiting on others / Snoozed: collapsed.
// Done / Ignore archive the email in Gmail (+ mark read); Remind me hides it in rlyfe only.
// Every action shows an Undo.
const TOP = 5;

type Toast = {
  text: string;
  logIds: number[];
  kind: string;
  at: number;
  offer?: { sender: string; name: string };
  error?: boolean;
  undoFn?: () => Promise<unknown>; // To-Do items undo in the database, not Gmail
};

const key = (t: Pick<TodoThread, 'account_id' | 'thread_id'>) => t.account_id + t.thread_id;

export default function TabPage({ tab }: { tab: Tab }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [inbox, setInbox] = useState<TodoThread[] | null>(null);
  const [glance, setGlance] = useState<TodoThread[]>([]);
  const [tasks, setTasks] = useState<tasksApi.Task[]>([]);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showGlance, setShowGlance] = useState(false);
  const [showWaiting, setShowWaiting] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      // Every mailbox you can use (rule-routed mail can come from any of them); this tab's are a subset
      const [accts, taskList] = await Promise.all([loadAccounts(), tasksApi.loadTasks(tab.id)]);
      setAccounts(accts);
      setTasks(taskList);
      const r = await loadTabThreads(accts.filter(a => a.default_tab_id === tab.id).map(a => a.id), tab.id);
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

  useOnRefresh(load); // pull down → fresh list, without the "Loading…" flash

  const show = (t: Toast) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), t.offer ? 12000 : 7000);
  };

  // Remove from the list right away; put it back if Gmail says no
  const optimistic = (t: TodoThread, change: Partial<TodoThread> | 'remove') =>
    setInbox(list => (list ?? []).flatMap(x =>
      key(x) !== key(t) ? [x] : change === 'remove' ? [] : [{ ...x, ...change }]));

  async function onAction(a: RowAction) {
    const t = a.thread;
    const who = t.from_name || t.from_email || 'that';
    try {
      if (a.kind === 'todo') {
        const acct = accounts?.find(x => x.id === t.account_id);
        const task = await tasksApi.addTask({
          title: a.todo.title, due_on: a.todo.due_on, tab_id: t.tab_id ?? acct?.default_tab_id ?? tab.id,
          account_id: t.account_id, thread_id: t.thread_id,
        });
        if (task.tab_id === tab.id) setTasks(list => [...list, task]);
        if (!a.todo.alsoDone) {
          show({ text: 'Added to To-Do', logIds: [], kind: 'todo', at: Date.now() });
          return;
        }
        optimistic(t, 'remove');
        const r = await act.done(t);
        show({ text: 'Added to To-Do · email archived', logIds: [r.logId], kind: 'todo', at: Date.now() });
        return;
      }
      if (a.kind === 'snooze') {
        optimistic(t, { snoozed_until: a.until.toISOString() });
        const r = await act.snooze(t, a.until);
        show({ text: `Hidden until ${act.whenLabel(a.until.toISOString())}`, logIds: [r.logId], kind: 'snooze', at: Date.now() });
        return;
      }
      optimistic(t, 'remove');
      if (a.kind === 'done') {
        const r = await act.done(t);
        // "Done all" on a group fires several in a row — fold them into one toast
        setToast(prev => {
          const merge = prev && prev.kind === 'done' && Date.now() - prev.at < 2500;
          const logIds = merge ? [...prev.logIds, r.logId] : [r.logId];
          const next = { text: logIds.length > 1 ? `Done · ${logIds.length} archived` : 'Done · archived', logIds, kind: 'done', at: Date.now() };
          window.clearTimeout(toastTimer.current);
          toastTimer.current = window.setTimeout(() => setToast(null), 7000);
          return next;
        });
      } else {
        const r = await act.ignore(t);
        show({
          text: r.offerAlwaysIgnore ? `Ignored. Always ignore emails from ${r.senderName || who}?` : 'Ignored · archived',
          logIds: [r.logId], kind: 'ignore', at: Date.now(),
          offer: r.offerAlwaysIgnore && r.sender ? { sender: r.sender, name: r.senderName || r.sender } : undefined,
        });
      }
    } catch (e) {
      load(); // put the real state back
      const msg = e instanceof Error ? e.message : 'failed';
      show({
        text: msg === 'needs-reconnect' ? 'Google sign-in expired for that account — reconnect it in Settings.' : `Couldn't do that (${msg}).`,
        logIds: [], kind: 'error', at: Date.now(), error: true,
      });
    }
  }

  async function undoToast() {
    if (!toast) return;
    const ids = toast.logIds;
    const fn = toast.undoFn;
    setToast(null);
    try {
      if (fn) await fn();
      for (const id of ids) await act.undo(id);
    } catch {
      show({ text: "Couldn't undo — check Gmail.", logIds: [], kind: 'error', at: Date.now(), error: true });
    }
    load();
  }

  async function confirmAlwaysIgnore() {
    if (!toast?.offer) return;
    const { sender, name } = toast.offer;
    setToast(null);
    try {
      const r = await act.alwaysIgnore(sender);
      show({
        text: `Your mailbox will skip the inbox for ${name} from now on`
          + (r.archived ? ` · ${r.archived} more archived` : '') + '. Undo it from Review → Activity.',
        logIds: [], kind: 'filter', at: Date.now(),
      });
      load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      show({
        text: msg === 'priority-sender'
          ? `${name} has sent priority mail before, so rlyfe won't auto-ignore it.`
          : `Couldn't create the filter (${msg}).`,
        logIds: [], kind: 'error', at: Date.now(), error: true,
      });
    }
  }

  // ── To-Do items ──
  async function addTask(title: string) {
    try {
      const task = await tasksApi.addTask({ title, tab_id: tab.id });
      setTasks(list => [...list, task]);
    } catch (e) {
      show({ text: `Couldn't add that (${e instanceof Error ? e.message : 'failed'}).`, logIds: [], kind: 'error', at: Date.now(), error: true });
      throw e;
    }
  }
  async function taskDone(task: tasksApi.Task) {
    setTasks(list => list.filter(x => x.id !== task.id));
    try {
      await tasksApi.setDone(task.id, true);
      show({ text: `Done: ${task.title}`, logIds: [], kind: 'task', at: Date.now(), undoFn: () => tasksApi.setDone(task.id, false) });
    } catch { load(); }
  }
  async function taskEdit(task: tasksApi.Task, change: Partial<Pick<tasksApi.Task, 'title' | 'due_on'>>) {
    setTasks(list => list.map(x => (x.id === task.id ? { ...x, ...change } : x)));
    await tasksApi.updateTask(task.id, change).catch(() => load());
  }
  async function taskDelete(task: tasksApi.Task) {
    if (!confirm(`Delete "${task.title}"?`)) return;
    setTasks(list => list.filter(x => x.id !== task.id));
    await tasksApi.deleteTask(task.id).catch(() => load());
  }

  async function wake(t: TodoThread) {
    optimistic(t, { snoozed_until: null });
    await act.unsnooze(t).catch(() => load());
  }

  const byId = useMemo(() => new Map((accounts ?? []).map(a => [a.id, a])), [accounts]);
  const tabAccounts = useMemo(() => (accounts ?? []).filter(a => a.default_tab_id === tab.id), [accounts, tab.id]);
  const showAccount = tabAccounts.length > 1 || (inbox ?? []).some(t => t.tab_id === tab.id);
  const { todo, waiting, snoozed } = useMemo(() => splitTodos(inbox ?? []), [inbox]);
  const lines = useMemo(() => toLines(todo), [todo]);

  if (error) return <p className="error">{error}</p>;
  if (!accounts || !inbox) return <p className="muted">Loading…</p>;

  if (tabAccounts.length === 0 && inbox.length === 0 && glance.length === 0) {
    return (
      <div className="stack-lg">
        <TaskList tasks={tasks} onAdd={addTask} onDone={taskDone} onEdit={taskEdit} onDelete={taskDelete} />
        <p className="muted small">No mail on this tab yet. (Add an account here in Settings, or a rule that sends mail here.)</p>
      </div>
    );
  }

  const visible = showAll ? lines : lines.slice(0, TOP);
  const hidden = lines.length - visible.length;
  const glanceShown = showGlance ? glance : glance.slice(0, 3);

  return (
    <div className="stack-lg">
      <TaskList tasks={tasks} onAdd={addTask} onDone={taskDone} onEdit={taskEdit} onDelete={taskDelete} />

      {lines.length === 0 ? (
        <section className="caught-up" aria-label={tab.name}>
          <div className="check" aria-hidden>✓</div>
          <h2>All caught up.</h2>
        </section>
      ) : (
        <section className="stack">
          <ul className="todo-list">
            {visible.map(l => (
              <TodoRow key={l.key} line={l} accounts={byId} showAccount={showAccount} onAction={onAction} />
            ))}
          </ul>
          {hidden > 0 && <button className="more" onClick={() => setShowAll(true)}>{hidden} more</button>}
          {showAll && lines.length > TOP && <button className="more" onClick={() => setShowAll(false)}>Show less</button>}
        </section>
      )}

      {glance.length > 0 && (
        <section className="stack">
          <h3 className="section-title">Worth a glance</h3>
          <ul className="glance">
            {glanceShown.map(t => {
              return (
                <li key={key(t)}>
                  <Link to={threadPath(t.account_id, t.thread_id)}>
                    <span className="glance-from">{t.from_name || t.from_email}</span>
                    <span className="glance-text">{t.summary || t.subject}</span>
                    <span className="todo-meta">{ago(t.last_message_at)}</span>
                  </Link>
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
                  <li key={key(t)}>
                    <Link to={threadPath(t.account_id, t.thread_id)}>
                      <span className="glance-from">{t.subject}</span>
                      <span className="glance-text">{t.summary}</span>
                      <span className="todo-meta">{showAccount && acct ? `${accountLabel(acct)} · ` : ''}{ago(t.last_message_at)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {snoozed.length > 0 && (
        <section className="stack">
          <button className="section-toggle" onClick={() => setShowSnoozed(s => !s)} aria-expanded={showSnoozed}>
            Snoozed · {snoozed.length} {showSnoozed ? '▴' : '▾'}
          </button>
          {showSnoozed && (
            <ul className="glance">
              {snoozed.map(t => (
                <li key={key(t)} className="snoozed-row">
                  <span className="glance-from">{t.from_name || t.from_email}</span>
                  <span className="glance-text">{t.subject}</span>
                  <span className="todo-meta">{act.whenLabel(t.snoozed_until!)}</span>
                  <button className="link" onClick={() => wake(t)}>Now</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {toast && (
        <div className={toast.error ? 'toast error' : 'toast'} role="status">
          <span>{toast.text}</span>
          {toast.offer && <button onClick={confirmAlwaysIgnore}>Always ignore</button>}
          {(toast.logIds.length > 0 || toast.undoFn) && <button onClick={undoToast}>Undo</button>}
          <button className="x" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </div>
  );
}
