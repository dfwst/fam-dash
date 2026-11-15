import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY — see .env.example');
}

// No cross-tab browser lock around token refresh. On iPhone home-screen apps, iOS can freeze the
// app while it holds that lock (mid-refresh); after that every request waits forever and pages
// sit on "Loading…". rlyfe runs in one window, so the lock isn't needed — just run the work.
const noLock = async <R,>(_name: string, _acquireTimeout: number, fn: () => Promise<R>): Promise<R> => fn();

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, lock: noLock },
});
