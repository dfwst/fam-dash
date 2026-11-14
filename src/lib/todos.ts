import { supabase } from './supabase';

// Milestone 3: the to-do list is a VIEW of sorted inbox threads — no separate table yet.
// Your correction (user_bucket) always beats the machine's sort (bucket).

export type TodoThread = {
  account_id: string;
  thread_id: string;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  summary: string | null;
  snippet: string | null;
  bucket: number | null;
  user_bucket: number | null;
  priority: boolean;
  category: string | null;
  group_key: string | null;
  last_message_at: string | null;
  last_from_me: boolean | null;
  unread: boolean | null;
  in_inbox: boolean;
  snoozed_until: string | null;
};

const COLS = 'account_id, thread_id, subject, from_name, from_email, summary, snippet, bucket, user_bucket, '
  + 'priority, category, group_key, last_message_at, last_from_me, unread, in_inbox, snoozed_until';

// Snoozed and the time has come → back at the top of the list
export const isResurfaced = (t: TodoThread) => !!t.snoozed_until && Date.parse(t.snoozed_until) <= Date.now();
export const isSnoozed = (t: TodoThread) => !!t.snoozed_until && Date.parse(t.snoozed_until) > Date.now();

export const effectiveBucket = (t: TodoThread) => t.user_bucket ?? t.bucket;

// Red is reserved for money and security. Everything else that's priority (e.g. Resi) is amber.
export const isUrgent = (t: TodoThread) =>
  t.priority && (t.category === 'payment_issue' || t.category === 'security');

export async function loadTabThreads(accountIds: string[]) {
  if (!accountIds.length) return { inbox: [] as TodoThread[], glance: [] as TodoThread[] };
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [inbox, glance] = await Promise.all([
    supabase.from('email_threads').select(COLS)
      .in('account_id', accountIds).eq('in_inbox', true).eq('status', 'classified')
      .order('last_message_at', { ascending: false }).limit(1000),
    // Glance items get archived in M4, so the feed doesn't require in_inbox
    supabase.from('email_threads').select(COLS)
      .in('account_id', accountIds).eq('status', 'classified').gte('last_message_at', weekAgo)
      .or('user_bucket.eq.2,and(user_bucket.is.null,bucket.eq.2)')
      .order('last_message_at', { ascending: false }).limit(100),
  ]);
  if (inbox.error) throw inbox.error;
  if (glance.error) throw glance.error;
  // COLS is built by concatenation, so supabase-js can't infer the row type — assert it
  return {
    inbox: (inbox.data ?? []) as unknown as TodoThread[],
    glance: (glance.data ?? []) as unknown as TodoThread[],
  };
}

// ── Turning threads into calm, grouped lines ────────────────────────

export type Line =
  | { kind: 'one'; key: string; thread: TodoThread }
  | { kind: 'group'; key: string; label: string; threads: TodoThread[] };

const time = (t: TodoThread) => (t.last_message_at ? Date.parse(t.last_message_at) : 0);

// "church-serving-reminder" ×3 → "3 church serving reminders"
function groupLabel(key: string, n: number) {
  const words = key.replace(/-/g, ' ').trim();
  return `${n} ${words.endsWith('s') ? words : `${words}s`}`;
}

/**
 * Order: urgent (money/security) → back from Remind me → other priority → newest first.
 * Threads sharing a group_key collapse into one line, placed where its
 * most important member would sit. Priority threads never hide inside a group.
 */
export function toLines(threads: TodoThread[]): Line[] {
  const rank = (t: TodoThread) => (isUrgent(t) ? 0 : isResurfaced(t) ? 1 : t.priority ? 2 : 3);
  const sorted = [...threads].sort((a, b) => rank(a) - rank(b) || time(b) - time(a));

  const groups = new Map<string, TodoThread[]>();
  for (const t of sorted) {
    if (t.group_key && !t.priority && !isResurfaced(t)) groups.set(t.group_key, [...(groups.get(t.group_key) ?? []), t]);
  }

  const lines: Line[] = [];
  const placed = new Set<string>();
  for (const t of sorted) {
    const g = t.group_key && !t.priority && !isResurfaced(t) ? groups.get(t.group_key)! : null;
    if (g && g.length > 1) {
      if (placed.has(t.group_key!)) continue;
      placed.add(t.group_key!);
      lines.push({ kind: 'group', key: `g:${t.group_key}`, label: groupLabel(t.group_key!, g.length), threads: g });
    } else {
      lines.push({ kind: 'one', key: t.account_id + t.thread_id, thread: t });
    }
  }
  return lines;
}

export function splitTodos(inbox: TodoThread[]) {
  const real = inbox.filter(t => effectiveBucket(t) === 3);
  const awake = real.filter(t => !isSnoozed(t));
  return {
    todo: awake.filter(t => !t.last_from_me),    // someone is waiting on YOU
    waiting: awake.filter(t => t.last_from_me),  // you replied last — waiting on them
    snoozed: real.filter(isSnoozed)               // Remind me — hidden until their time
      .sort((a, b) => Date.parse(a.snoozed_until!) - Date.parse(b.snoozed_until!)),
  };
}

export const ago = (iso: string | null) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  const d = Math.round(m / 1440);
  return d < 7 ? `${d}d` : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
