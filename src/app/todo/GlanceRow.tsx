import { Link } from 'react-router-dom';
import { ago, threadPath, type TodoThread } from '../../lib/todos';
import { useSwipeAway } from '../../lib/useSwipeAway';

// One "Worth a glance" line. Clear it without opening: swipe either way on the phone, or tap ✕.
// Clearing = Done (archived, gone from the list, Undo in the toast).
export default function GlanceRow({ t, canAct, onDismiss }: {
  t: TodoThread; canAct: boolean; onDismiss: (t: TodoThread) => void;
}) {
  const s = useSwipeAway(() => onDismiss(t), canAct);
  return (
    <li className={`glance-row${s.leaving ? ' leaving' : ''}`}>
      {s.dx !== 0 && <div className="glance-hint" aria-hidden>✓ Clear</div>}
      <div className="glance-slide" style={s.style} {...s.handlers}>
        <Link to={threadPath(t.account_id, t.thread_id)} draggable={false}
              onClick={e => { if (s.swiped) e.preventDefault(); }}>
          <span className="glance-from">{t.from_name || t.from_email}</span>
          <span className="glance-text">{t.summary || t.subject}</span>
          <span className="todo-meta">{ago(t.last_message_at)}</span>
        </Link>
        {canAct && (
          <button className="glance-x" aria-label={`Clear: ${t.subject ?? 'email'}`} title="Clear (archive)" onClick={s.dismiss}>✕</button>
        )}
      </div>
    </li>
  );
}
