import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as tasksApi from '../lib/tasks';
import { waitingByTab } from '../lib/todos';
import { useOnRefresh } from '../lib/refresh';
import TaskList from './todo/TaskList';
import type { Tab } from './Shell';

// Every To-Do in one place, one section per tab (Life, DFWST, Shared, Karen…).
// Each section works like the tab's own list — add, tick off, edit — and says how many
// emails are still waiting on you there.
export default function AllTodos({ tabs }: { tabs: Tab[] }) {
  const [tasks, setTasks] = useState<tasksApi.Task[] | null>(null);
  const [waiting, setWaiting] = useState<Map<string, number>>(new Map());
  const [opened, setOpened] = useState<Set<string>>(new Set()); // empty tabs you tapped to add to
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ text: string; undo?: () => Promise<unknown> } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [t, w] = await Promise.all([tasksApi.loadAllTasks(), waitingByTab()]);
      setTasks(t);
      setWaiting(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useOnRefresh(load);

  const show = (text: string, undo?: () => Promise<unknown>) => {
    setToast({ text, undo });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 7000);
  };

  const byTab = useMemo(() => {
    const m = new Map<string, tasksApi.Task[]>();
    for (const t of tasks ?? []) if (t.tab_id) m.set(t.tab_id, [...(m.get(t.tab_id) ?? []), t]);
    return m;
  }, [tasks]);

  const today = new Date().toLocaleDateString('en-CA'); // yyyy-mm-dd, local
  const overdue = (tasks ?? []).filter(t => t.due_on && t.due_on < today).length;
  const dueToday = (tasks ?? []).filter(t => t.due_on === today).length;

  if (error) return <p className="error">{error}</p>;
  if (!tasks) return <p className="muted">Loading…</p>;

  const busy = tabs.filter(t => byTab.has(t.id) || waiting.get(t.id) || opened.has(t.id));
  const quiet = tabs.filter(t => !busy.includes(t));

  // Same moves as a tab's list; changes apply here and on the tab
  const add = (tab: Tab) => async (title: string) => {
    const t = await tasksApi.addTask({ title, tab_id: tab.id });
    setTasks(list => [...(list ?? []), t]);
  };
  const done = (t: tasksApi.Task) => {
    setTasks(list => list?.filter(x => x.id !== t.id) ?? null);
    tasksApi.setDone(t.id, true).catch(() => { show('Couldn’t save — try again'); load(); });
    show(`Done: ${t.title}`, async () => { await tasksApi.setDone(t.id, false); await load(); });
  };
  const edit = (t: tasksApi.Task, change: tasksApi.TaskChange) => {
    setTasks(list => list?.map(x => (x.id === t.id ? { ...x, ...change } : x)) ?? null);
    tasksApi.updateTask(t.id, change)
      .then(() => {
        if (change.tab_id && change.tab_id !== t.tab_id) {
          // opened: keep the destination visible even if it was empty
          setOpened(s => new Set(s).add(change.tab_id!));
          show(`Moved to ${tabs.find(x => x.id === change.tab_id)?.name ?? 'the other list'}`,
            async () => { await tasksApi.updateTask(t.id, { tab_id: t.tab_id }); await load(); });
        }
      })
      .catch(() => { show('Couldn’t save — try again'); load(); });
  };
  const remove = (t: tasksApi.Task) => {
    setTasks(list => list?.filter(x => x.id !== t.id) ?? null);
    tasksApi.deleteTask(t.id).catch(() => { show('Couldn’t delete — try again'); load(); });
    show(`Deleted: ${t.title}`);
  };

  return (
    <div className="stack-lg">
      <div>
        <h2 className="page-title">To-Do</h2>
        <p className="muted small">
          {tasks.length === 0 ? 'Nothing on your list.' : `${tasks.length} open`}
          {overdue > 0 && <> · <span className="task-due late">{overdue} overdue</span></>}
          {dueToday > 0 && <> · {dueToday} due today</>}
        </p>
      </div>

      {busy.map(tab => {
        const n = waiting.get(tab.id) ?? 0;
        return (
          <TaskList key={tab.id} title={tab.name} tasks={byTab.get(tab.id) ?? []}
                    onAdd={add(tab)} onDone={done} onEdit={edit} onDelete={remove} lists={tabs}
                    extra={n > 0 && <Link className="waiting-link small" to={`/${tab.slug}`}>✉ {n} {n === 1 ? 'email' : 'emails'} waiting →</Link>} />
        );
      })}

      {quiet.length > 0 && (
        <p className="muted small">
          Nothing on{' '}
          {quiet.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ', '}
              <button className="link inline" onClick={() => setOpened(s => new Set(s).add(t.id))}>{t.name}</button>
            </span>
          ))}
          {' '}— tap one to add a to-do there.
        </p>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button onClick={() => { const u = toast.undo!; setToast(null); u().catch(() => show('Couldn’t undo')); }}>Undo</button>}
        </div>
      )}
    </div>
  );
}
