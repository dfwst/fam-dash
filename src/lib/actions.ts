import { callFn } from './functions';
import type { TodoThread } from './todos';

// Your quick actions. Every one returns a logId so it can be undone.
type Ref = Pick<TodoThread, 'account_id' | 'thread_id'>;
const ids = (t: Ref) => ({ accountId: t.account_id, threadId: t.thread_id });

export const done = (t: Ref) => callFn<{ logId: number }>('thread-action', { action: 'done', ...ids(t) });

export const ignore = (t: Ref) => callFn<{
  logId: number; offerAlwaysIgnore?: boolean; sender?: string; senderName?: string | null;
}>('thread-action', { action: 'ignore', ...ids(t) });

export const snooze = (t: Ref, until: Date) =>
  callFn<{ logId: number }>('thread-action', { action: 'snooze', ...ids(t), until: until.toISOString() });

export const unsnooze = (t: Ref) => callFn<{ logId: number }>('thread-action', { action: 'unsnooze', ...ids(t) });

export const alwaysIgnore = (sender: string) =>
  callFn<{ filters: number; archived: number }>('thread-action', { action: 'always_ignore', sender });

export const undo = (logId: number) => callFn<{ undone: number }>('thread-action', { action: 'undo', logId });

// ── Remind me presets (in your local time) ──────────────────────────

const at = (d: Date, h: number) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export function remindPresets(now = new Date()): { label: string; when: Date }[] {
  const out: { label: string; when: Date }[] = [];
  // Later today: 3 hours from now, if that's still before 9pm
  const later = new Date(now.getTime() + 3 * 3_600_000);
  later.setMinutes(0, 0, 0);
  if (later.getHours() < 21 && later.getDate() === now.getDate()) out.push({ label: 'Later today', when: later });
  out.push({ label: 'Tomorrow morning', when: at(addDays(now, 1), 8) });
  // This weekend: Saturday 9am (skip if it's already the weekend)
  const day = now.getDay(); // 0 Sun … 6 Sat
  if (day >= 1 && day <= 5) out.push({ label: 'This weekend', when: at(addDays(now, 6 - day), 9) });
  // Next week: next Monday 8am
  out.push({ label: 'Next week', when: at(addDays(now, ((8 - day) % 7) || 7), 8) });
  return out;
}

export const whenLabel = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
