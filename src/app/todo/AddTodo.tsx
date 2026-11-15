import { useState } from 'react';
import { duePresets } from '../../lib/tasks';

// "Add to To-Do" from an email: a short title, an optional day, and whether the email
// itself can go (archived as Done) now that the job lives on your To-Do list.
export type NewTodo = { title: string; due_on: string | null; alsoDone: boolean };

export default function AddTodo({ initialTitle, onSave, onClose }: {
  initialTitle: string; onSave: (t: NewTodo) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle.slice(0, 300));
  const [due, setDue] = useState<string | null>(null);
  const [alsoDone, setAlsoDone] = useState(true);
  const presets = duePresets();

  const save = () => title.trim() && onSave({ title: title.trim(), due_on: due, alsoDone });

  return (
    <form className="add-todo" onSubmit={e => { e.preventDefault(); save(); }}>
      <label className="muted small" htmlFor="todo-title">Add to To-Do</label>
      <input id="todo-title" autoFocus value={title} maxLength={300}
             onChange={e => setTitle(e.target.value)} placeholder="What needs doing?" />
      <div className="chips" role="group" aria-label="Due">
        <button type="button" className={due === null ? 'chip active' : 'chip'} onClick={() => setDue(null)}>No date</button>
        {presets.map(p => (
          <button type="button" key={p.label} className={due === p.value ? 'chip active' : 'chip'} onClick={() => setDue(p.value)}>
            {p.label}
          </button>
        ))}
        <input type="date" className="chip-date" aria-label="Pick a date" value={due ?? ''}
               min={presets[0].value} onChange={e => setDue(e.target.value || null)} />
      </div>
      <label className="check-line">
        <input type="checkbox" checked={alsoDone} onChange={e => setAlsoDone(e.target.checked)} />
        <span>Also mark the email Done (archive it)</span>
      </label>
      <div className="row-buttons">
        <button type="submit" className="primary" disabled={!title.trim()}>Add</button>
        <button type="button" className="link" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
