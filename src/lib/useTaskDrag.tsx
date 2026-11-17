import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { DropSpot, Task } from './tasks';

// Drag a whole to-do row: up/down within its list, or onto another list.
//   Mouse: press anywhere on the row and move a few px (a plain click still opens the editor).
//   Finger: press and hold ~⅓ s (a quick swipe still scrolls the page), then drag.
// Drop targets are elements with data-list="<tab id>"; rows inside them carry data-task="<id>".

export type DragState = {
  task: Task; x: number; y: number; offX: number; offY: number; width: number; over: DropSpot | null;
};

const HOLD_MS = 300;
const SLOP = 8; // px of movement before a mouse press becomes a drag (or a finger press is a scroll)

function spotAt(x: number, y: number, taskId: string): DropSpot | null {
  const list = (document.elementFromPoint(x, y)?.closest('[data-list]') as HTMLElement | null);
  if (!list?.dataset.list) return null;
  const rows = [...list.querySelectorAll<HTMLElement>('[data-task]')].filter(r => r.dataset.task !== taskId);
  const i = rows.findIndex(r => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  return { list: list.dataset.list, index: i === -1 ? rows.length : i };
}

export function useTaskDrag(onDrop: (task: Task, spot: DropSpot) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const press = (task: Task, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // Controls inside the row keep working normally
    if ((e.target as HTMLElement).closest('input, a, select, textarea, .task-edit')) return;
    const row = e.currentTarget.getBoundingClientRect();
    const touch = e.pointerType === 'touch';
    const sx = e.clientX, sy = e.clientY;
    let x = sx, y = sy, started = false;

    const begin = () => {
      started = true;
      navigator.vibrate?.(10);
      window.getSelection()?.removeAllRanges();
      setDrag({ task, x, y, offX: sx - row.left, offY: sy - row.top, width: row.width, over: spotAt(x, y, task.id) });
    };
    const timer = touch ? window.setTimeout(begin, HOLD_MS) : undefined;

    const move = (ev: PointerEvent) => {
      x = ev.clientX; y = ev.clientY;
      if (!started) {
        if (Math.hypot(x - sx, y - sy) > SLOP) { if (touch) cleanup(); else begin(); }
        return;
      }
      ev.preventDefault();
      const edge = Math.min(48, window.innerHeight * 0.08); // thin, so targets near the edge stay droppable
      if (y < edge) window.scrollBy(0, -10); else if (y > window.innerHeight - edge) window.scrollBy(0, 10);
      setDrag(d => (d ? { ...d, x, y, over: spotAt(x, y, task.id) } : d));
    };
    // While dragging with a finger, the page must not scroll
    const noScroll = (ev: TouchEvent) => { if (started) ev.preventDefault(); };
    const end = (ev: PointerEvent) => {
      cleanup();
      if (!started) return;
      const spot = ev.type === 'pointerup' ? spotAt(ev.clientX, ev.clientY, task.id) : null;
      setDrag(null);
      // The release would otherwise "click" the row (opening the editor)
      const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);
      if (spot) onDropRef.current(task, spot);
    };
    function cleanup() {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('touchmove', noScroll);
    }
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('touchmove', noScroll, { passive: false });
  };

  return { drag, press };
}

// The row that follows your pointer while dragging
export function DragGhost({ drag, listName }: { drag: DragState | null; listName?: (id: string) => string | undefined }) {
  if (!drag) return null;
  const to = drag.over && drag.over.list !== drag.task.tab_id ? listName?.(drag.over.list) : undefined;
  return (
    <div className="drag-ghost" aria-hidden
         style={{ left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.width }}>
      <span className="drag-ghost-title">{drag.task.title}</span>
      {to && <span className="drag-ghost-to">→ {to}</span>}
    </div>
  );
}
