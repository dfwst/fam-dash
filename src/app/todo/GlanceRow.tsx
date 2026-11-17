import { useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { ago, threadPath, type TodoThread } from '../../lib/todos';

const SWIPE = 80; // px to commit

// One "Worth a glance" line. Clear it without opening: swipe either way on the phone, or tap ✕.
// Clearing = Done (archived, gone from the list, Undo in the toast).
export default function GlanceRow({ t, canAct, onDismiss }: {
  t: TodoThread; canAct: boolean; onDismiss: (t: TodoThread) => void;
}) {
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  const dismiss = () => {
    setLeaving(true);
    window.setTimeout(() => onDismiss(t), 160); // let it slide out first
  };
  const down = (e: PointerEvent) => {
    if (!canAct || e.pointerType !== 'touch') return;
    start.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const move = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const x = e.clientX - s.x, y = e.clientY - s.y;
    if (Math.abs(y) > Math.abs(x) && Math.abs(x) < 12) { start.current = null; setDragging(false); setDx(0); return; } // scrolling
    setDx(x);
  };
  const up = () => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    if (Math.abs(dx) > SWIPE) { setDx(dx > 0 ? 400 : -400); dismiss(); } else setDx(0);
  };

  return (
    <li className={`glance-row${leaving ? ' leaving' : ''}`}>
      {dx !== 0 && <div className="glance-hint" aria-hidden>✓ Clear</div>}
      <div className="glance-slide" style={{ ...(dx ? { transform: `translateX(${dx}px)` } : {}), ...(dragging ? { transition: 'none' } : {}) }}
           onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <Link to={threadPath(t.account_id, t.thread_id)} draggable={false}
              onClick={e => { if (Math.abs(dx) > 8) e.preventDefault(); }}>
          <span className="glance-from">{t.from_name || t.from_email}</span>
          <span className="glance-text">{t.summary || t.subject}</span>
          <span className="todo-meta">{ago(t.last_message_at)}</span>
        </Link>
        {canAct && (
          <button className="glance-x" aria-label={`Clear: ${t.subject ?? 'email'}`} title="Clear (archive)" onClick={dismiss}>✕</button>
        )}
      </div>
    </li>
  );
}
