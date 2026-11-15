import { useEffect, useRef, useState } from 'react';

// Pull down from the top of the page to refresh — the home-screen app has no browser
// reload button, so this is the only way to ask for fresh mail.
//   - only starts when the page is scrolled to the very top
//   - ignores sideways drags (row swipes) and touches inside text boxes / the reply box
//   - drag past THRESHOLD and let go → onRefresh()
const THRESHOLD = 70;  // px of pull (after resistance) to trigger
const MAX = 110;

export function usePullToRefresh(onRefresh: () => Promise<unknown> | void) {
  const [pull, setPull] = useState(0);          // how far the indicator is pulled down
  const [refreshing, setRefreshing] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const active = useRef(false);
  const pullRef = useRef(0);
  const busy = useRef(false);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;

  useEffect(() => {
    const set = (v: number) => { pullRef.current = v; setPull(v); };

    const onStart = (e: TouchEvent) => {
      const el = e.target as HTMLElement | null;
      if (busy.current || e.touches.length !== 1 || window.scrollY > 0) return;
      if (el?.closest('input, textarea, select, [contenteditable], .reply, iframe, .no-pull')) return;
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      active.current = false;
    };

    const onMove = (e: TouchEvent) => {
      const s = start.current;
      if (!s) return;
      const dx = e.touches[0].clientX - s.x;
      const dy = e.touches[0].clientY - s.y;
      if (!active.current) {
        if (Math.abs(dx) > Math.abs(dy) || dy < 0) { if (Math.abs(dx) > 8 || dy < -8) start.current = null; return; }
        if (dy < 8 || window.scrollY > 0) return;
        active.current = true;
      }
      set(Math.min(MAX, dy * 0.5)); // resistance: feels like stretching
    };

    const onEnd = async () => {
      if (!start.current) return;
      start.current = null;
      const went = active.current && pullRef.current >= THRESHOLD;
      active.current = false;
      if (!went) { set(0); return; }
      busy.current = true;
      setRefreshing(true);
      set(THRESHOLD * 0.75);
      const minSpin = new Promise(r => setTimeout(r, 600)); // long enough to see it happened
      try { await Promise.all([cb.current(), minSpin]); } finally {
        busy.current = false;
        setRefreshing(false);
        set(0);
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  return { pull, refreshing, ready: pull >= THRESHOLD };
}
