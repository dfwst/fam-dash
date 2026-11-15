import { useEffect, useRef } from 'react';

// Pull-to-refresh plumbing. The shell fires REFRESH_EVENT; a page that can reload its own
// data pushes that promise into detail.waits (so the spinner waits for it).
export const REFRESH_EVENT = 'rlyfe:refresh';
export type RefreshDetail = { waits: Promise<unknown>[] };

export function useOnRefresh(reload: () => Promise<unknown>) {
  const fn = useRef(reload);
  fn.current = reload;
  useEffect(() => {
    const handler = (e: Event) => (e as CustomEvent<RefreshDetail>).detail.waits.push(fn.current());
    window.addEventListener(REFRESH_EVENT, handler);
    return () => window.removeEventListener(REFRESH_EVENT, handler);
  }, []);
}
