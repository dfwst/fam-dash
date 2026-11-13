import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/functions';
import { gmailLink, loadAccounts, type Account } from '../lib/accounts';

// Milestone 2 — shadow mode. See how every inbox thread was sorted, what WOULD be
// archived, what it cost, and correct anything that's wrong. Nothing here changes mail.

type Thread = {
  account_id: string; thread_id: string; subject: string | null; from_name: string | null;
  summary: string | null; reason: string | null; bucket: 1 | 2 | 3 | null; priority: boolean;
  category: string | null; classified_by: string | null; user_bucket: 1 | 2 | 3 | null;
  last_message_at: string | null; last_from_me: boolean | null; group_key: string | null;
};
type Run = {
  id: string; account_id: string; trigger: string; status: string;
  started_at: string; finished_at: string | null; stats: Record<string, number>; error: string | null;
};
type Filter = 'all' | 3 | 2 | 1 | 'priority' | 'corrected';

const BUCKET_LABEL = { 1: 'Junk', 2: 'Glance', 3: 'Real' } as const;
const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

// What the archive step will do once it's on (M4): bucket 1 everywhere,
// bucket 2 too except on junk-only inboxes. Bucket 3 never.
const wouldArchive = (t: Thread, a?: Account) =>
  t.bucket === 1 || (t.bucket === 2 && a?.policy !== 'junk_only');

export default function Review() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [monthCost, setMonthCost] = useState(0);
  const [filter, setFilter] = useState<Filter>(3);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  const byId = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  const load = useCallback(async () => {
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const [t, r, u] = await Promise.all([
      supabase.from('email_threads')
        .select('account_id, thread_id, subject, from_name, summary, reason, bucket, priority, category, classified_by, user_bucket, last_message_at, last_from_me, group_key')
        .eq('in_inbox', true).eq('status', 'classified')
        .order('last_message_at', { ascending: false }).limit(1000),
      supabase.from('sync_runs').select('*').order('started_at', { ascending: false }).limit(10),
      supabase.from('ai_usage').select('cost_usd').gte('created_at', monthStart.toISOString()).limit(10000),
    ]);
    if (t.error) setError(t.error.message);
    setThreads((t.data ?? []) as Thread[]);
    setRuns((r.data ?? []) as Run[]);
    setMonthCost((u.data ?? []).reduce((s, x) => s + Number(x.cost_usd), 0));
  }, []);

  useEffect(() => { loadAccounts().then(setAccounts); load(); }, [load]);

  // While a sync is running, refresh every 5 seconds
  const running = runs.some(r => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [running, load]);

  async function syncNow() {
    setSyncing(true); setError('');
    try {
      await callFn('sync-run');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed to start');
    }
    setSyncing(false);
  }

  async function correct(t: Thread, b: 1 | 2 | 3) {
    const next = t.user_bucket === b ? null : b; // tap again to clear
    setThreads(ts => ts?.map(x => (x === t ? { ...x, user_bucket: next } : x)) ?? null);
    const { error } = await supabase.from('email_threads').update({ user_bucket: next })
      .eq('account_id', t.account_id).eq('thread_id', t.thread_id);
    if (error) setError(error.message);
  }

  const counts = useMemo(() => {
    const ts = threads ?? [];
    return {
      all: ts.length,
      3: ts.filter(t => t.bucket === 3).length,
      2: ts.filter(t => t.bucket === 2).length,
      1: ts.filter(t => t.bucket === 1).length,
      priority: ts.filter(t => t.priority).length,
      corrected: ts.filter(t => t.user_bucket && t.user_bucket !== t.bucket).length,
      archive: ts.filter(t => wouldArchive(t, byId.get(t.account_id))).length,
    };
  }, [threads, byId]);

  const shown = (threads ?? []).filter(t =>
    filter === 'all' ? true
    : filter === 'priority' ? t.priority
    : filter === 'corrected' ? t.user_bucket && t.user_bucket !== t.bucket
    : t.bucket === filter);

  // Latest run per account
  const latest = accounts.map(a => ({ a, r: runs.find(r => r.account_id === a.id) }));

  return (
    <section className="stack-lg">
      <div className="stack">
        <div className="section-head">
          <h2>Review sorting</h2>
          <button className="pill" disabled={syncing || running} onClick={syncNow}>
            {running ? 'Syncing…' : syncing ? 'Starting…' : 'Sync now'}
          </button>
        </div>
        <p className="notice">
          Shadow mode: nothing in your mail changes yet. {counts.archive} of {counts.all} inbox threads would be archived.
        </p>
        {error && <p className="error">{error}</p>}

        <ul className="list">
          {latest.map(({ a, r }) => (
            <li key={a.id} className="row">
              <div className="row-main">
                <div className="row-title ellipsis">{a.email}</div>
                <div className="muted small">
                  {!r ? 'Not synced yet'
                    : r.status === 'running' ? `Syncing… ${r.stats.sorted ?? 0} sorted so far`
                    : r.status === 'error' ? `Failed ${ago(r.started_at)}: ${r.error}`
                    : `${ago(r.finished_at ?? r.started_at)} · ${r.stats.inbox_threads ?? 0} in inbox · `
                      + `${r.stats.by_rule ?? 0} by rule, ${r.stats.by_ai ?? 0} by AI · ${money(r.stats.cost_usd ?? 0)}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <p className="muted small">Claude cost this month: {money(monthCost)}</p>
      </div>

      <div className="stack">
        <div className="chips">
          {([['Real', 3], ['Glance', 2], ['Junk', 1], ['Priority', 'priority'], ['Corrected', 'corrected'], ['All', 'all']] as const)
            .map(([label, f]) => (
              <button key={label} className={filter === f ? 'chip active' : 'chip'} onClick={() => setFilter(f)}>
                {label} <span className="muted">{counts[f]}</span>
              </button>
            ))}
        </div>

        {!threads ? <p className="muted">Loading…</p>
          : shown.length === 0 ? <p className="muted">Nothing here.</p>
          : (
            <ul className="list">
              {shown.map(t => {
                const acct = byId.get(t.account_id);
                return (
                  <li key={t.account_id + t.thread_id} className="row review-row">
                    <div className="row-main">
                      <div className="row-top">
                        {t.priority && <span className="flag">Priority</span>}
                        <a className="row-title ellipsis" href={acct ? gmailLink(acct.email, t.thread_id) : '#'}
                           target="_blank" rel="noreferrer">{t.from_name}</a>
                        <span className="muted small push">{t.last_message_at ? ago(t.last_message_at) : ''}</span>
                      </div>
                      <div className="ellipsis">{t.subject}</div>
                      {t.summary && <div className="small">{t.summary}</div>}
                      <div className="muted small">
                        {t.classified_by === 'rule' ? 'Rule' : t.classified_by === 'ai' ? 'AI' : 'Fallback'}: {t.reason}
                        {t.last_from_me ? ' · you replied last' : ''}
                        {acct ? ` · ${acct.email.split('@')[0]}` : ''}
                        {wouldArchive(t, acct) ? ' · would archive' : ''}
                      </div>
                    </div>
                    <div className="bucket-pick" aria-label="Correct the bucket">
                      {([3, 2, 1] as const).map(b => (
                        <button key={b}
                          className={['bp', t.bucket === b ? 'is-sorted' : '', t.user_bucket === b ? 'is-yours' : ''].join(' ')}
                          title={t.bucket === b ? `Sorted as ${BUCKET_LABEL[b]}` : `Should be ${BUCKET_LABEL[b]}`}
                          onClick={() => correct(t, b)}>
                          {BUCKET_LABEL[b]}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
    </section>
  );
}
