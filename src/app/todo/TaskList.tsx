import { useState } from 'react';
import { threadPath } from '../../lib/todos';
import { Link } from 'react-router-dom';
import { dueLabel, duePresets, type Task } from '../../lib/tasks';

// The tab's To-Do list: your own action items. Tick one off and it's gone (with an Undo).
// Items made from an email keep a ✉ link back to it.
export default function TaskList({ tasks, onAdd, onDone, onEdit, onDelete }: {
  tasks: Task[];
  onAdd: (title: string) => Promise<void>;
  onDone: (t: Task) => void;
  onEdit: (t: Task, change: Partial<Pick<Task, 'title' | 'due_on'>>) => void;
  onDelete: (t: Task) => void;
}) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function add() {
    if (!text.trim() || saving) return;
    setSaving(true);
    try { await onAdd(text); setText(''); } finally { setSaving(false); }
  }

  return (
    <section className="stack tasks">
      <h3 className="section-title">To-Do</h3>
      {tasks.length > 0 && (
        <ul className="task-list">
          {tasks.map(t => {
            const due = dueLabel(t.due_on);
            return (
              <li key={t.id} className="task">
                <input type="checkbox" aria-label={`Done: ${t.title}`} onChange={() => onDone(t)} />
                <button className="task-title" onClick={() => setEditing(e => (e === t.id ? null : t.id))}>{t.title}</button>
                {due && <span className={due.late ? 'task-due late' : 'task-due'}>{due.text}</span>}
                {t.thread_id && t.account_id && (
                  <Link className="task-mail" to={threadPath(t.account_id, t.thread_id)} aria-label="Open the email">✉</Link>
                )}
                {editing === t.id && (
                  <TaskEdit task={t} onClose={() => setEditing(null)}
                            onSave={c => { setEditing(null); onEdit(t, c); }}
                            onDelete={() => { setEditing(null); onDelete(t); }} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form className="task-add" onSubmit={e => { e.preventDefault(); add(); }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Add a to-do…" maxLength={300}
               aria-label="Add a to-do" />
        {text.trim() && <button className="primary" disabled={saving}>Add</button>}
      </form>
    </section>
  );
}

function TaskEdit({ task, onSave, onDelete, onClose }: {
  task: Task; onSave: (c: Partial<Pick<Task, 'title' | 'due_on'>>) => void; onDelete: () => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(task.due_on);
  return (
    <form className="add-todo task-edit" onSubmit={e => { e.preventDefault(); if (title.trim()) onSave({ title: title.trim(), due_on: due }); }}>
      <input autoFocus value={title} maxLength={300} onChange={e => setTitle(e.target.value)} aria-label="To-do" />
      <div className="chips" role="group" aria-label="Due">
        <button type="button" className={due === null ? 'chip active' : 'chip'} onClick={() => setDue(null)}>No date</button>
        {duePresets().map(p => (
          <button type="button" key={p.label} className={due === p.value ? 'chip active' : 'chip'} onClick={() => setDue(p.value)}>{p.label}</button>
        ))}
        <input type="date" className="chip-date" aria-label="Pick a date" value={due ?? ''} onChange={e => setDue(e.target.value || null)} />
      </div>
      <div className="row-buttons">
        <button type="submit" className="primary">Save</button>
        <button type="button" className="link" onClick={onClose}>Cancel</button>
        <button type="button" className="link danger push" onClick={onDelete}>Delete</button>
      </div>
    </form>
  );
}
