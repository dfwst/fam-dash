import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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
  // Drag a to-do by its ⋮⋮ handle onto another list (mouse or finger)
  const [drag, setDrag] = useState<{ task: tasksApi.Task; x: number; y: number; over: string | null } | null>(null);
  const editRef = useRef<(t: tasksApi.Task, c: tasksApi.TaskChange) => void>(() => {});

  const grab = (task: tasksApi.Task, e: ReactPointerEvent) => {
    e.preventDefault();
    const listAt = (x: number, y: number) =>
      (document.elementFromPoint(x, y)?.closest('[data-list]') as HTMLElement | null)?.dataset.list ?? null;
    setDrag({ task, x: e.clientX, y: e.clientY, over: task.tab_id });
    const move = (ev: PointerEvent) => {
      ev.preventDefault();
      // near the top/bottom edge → scroll so far-away lists are reachable
      const edge = Math.min(48, window.innerHeight * 0.08); // thin, so targets near the edge stay droppable
      if (ev.clientY < edge) window.scrollBy(0, -10); else if (ev.clientY > window.innerHeight - edge) window.scrollBy(0, 10);
      setDrag(d => (d ? { ...d, x: ev.clientX, y: ev.clientY, over: listAt(ev.clientX, ev.clientY) } : d));
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const to = ev.type === 'pointerup' ? listAt(ev.clientX, ev.clientY) : null;
      setDrag(null);
      if (to && to !== task.tab_id) editRef.current(task, { tab_id: to });
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

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
  editRef.current = edit;
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
                    listId={tab.id} onGrab={grab} dropping={!!drag && drag.over === tab.id && drag.task.tab_id !== tab.id}
                    draggingId={drag?.task.id}
                    extra={n > 0 && <Link className="waiting-link small" to={`/${tab.slug}`}>✉ {n} {n === 1 ? 'email' : 'emails'} waiting →</Link>} />
        );
      })}

      {quiet.length > 0 && (
        <p className="muted small">
          Nothing on{' '}
          {quiet.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ', '}
              <button className={`link inline${drag?.over === t.id ? ' drop-over' : ''}`} data-list={t.id}
                      onClick={() => setOpened(s => new Set(s).add(t.id))}>{t.name}</button>
            </span>
          ))}
          {' '}— tap one to add a to-do there.
        </p>
      )}

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden>
          {drag.task.title}
          <span className="muted small">{drag.over && drag.over !== drag.task.tab_id ? ` → ${tabs.find(t => t.id === drag.over)?.name}` : ''}</span>
        </div>
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
