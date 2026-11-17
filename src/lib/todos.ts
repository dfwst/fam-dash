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
  acted: 'done' | 'ignored' | 'archived' | null; // done/ignored = you handled it; archived = morning cleanup
  web_link: string | null; // Outlook on the web (Microsoft accounts)
  tab_id: string | null;   // a household rule put it on this tab (overrides the account's tab)
  shared: boolean;         // a rule shared it with the household
};

// In-app reader URL. Microsoft conversation ids contain / + = so they must be encoded.
export const threadPath = (accountId: string, threadId: string) =>
  `/t/${accountId}/${encodeURIComponent(threadId)}`;

const COLS = 'account_id, thread_id, subject, from_name, from_email, summary, snippet, bucket, user_bucket, '
  + 'priority, category, group_key, last_message_at, last_from_me, unread, in_inbox, snoozed_until, acted, web_link, tab_id, shared';

// Snoozed and the time has come → back at the top of the list
export const isResurfaced = (t: TodoThread) => !!t.snoozed_until && Date.parse(t.snoozed_until) <= Date.now();
export const isSnoozed = (t: TodoThread) => !!t.snoozed_until && Date.parse(t.snoozed_until) > Date.now();

export const effectiveBucket = (t: TodoThread) => t.user_bucket ?? t.bucket;

// Red is reserved for money and security. Everything else that's priority (e.g. Resi) is amber.
export const isUrgent = (t: TodoThread) =>
  t.priority && (t.category === 'payment_issue' || t.category === 'security');

// A tab shows: its accounts' mail (except emails a rule moved to another tab) + emails a rule
// moved here from any account — including ones a rule shared from someone else's mailbox.
export async function loadTabThreads(accountIds: string[], tabId?: string) {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const none = Promise.resolve({ data: [] as unknown[], error: null });
  const byAccount = (q: ReturnType<typeof base>) => (accountIds.length ? q.in('account_id', accountIds) : none);
  const byRule = (q: ReturnType<typeof base>) => (tabId ? q.eq('tab_id', tabId) : none);
  const base = () => supabase.from('email_threads').select(COLS).eq('status', 'classified');
  const inboxQ = () => base().eq('in_inbox', true).order('last_message_at', { ascending: false }).limit(1000);
  // Glance items get archived in M4, so the feed doesn't require in_inbox
  const glanceQ = () => base().gte('last_message_at', weekAgo)
    .or('user_bucket.eq.2,and(user_bucket.is.null,bucket.eq.2)')
    .order('last_message_at', { ascending: false }).limit(100);

  const [a, b, c, d] = await Promise.all([byAccount(inboxQ()), byRule(inboxQ()), byAccount(glanceQ()), byRule(glanceQ())]);
  for (const r of [a, b, c, d]) if (r.error) throw r.error;
  // COLS is built by concatenation, so supabase-js can't infer the row type — assert it
  const merge = (own: unknown[] | null, ruled: unknown[] | null) => {
    const seen = new Set<string>();
    return [...((own ?? []) as TodoThread[]).filter(t => !t.tab_id || t.tab_id === tabId), ...((ruled ?? []) as TodoThread[])]
      .filter(t => { const k = t.account_id + t.thread_id; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((x, y) => (y.last_message_at ?? '').localeCompare(x.last_message_at ?? ''));
  };
  return {
    inbox: merge(a.data, b.data),
    // Glance stays visible after the morning cleanup archives it ('archived'), but once
    // YOU tap Done or Ignore it's handled — gone from the feed (Undo brings it back)
    glance: merge(c.data, d.data).filter(t => t.acted !== 'done' && t.acted !== 'ignored'),
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

// Emails waiting on you, counted per tab (a rule's tab wins over the account's tab).
// Same rule as each tab's list: Real, not snoozed, and someone else wrote last.
export async function waitingByTab(): Promise<Map<string, number>> {
  const [threads, accts] = await Promise.all([
    supabase.from('email_threads').select('account_id, bucket, user_bucket, last_from_me, snoozed_until, tab_id')
      .eq('in_inbox', true).eq('status', 'classified').limit(3000),
    supabase.from('connected_accounts').select('id, default_tab_id'),
  ]);
  if (threads.error) throw threads.error;
  if (accts.error) throw accts.error;
  const home = new Map((accts.data ?? []).map(a => [a.id, a.default_tab_id as string | null]));
  const out = new Map<string, number>();
  for (const t of (threads.data ?? []) as Pick<TodoThread, 'account_id' | 'bucket' | 'user_bucket' | 'last_from_me' | 'snoozed_until' | 'tab_id'>[]) {
    if ((t.user_bucket ?? t.bucket) !== 3 || t.last_from_me || isSnoozed(t as TodoThread)) continue;
    const tab = t.tab_id ?? home.get(t.account_id);
    if (tab) out.set(tab, (out.get(tab) ?? 0) + 1);
  }
  return out;
}
