import { useRef, useState, type PointerEvent } from 'react';
import { accountLabel, gmailLink, type Account } from '../../lib/accounts';
import { ago, isResurfaced, isUrgent, type Line, type TodoThread } from '../../lib/todos';
import { remindPresets } from '../../lib/actions';

export type RowAction =
  | { kind: 'done' | 'ignore'; thread: TodoThread }
  | { kind: 'snooze'; thread: TodoThread; until: Date };

const senderName = (t: TodoThread) => t.from_name || t.from_email || 'Unknown sender';
const SWIPE = 90; // px to commit a swipe

function RemindMenu({ onPick, onClose }: { onPick: (d: Date) => void; onClose: () => void }) {
  const [custom, setCustom] = useState('');
  return (
    <div className="remind" role="menu">
      {remindPresets().map(p => (
        <button key={p.label} role="menuitem" onClick={() => onPick(p.when)}>{p.label}</button>
      ))}
      <label className="remind-pick">
        Pick a date
        <input type="date" value={custom} min={new Date().toISOString().slice(0, 10)}
               onChange={e => setCustom(e.target.value)} />
      </label>
      {custom && (
        <button className="primary" onClick={() => { const d = new Date(`${custom}T08:00`); onPick(d); }}>
          Remind me {new Date(`${custom}T08:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, 8am
        </button>
      )}
      <button className="link" onClick={onClose}>Cancel</button>
    </div>
  );
}

function ThreadRow({ t, acct, showAccount, onAction }: {
  t: TodoThread; acct?: Account; showAccount: boolean; onAction: (a: RowAction) => void;
}) {
  const [remind, setRemind] = useState(false);
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const href = acct ? gmailLink(acct.email, t.thread_id) : undefined;

  // Phone gestures: swipe right = Done, swipe left = Remind me
  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const move = (e: PointerEvent) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const x = e.clientX - s.x, y = e.clientY - s.y;
    if (Math.abs(y) > Math.abs(x) && Math.abs(x) < 12) { start.current = null; setDx(0); return; } // scrolling
    setDx(Math.max(-140, Math.min(140, x)));
  };
  const up = () => {
    if (!start.current) return;
    start.current = null;
    if (dx > SWIPE) onAction({ kind: 'done', thread: t });
    else if (dx < -SWIPE) setRemind(true);
    setDx(0);
  };

  return (
    <div className="swipe-wrap">
      <div className={`swipe-hint ${dx > 0 ? 'right' : dx < 0 ? 'left' : ''}`} aria-hidden>
        <span>{dx > 0 ? '✓ Done' : ''}</span><span>{dx < 0 ? 'Remind me ⏰' : ''}</span>
      </div>
      <div className="todo" style={dx ? { transform: `translateX(${dx}px)` } : undefined}
           onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <a className="todo-body" href={href} target="_blank" rel="noreferrer" draggable={false}
           onClick={e => { if (Math.abs(dx) > 8) e.preventDefault(); }}>
          <div className="todo-top">
            {isUrgent(t) ? <span className="badge urgent">{t.category === 'security' ? 'Security' : 'Payment'}</span>
              : isResurfaced(t) ? <span className="badge back">Reminder</span>
              : t.priority ? <span className="badge soft">Priority</span> : null}
            <span className={t.unread ? 'todo-from' : 'todo-from read'}>{senderName(t)}</span>
            <span className="todo-meta">
              {showAccount && acct ? `${accountLabel(acct)} · ` : ''}{ago(t.last_message_at)}
            </span>
          </div>
          <div className="todo-subject">{t.subject}</div>
          <div className="todo-summary">{t.summary || t.snippet}</div>
        </a>
        <div className="actions">
          <button onClick={() => onAction({ kind: 'done', thread: t })}>Done</button>
          <button onClick={() => onAction({ kind: 'ignore', thread: t })}>Ignore</button>
          <button onClick={() => setRemind(r => !r)} aria-expanded={remind}>Remind me</button>
          {href && <a className="open" href={href} target="_blank" rel="noreferrer">Open ↗</a>}
        </div>
        {remind && (
          <RemindMenu onClose={() => setRemind(false)}
                      onPick={until => { setRemind(false); onAction({ kind: 'snooze', thread: t, until }); }} />
        )}
      </div>
    </div>
  );
}

export default function TodoRow({ line, accounts, showAccount, onAction }: {
  line: Line; accounts: Map<string, Account>; showAccount: boolean; onAction: (a: RowAction) => void;
}) {
  const [open, setOpen] = useState(false);

  if (line.kind === 'one') {
    return (
      <li>
        <ThreadRow t={line.thread} acct={accounts.get(line.thread.account_id)} showAccount={showAccount} onAction={onAction} />
      </li>
    );
  }

  const newest = line.threads[0];
  return (
    <li>
      <div className="todo group">
        <button className="todo-body group-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <div className="todo-top">
            <span className="todo-from">{line.label}</span>
            <span className="todo-meta">{ago(newest.last_message_at)} {open ? '▴' : '▾'}</span>
          </div>
          {!open && <div className="todo-summary">Latest: {newest.summary || newest.subject}</div>}
        </button>
        <div className="actions">
          <button onClick={() => line.threads.forEach(t => onAction({ kind: 'done', thread: t }))}>
            Done all {line.threads.length}
          </button>
          <button onClick={() => setOpen(o => !o)}>{open ? 'Collapse' : 'Show them'}</button>
        </div>
      </div>
      {open && (
        <ul className="sublist">
          {line.threads.map(t => (
            <li key={t.account_id + t.thread_id}>
              <ThreadRow t={t} acct={accounts.get(t.account_id)} showAccount={showAccount} onAction={onAction} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
