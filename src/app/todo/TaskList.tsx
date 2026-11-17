import { useState, type ReactNode, type PointerEvent } from 'react';
import { threadPath } from '../../lib/todos';
import { Link } from 'react-router-dom';
import { dueLabel, duePresets, type DropSpot, type Task, type TaskChange } from '../../lib/tasks';
import { useSwipeAway } from '../../lib/useSwipeAway';

export type ListOption = { id: string; name: string };

// One To-Do list: your own action items. Tick one off and it drops to the "Done" pile at the bottom.
// Items made from an email keep a ✉ link back to it.
export default function TaskList({ tasks, done = [], onAdd, onDone, onUndone, onClear, onEdit, onDelete, title = 'To-Do', extra, lists = [], listId, onPress, over, draggingId }: {
  tasks: Task[];          // open items, in order
  done?: Task[];          // finished, not yet cleared — shown crossed out at the bottom
  onUndone?: (t: Task) => void;
  onClear?: (ts: Task[]) => void;
  title?: string;
  extra?: ReactNode; // shown beside the heading (the To-Do page's "N emails" link)
  onAdd: (title: string) => Promise<void>;
  onDone: (t: Task) => void;
  onEdit: (t: Task, change: TaskChange) => void;
  lists?: ListOption[]; // where an item can be moved (your tabs + shared ones)
  // Drag to rearrange / move (see useTaskDrag): this section is a drop target, each row a handle
  listId?: string;
  onPress?: (t: Task, e: PointerEvent<HTMLElement>) => void;
  over?: DropSpot | null;  // where a dragged item would land right now
  draggingId?: string;     // the item being dragged (shown as a gap in place)
  onDelete: (t: Task) => void;
}) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [completing, setCompleting] = useState<Set<string>>(new Set()); // ticked, check animating

  // Let the tick land before the row moves to the Done pile
  const tick = (t: Task) => {
    setCompleting(s => new Set(s).add(t.id));
    window.setTimeout(() => {
      onDone(t);
      setCompleting(s => { const n = new Set(s); n.delete(t.id); return n; });
    }, 380);
  };

  async function add() {
    if (!text.trim() || saving) return;
    setSaving(true);
    try { await onAdd(text); setText(''); } finally { setSaving(false); }
  }

  // Insertion line: before the item at over.index (counting the list WITHOUT the dragged one), or after the last
  const here = !!over && !!listId && over.list === listId;
  const others = tasks.filter(t => t.id !== draggingId);
  const lineBefore = here ? others[over!.index]?.id : undefined;
  const lineAfter = here && over!.index >= others.length ? others[others.length - 1]?.id : undefined;
  const fromElsewhere = here && !tasks.some(t => t.id === draggingId);

  return (
    <section className={`stack tasks${fromElsewhere ? ' drop-over' : ''}`} data-list={listId}>
      <div className="tasks-head">
        <h3 className="section-title">{title}</h3>
        {extra}
      </div>
      <div className="task-card">
      {tasks.length > 0 && (
        <ul className="task-list">
          {tasks.map(t => {
            const due = dueLabel(t.due_on);
            return (
              <li key={t.id} data-task={t.id}
                  className={`task${onPress ? ' draggable' : ''}${draggingId === t.id ? ' dragging' : ''}${completing.has(t.id) ? ' completing' : ''}`
                    + `${lineBefore === t.id ? ' line-before' : ''}${lineAfter === t.id ? ' line-after' : ''}`}
                  onPointerDown={onPress && editing !== t.id ? e => onPress(t, e) : undefined}>
                {onPress && <span className="task-grip" aria-hidden>⋮⋮</span>}
                <input type="checkbox" aria-label={`Done: ${t.title}`} checked={completing.has(t.id)} onChange={() => tick(t)} />
                <button className="task-title" onClick={() => setEditing(e => (e === t.id ? null : t.id))}>{t.title}</button>
                {due && <span className={due.late ? 'task-due late' : 'task-due'}>{due.text}</span>}
                {t.thread_id && t.account_id && (
                  <Link className="task-mail" to={threadPath(t.account_id, t.thread_id)} aria-label="Open the email">✉</Link>
                )}
                {editing === t.id && (
                  <TaskEdit task={t} lists={lists} onClose={() => setEditing(null)}
                            onSave={c => { setEditing(null); onEdit(t, c); }}
                            onDelete={() => { setEditing(null); onDelete(t); }} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form className="task-add" onSubmit={e => { e.preventDefault(); add(); }}>
        <span className="task-plus" aria-hidden>+</span>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Add a to-do…" maxLength={300}
               aria-label="Add a to-do" />
        {text.trim() && <button className="primary" disabled={saving}>Add</button>}
      </form>
      </div>
      {done.length > 0 && (
        <div className="done-pile">
          <div className="done-head">
            <span className="muted small">Done · {done.length}</span>
            {onClear && done.length > 1 && <button className="link small" onClick={() => onClear(done)}>Clear all</button>}
          </div>
          <ul className="task-list">
            {done.map(t => <DoneRow key={t.id} t={t} onUndone={onUndone} onClear={onClear} />)}
          </ul>
        </div>
      )}
    </section>
  );
}

// A finished to-do: stays crossed out at the bottom of its list until you clear it
// (✕, or swipe it away on the phone). Untick it to bring it back.
function DoneRow({ t, onUndone, onClear }: { t: Task; onUndone?: (t: Task) => void; onClear?: (ts: Task[]) => void }) {
  const s = useSwipeAway(() => onClear?.([t]), !!onClear);
  return (
    <li className={`task-done-row${s.leaving ? ' leaving' : ''}`}>
      {s.dx !== 0 && <div className="glance-hint" aria-hidden>✓ Clear</div>}
      <div className="task done" style={s.style} {...s.handlers}>
        <input type="checkbox" checked aria-label={`Not done: ${t.title}`} onChange={() => onUndone?.(t)} />
        <span className="task-title">{t.title}</span>
        {onClear && <button className="glance-x" aria-label={`Clear: ${t.title}`} title="Clear from the list" onClick={s.dismiss}>✕</button>}
      </div>
    </li>
  );
}

function TaskEdit({ task, lists, onSave, onDelete, onClose }: {
  task: Task; lists: ListOption[]; onSave: (c: TaskChange) => void; onDelete: () => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(task.due_on);
  const [list, setList] = useState(task.tab_id ?? '');
  return (
    <form className="add-todo task-edit" onSubmit={e => {
      e.preventDefault();
      if (title.trim()) onSave({ title: title.trim(), due_on: due, ...(list && list !== task.tab_id ? { tab_id: list } : {}) });
    }}>
      <input autoFocus value={title} maxLength={300} onChange={e => setTitle(e.target.value)} aria-label="To-do" />
      <div className="chips" role="group" aria-label="Due">
        <button type="button" className={due === null ? 'chip active' : 'chip'} onClick={() => setDue(null)}>No date</button>
        {duePresets().map(p => (
          <button type="button" key={p.label} className={due === p.value ? 'chip active' : 'chip'} onClick={() => setDue(p.value)}>{p.label}</button>
        ))}
        <input type="date" className="chip-date" aria-label="Pick a date" value={due ?? ''} onChange={e => setDue(e.target.value || null)} />
      </div>
      {lists.length > 1 && (
        <label className="policy">
          <span className="muted small">List</span>
          <select value={list} onChange={e => setList(e.target.value)} aria-label="Move to list">
            {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      )}
      <div className="row-buttons">
        <button type="submit" className="primary">Save</button>
        <button type="button" className="link" onClick={onClose}>Cancel</button>
        <button type="button" className="link danger push" onClick={onDelete}>Delete</button>
      </div>
    </form>
  );
}
