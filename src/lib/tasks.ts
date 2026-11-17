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
};

const COLS = 'id, tab_id, title, notes, due_on, done_at, account_id, thread_id, created_at';

let household: Promise<string> | null = null;
function householdId(): Promise<string> {
  household ??= Promise.resolve(supabase.from('household_members').select('household_id').limit(1).single())
    .then(({ data, error }) => {
      if (error || !data) { household = null; throw error ?? new Error('no-household'); }
      return data.household_id as string;
    });
  return household;
}

// Open items on a tab: dated ones first (soonest first), then the rest, newest first
export async function loadTasks(tabId: string): Promise<Task[]> {
  const { data, error } = await supabase.from('tasks').select(COLS)
    .eq('tab_id', tabId).is('done_at', null)
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

export async function setDone(id: string, done: boolean) {
  const { error } = await supabase.from('tasks').update({ done_at: done ? new Date().toISOString() : null }).eq('id', id);
  if (error) throw error;
}

export type TaskChange = Partial<Pick<Task, 'title' | 'due_on' | 'notes' | 'tab_id'>>;

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

// Every open item you can see, across all tabs (yours + Shared) — for the To-Do page
export async function loadAllTasks(): Promise<Task[]> {
  const { data, error } = await supabase.from('tasks').select(COLS).is('done_at', null)
    .order('due_on', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as Task[];
}
