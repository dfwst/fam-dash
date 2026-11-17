import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';

const SWIPE = 80; // px to commit

// Swipe a row off either side (phone), or call dismiss() from a ✕ button.
// Used by "Worth a glance" rows, Today's "Needs you" rows and finished to-dos — one feel everywhere.
//   <li className={leaving ? 'leaving' : ''}>
//     {dx !== 0 && <div className="swipe-under">✓ Clear</div>}
//     <div style={style} {...handlers}> … <button onClick={dismiss}>✕</button></div>
//   </li>
export function useSwipeAway(onDismiss: () => void, enabled = true) {
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  const dismiss = () => {
    setLeaving(true);
    window.setTimeout(onDismiss, 160); // let it slide out first
  };
  const onPointerDown = (e: PointerEvent) => {
    if (!enabled || e.pointerType !== 'touch') return;
    start.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const x = e.clientX - s.x, y = e.clientY - s.y;
    if (Math.abs(y) > Math.abs(x) && Math.abs(x) < 12) { start.current = null; setDragging(false); setDx(0); return; } // scrolling
    setDx(x);
  };
  const end = () => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    if (Math.abs(dx) > SWIPE) { setDx(dx > 0 ? 400 : -400); dismiss(); } else setDx(0);
  };

  const style: CSSProperties = {
    ...(dx ? { transform: `translateX(${dx}px)` } : {}),
    ...(dragging ? { transition: 'none' } : {}),
  };
  return {
    dx, leaving, dismiss, style,
    swiped: Math.abs(dx) > 8, // a tap that was really a swipe shouldn't follow the link
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
  };
}
