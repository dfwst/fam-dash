import { supabase } from './supabase';

// Your own To-Do items (Milestone 5). Typed in, or made from an email with "Add to To-Do".
export type Task = {
  id: string;
  tab_id: string | null;
  title: string;
  notes: string | null;
  due_on: string | null;      // yyyy-mm-dd, your local day
  done_at: string | null;
  account_id: string | null;
  thread_id: string | null;
  created_at: string;
  sort_order: number | null; // your order in the list (drag to rearrange); null = not placed yet
};

const COLS = 'id, tab_id, title, notes, due_on, done_at, account_id, thread_id, created_at, sort_order';

let household: Promise<string> | null = null;
function householdId(): Promise<string> {
  household ??= Promise.resolve(supabase.from('household_members').select('household_id').limit(1).single())
    .then(({ data, error }) => {
      if (error || !data) { household = null; throw error ?? new Error('no-household'); }
      return data.household_id as string;
    });
  return household;
}

// Open items on a tab: the order you dragged them into first; then dated ones (soonest first), then the rest, newest first
export async function loadTasks(tabId: string): Promise<Task[]> {
  const { data, error } = await supabase.from('tasks').select(COLS)
    .eq('tab_id', tabId).is('done_at', null)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('due_on', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as Task[];
}

export async function addTask(t: {
  title: string; tab_id: string | null; due_on?: string | null; notes?: string | null;
  account_id?: string | null; thread_id?: string | null;
}): Promise<Task> {
  const { data, error } = await supabase.from('tasks')
    .insert({ ...t, title: t.title.trim(), household_id: await householdId() })
    .select(COLS).single();
  if (error) throw error;
  return data as Task;
}

// Ticking a to-do off keeps it on its list (crossed out, at the bottom) until you clear it
export async function setDone(id: string, done: boolean) {
  const { error } = await supabase.from('tasks').update({ done_at: done ? new Date().toISOString() : null }).eq('id', id);
  if (error) throw error;
}

// Clear finished items off the list (kept in the database; `false` brings them back — Undo)
export async function setCleared(ids: string[], cleared: boolean) {
  if (!ids.length) return;
  const { error } = await supabase.from('tasks').update({ cleared_at: cleared ? new Date().toISOString() : null }).in('id', ids);
  if (error) throw error;
}

// How many open to-dos a tab's list has (the Mail screen's one-line pointer to the To-Do page)
export async function countOpen(tabId: string): Promise<number> {
  const { count, error } = await supabase.from('tasks').select('id', { count: 'exact', head: true })
    .eq('tab_id', tabId).is('done_at', null);
  if (error) throw error;
  return count ?? 0;
}

export const isDone = (t: Task) => !!t.done_at;

export type TaskChange = Partial<Pick<Task, 'title' | 'due_on' | 'notes' | 'tab_id' | 'sort_order'>>;

// tab_id moves it to another list (yours or a shared one — the database refuses anyone else's)
export async function updateTask(id: string, change: TaskChange) {
  const { error } = await supabase.from('tasks').update(change).eq('id', id);
  if (error) throw error;
}

export async function deleteTask(id: string) {
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) throw error;
}

// ── Due dates (your local calendar day) ─────────────────────────────

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

export function duePresets(): { label: string; value: string }[] {
  const day = new Date().getDay(); // 0 Sun … 6 Sat
  const out = [
    { label: 'Today', value: ymd(plus(0)) },
    { label: 'Tomorrow', value: ymd(plus(1)) },
  ];
  if (day >= 1 && day <= 4) out.push({ label: 'This weekend', value: ymd(plus(6 - day)) });
  out.push({ label: 'Next week', value: ymd(plus(((8 - day) % 7) || 7)) });
  return out;
}

export function dueLabel(due: string | null): { text: string; late: boolean } | null {
  if (!due) return null;
  const today = ymd(new Date());
  if (due < today) return { text: 'Overdue', late: true };
  if (due === today) return { text: 'Today', late: false };
  if (due === ymd(plus(1))) return { text: 'Tomorrow', late: false };
  const d = new Date(`${due}T12:00`);
  const days = (d.getTime() - Date.now()) / 86_400_000;
  return { text: d.toLocaleDateString([], days < 6 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }), late: false };
}

// Every item you can see, across all tabs (yours + Shared) — for the To-Do page and Today.
// Open ones, plus the ones you finished in the last 7 days and haven't cleared (your "done" pile).
export async function loadAllTasks(): Promise<Task[]> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data, error } = await supabase.from('tasks').select(COLS).is('cleared_at', null)
    .or(`done_at.is.null,done_at.gte.${weekAgo}`)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('due_on', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as Task[];
}

// ── Drag to rearrange / move ────────────────────────────────────────
export type DropSpot = { list: string; index: number }; // index among the list's OTHER items

/**
 * Put `task` at `spot` and number that whole list 1…n (so the order sticks).
 * Returns the new task array (destination list regrouped in its new order) and the
 * per-item changes to save. Only items whose place or list actually changed are saved.
 */
export function placeTask(all: Task[], task: Task, spot: DropSpot) {
  const others = all.filter(t => t.tab_id === spot.list && t.id !== task.id);
  const moved = { ...task, tab_id: spot.list };
  const ordered = [...others.slice(0, spot.index), moved, ...others.slice(spot.index)]
    .map((t, i) => ({ ...t, sort_order: i + 1 }));
  const before = new Map(all.map(t => [t.id, t]));
  const changes = ordered.flatMap(t => {
    const was = before.get(t.id)!;
    const c: TaskChange = {};
    if (was.sort_order !== t.sort_order) c.sort_order = t.sort_order;
    if (was.tab_id !== t.tab_id) c.tab_id = t.tab_id;
    return Object.keys(c).length ? [{ id: t.id, change: c }] : [];
  });
  const ids = new Set(ordered.map(t => t.id));
  // Lists render in array order, so the destination list goes in as one block in its new order
  const next = [...all.filter(t => !ids.has(t.id)), ...ordered];
  return { next, changes };
}

export async function saveChanges(changes: { id: string; change: TaskChange }[]) {
  await Promise.all(changes.map(c => updateTask(c.id, c.change)));
}
