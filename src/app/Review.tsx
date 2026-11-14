import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/functions';
import { gmailLink, loadAccounts, type Account } from '../lib/accounts';
import Activity from './Activity';

// Review = training rlyfe's sorting. Work through "To check" by confirming or correcting
// each thread; checked ones move under Real / Glance / Junk. Nothing here changes mail.

type Thread = {
  account_id: string; thread_id: string; subject: string | null; from_name: string | null; from_email: string | null;
  summary: string | null; reason: string | null; bucket: 1 | 2 | 3 | null; priority: boolean;
  category: string | null; classified_by: string | null; user_bucket: 1 | 2 | 3 | null;
  last_message_at: string | null; last_from_me: boolean | null; group_key: string | null;
};
type Run = {
  id: string; account_id: string; trigger: string; status: string;
  started_at: string; finished_at: string | null; stats: Record<string, number>; error: string | null;
};
type Pref = { sender_email: string; bucket: 1 | 2 | 3; votes_1: number; votes_2: number; votes_3: number };
type Filter = 'check' | 3 | 2 | 1;

// The Review queue: every inbox thread starts "to check". Tapping Real / Glance / Junk
// (confirm or correct) checks it — it slides out of the queue and lives under that tab.
// Threads sorted by a sender you've already taught (classified_by 'learned') count as checked.
const effective = (t: Thread) => (t.user_bucket ?? t.bucket) as 1 | 2 | 3 | null;
const isChecked = (t: Thread) => t.user_bucket != null || t.classified_by === 'learned';
// The queue is only what the morning cleanup could archive (Junk + Glance). Real is
// already on your to-do list — a wrong one there costs nothing, you just Ignore it.
const inQueue = (t: Thread) => !isChecked(t) && (effective(t) === 1 || effective(t) === 2);

// Group the queue by company (email domain) so one tap can settle e.g. all of linkedin.com.
// Personal mail domains group by exact address instead — one gmail.com friend ≠ another.
const PERSONAL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'att.net', 'sbcglobal.net', 'comcast.net', 'verizon.net']);
type Group = { key: string; isDomain: boolean; threads: Thread[] };
function groupQueue(ts: Thread[]): Group[] {
  const map = new Map<string, Group>();
  for (const t of ts) {
    const domain = (t.from_email ?? '').split('@')[1] ?? '';
    const isDomain = !!domain && !PERSONAL.has(domain);
    const key = isDomain ? domain : (t.from_email ?? '(unknown)');
    if (!map.has(key)) map.set(key, { key, isDomain, threads: [] });
    map.get(key)!.threads.push(t);
  }
  return [...map.values()].sort((a, b) => b.threads.length - a.threads.length);
}
type GroupUndo = { key: string; isDomain: boolean; ids: { account_id: string; thread_id: string }[]; text: string };

const BUCKET_LABEL = { 1: 'Junk', 2: 'Glance', 3: 'Real' } as const;
const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

// What the archive step will do once it's on (M4): bucket 1 everywhere,
// bucket 2 too except on junk-only inboxes. Bucket 3 never.
// (Shadow preview: a read-only account is previewed as if it were on full cleanup.)
const wouldArchive = (t: Thread, a?: Account) => {
  const b = t.user_bucket ?? t.bucket;
  return !t.priority && !t.last_from_me && (b === 1 || (b === 2 && a?.policy !== 'junk_only'));
};
// What the next sync will actually archive, given each account's real policy
const willArchive = (t: Thread, a?: Account) => !!a && a.policy !== 'read_only' && wouldArchive(t, a);

export default function Review() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [monthCost, setMonthCost] = useState(0);
  const [filter, setFilter] = useState<Filter>('check');
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [checkedNow, setCheckedNow] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [groupUndo, setGroupUndo] = useState<GroupUndo | null>(null);
  const [domainPrefs, setDomainPrefs] = useState<{ domain: string; bucket: 1 | 2 | 3 }[]>([]);
  const [prefs, setPrefs] = useState<Pref[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [learnedMsg, setLearnedMsg] = useState('');

  const byId = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  const load = useCallback(async () => {
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const [t, r, u, p, d] = await Promise.all([
      supabase.from('email_threads')
        .select('account_id, thread_id, subject, from_name, from_email, summary, reason, bucket, priority, category, classified_by, user_bucket, last_message_at, last_from_me, group_key')
        .eq('in_inbox', true).eq('status', 'classified')
        .order('last_message_at', { ascending: false }).limit(1000),
      supabase.from('sync_runs').select('*').order('started_at', { ascending: false }).limit(10),
      supabase.from('ai_usage').select('cost_usd').gte('created_at', monthStart.toISOString()).limit(10000),
      supabase.from('sender_prefs').select('sender_email, bucket, votes_1, votes_2, votes_3')
        .not('bucket', 'is', null).order('updated_at', { ascending: false }),
      supabase.from('domain_prefs').select('domain, bucket').order('updated_at', { ascending: false }),
    ]);
    if (t.error) setError(t.error.message);
    setThreads((t.data ?? []) as Thread[]);
    setPrefs((p.data ?? []) as Pref[]);
    setDomainPrefs((d.data ?? []) as { domain: string; bucket: 1 | 2 | 3 }[]);
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

  // Confirming or correcting checks the thread: it slides out of the current list and
  // shows up under its tab. It also teaches rlyfe the sender (database trigger), which
  // re-sorts — and checks — that sender's other inbox threads right away.
  // In a Real/Glance/Junk tab, tapping the bucket it's already in un-checks it (back to the queue).
  async function pick(t: Thread, b: 1 | 2 | 3) {
    const k = t.account_id + t.thread_id;
    const uncheck = filter !== 'check' && t.user_bucket === b;
    const next = uncheck ? null : b;
    const corrected = next != null && next !== t.bucket;

    setLeaving(s => new Set(s).add(k));
    const { error } = await supabase.from('email_threads').update({ user_bucket: next })
      .eq('account_id', t.account_id).eq('thread_id', t.thread_id);
    if (error) {
      setLeaving(s => { const n = new Set(s); n.delete(k); return n; });
      return setError(error.message);
    }
    if (!uncheck && filter === 'check') setCheckedNow(n => n + 1);

    // Let the slide-out play, then refresh (picks up other threads the learning moved)
    const before = (threads ?? []).filter(x => x.from_email === t.from_email && x !== t && isChecked(x)).length;
    await new Promise(r => setTimeout(r, 250));
    await load();
    setLeaving(s => { const n = new Set(s); n.delete(k); return n; });

    if (corrected && t.from_email) {
      const { count } = await supabase.from('email_threads').select('thread_id', { count: 'exact', head: true })
        .eq('from_email', t.from_email).eq('in_inbox', true).eq('classified_by', 'learned');
      const moved = Math.max(0, (count ?? 0) - before);
      setLearnedMsg(`Got it — ${t.from_name ?? t.from_email} → ${BUCKET_LABEL[next!]} from now on`
        + (moved ? `, and ${moved} more from them moved too.` : '.'));
    } else {
      setLearnedMsg('');
    }
  }

  // One tap for a whole group. Companies go through review_domain (also remembers the
  // domain for future mail); a personal address is just its own threads. Never touches
  // priority mail or conversations you're in.
  async function groupPick(g: Group, b: 1 | 2 | 3) {
    setError(''); setLearnedMsg('');
    let ids: { account_id: string; thread_id: string }[] = [];
    if (g.isDomain) {
      const { data, error } = await supabase.rpc('review_domain', { p_domain: g.key, p_bucket: b });
      if (error) return setError(error.message);
      ids = (data ?? []) as typeof ids;
    } else {
      ids = g.threads.filter(t => !t.priority && !t.last_from_me)
        .map(t => ({ account_id: t.account_id, thread_id: t.thread_id }));
      for (const acct of new Set(ids.map(i => i.account_id))) {
        const { error } = await supabase.from('email_threads').update({ user_bucket: b })
          .eq('account_id', acct).in('thread_id', ids.filter(i => i.account_id === acct).map(i => i.thread_id));
        if (error) return setError(error.message);
      }
    }
    setCheckedNow(n => n + ids.length);
    setGroupUndo({
      key: g.key, isDomain: g.isDomain, ids,
      text: g.isDomain
        ? `All ${ids.length} from ${g.key} → ${BUCKET_LABEL[b]}. New mail from ${g.key} will be sorted that way too.`
        : `${ids.length} from ${g.key} → ${BUCKET_LABEL[b]}.`,
    });
    await load();
  }

  async function undoGroup() {
    const u = groupUndo;
    if (!u) return;
    setGroupUndo(null);
    if (u.isDomain) {
      const { error } = await supabase.rpc('unreview_threads', { p_domain: u.key, p_threads: u.ids });
      if (error) setError(error.message);
    } else {
      for (const acct of new Set(u.ids.map(i => i.account_id))) {
        await supabase.from('email_threads').update({ user_bucket: null })
          .eq('account_id', acct).in('thread_id', u.ids.filter(i => i.account_id === acct).map(i => i.thread_id));
      }
    }
    setCheckedNow(n => Math.max(0, n - u.ids.length));
    await load();
  }

  async function forgetDomain(domain: string) {
    if (!confirm(`Stop sorting everything from ${domain} the same way? New mail from it goes back to normal sorting.`)) return;
    const { error } = await supabase.from('domain_prefs').delete().eq('domain', domain);
    if (error) return setError(error.message);
    setDomainPrefs(ds => ds.filter(x => x.domain !== domain));
  }

  async function forget(p: Pref) {
    if (!confirm(`Stop sorting ${p.sender_email} as ${BUCKET_LABEL[p.bucket]}? Its mail gets re-sorted on the next sync.`)) return;
    const { error } = await supabase.from('sender_prefs').delete().eq('sender_email', p.sender_email);
    if (error) return setError(error.message);
    setPrefs(ps => ps.filter(x => x !== p));
  }

  const counts = useMemo(() => {
    const ts = threads ?? [];
    const checked = ts.filter(isChecked);
    return {
      all: ts.length,
      check: ts.filter(inQueue).length,
      3: checked.filter(t => effective(t) === 3).length,
      2: checked.filter(t => effective(t) === 2).length,
      1: checked.filter(t => effective(t) === 1).length,
      archive: ts.filter(t => wouldArchive(t, byId.get(t.account_id))).length,
      willArchive: ts.filter(t => willArchive(t, byId.get(t.account_id))).length,
    };
  }, [threads, byId]);

  const byNewest = (a: Thread, b: Thread) => Date.parse(b.last_message_at ?? '0') - Date.parse(a.last_message_at ?? '0');
  const shown = (threads ?? [])
    .filter(t => (filter === 'check' ? inQueue(t) : isChecked(t) && effective(t) === filter))
    .sort(byNewest);
  // To check: biggest companies first, so the first few taps clear the most
  const groups = useMemo(() => groupQueue((threads ?? []).filter(inQueue).sort(byNewest)), [threads]);

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
        {accounts.every(a => a.policy === 'read_only') ? (
          <p className="notice">
            Shadow mode: the morning sync doesn't change your mail. {counts.archive} of {counts.all} inbox threads would be archived.
            Turn on cleanup per account in Settings.
          </p>
        ) : (
          <p className="notice">
            Cleanup is on for {accounts.filter(a => a.policy !== 'read_only').length} account(s).
            The next sync will archive {counts.willArchive} threads still sitting in the inbox. Anything archived shows below under Activity.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {learnedMsg && <p className="notice" onClick={() => setLearnedMsg('')}>{learnedMsg}</p>}

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
          {([['To check', 'check'], ['Real', 3], ['Glance', 2], ['Junk', 1]] as const)
            .map(([label, f]) => (
              <button key={label} className={filter === f ? 'chip active' : 'chip'} onClick={() => { setFilter(f); setLearnedMsg(''); }}>
                {label} <span className="muted">{counts[f]}</span>
              </button>
            ))}
        </div>

        {filter === 'check' ? (
          <p className="muted small">
            {counts.check} Junk &amp; Glance left to check{checkedNow ? ` · ${checkedNow} checked just now` : ''}.
            One tap on a company card sorts all of it. ✓ marks how rlyfe sorted it. Nothing here changes your mail.
          </p>
        ) : (
          <p className="muted small">
            Checked as {BUCKET_LABEL[filter]}. Tap {BUCKET_LABEL[filter]} again to send one back to “To check”, or another bucket to move it.
          </p>
        )}

        {groupUndo && (
          <p className="notice undo-line">
            <span>{groupUndo.text}</span>
            <button className="link" onClick={undoGroup}>Undo</button>
          </p>
        )}

        {!threads ? <p className="muted">Loading…</p>
          : shown.length === 0 ? (
            filter === 'check'
              ? <p className="notice">Nothing to check — rlyfe is sorting the way you would.</p>
              : <p className="muted">Nothing checked as {BUCKET_LABEL[filter]} yet.</p>
          ) : filter === 'check' ? (
            <ul className="list">
              {groups.map(g => {
                if (g.threads.length === 1) return renderRow(g.threads[0]);
                const n1 = g.threads.filter(t => effective(t) === 1).length;
                const n2 = g.threads.length - n1;
                const major: 1 | 2 = n1 >= n2 ? 1 : 2;
                const names = [...new Set(g.threads.map(t => t.from_name || t.from_email))].slice(0, 3).join(', ');
                const isOpen = open.has(g.key);
                return [
                  <li key={`g:${g.key}`} className="row review-row group-card">
                    <div className="row-main">
                      <div className="row-top">
                        <span className="row-title ellipsis">{g.key}</span>
                        <span className="muted small push">{g.threads.length} emails</span>
                      </div>
                      <div className="muted small">
                        rlyfe sorted {[n1 && `${n1} Junk`, n2 && `${n2} Glance`].filter(Boolean).join(' · ')}
                      </div>
                      <div className="small ellipsis">{names}</div>
                      <button className="link small show-each"
                              onClick={() => setOpen(s => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}>
                        {isOpen ? 'Hide' : 'Show each'}
                      </button>
                    </div>
                    <div className="bucket-pick" aria-label={`Sort all of ${g.key}`}>
                      {([3, 2, 1] as const).map(b => (
                        <button key={b} className={['bp', b === major ? 'is-sorted' : ''].join(' ')}
                                title={`All ${g.threads.length} → ${BUCKET_LABEL[b]}`}
                                onClick={() => groupPick(g, b)}>
                          {b === major ? `✓ ${BUCKET_LABEL[b]}` : BUCKET_LABEL[b]}
                        </button>
                      ))}
                    </div>
                  </li>,
                  ...(isOpen ? g.threads.map(t => renderRow(t, true)) : []),
                ];
              })}
            </ul>
          ) : (
            <ul className="list">
              {shown.map(t => renderRow(t))}
            </ul>
          )}
      </div>

      <Activity accounts={byId} />

      <div className="stack">
        <h3>What rlyfe has learned</h3>
        {prefs.length === 0 && domainPrefs.length === 0 ? (
          <p className="muted small">Nothing yet. Check a few emails above and rlyfe remembers those senders.</p>
        ) : (
          <ul className="list">
            {domainPrefs.map(d => (
              <li key={`d:${d.domain}`} className="row">
                <div className="row-main">
                  <div className="ellipsis">Everything from {d.domain}</div>
                  <div className="muted small">Always {BUCKET_LABEL[d.bucket]} · company-wide</div>
                </div>
                <button className="link" onClick={() => forgetDomain(d.domain)}>Forget</button>
              </li>
            ))}
            {prefs.map(p => (
              <li key={p.sender_email} className="row">
                <div className="row-main">
                  <div className="ellipsis">{p.sender_email}</div>
                  <div className="muted small">
                    Always {BUCKET_LABEL[p.bucket]} · from {p.votes_1 + p.votes_2 + p.votes_3} check{p.votes_1 + p.votes_2 + p.votes_3 > 1 ? 's' : ''}
                  </div>
                </div>
                <button className="link" onClick={() => forget(p)}>Forget</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );

  // One thread row (used in every list; nested = shown under an expanded group card)
  function renderRow(t: Thread, nested = false) {
                const acct = byId.get(t.account_id);
                const k = t.account_id + t.thread_id;
                return (
                  <li key={k} className={['row review-row', nested ? 'nested' : '', leaving.has(k) ? 'leaving' : ''].join(' ')}>
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
                        {{ rule: 'Rule', ai: 'AI', learned: 'Learned', fallback: 'Fallback' }[t.classified_by ?? 'fallback'] ?? 'Sorted'}: {t.reason}
                        {t.last_from_me ? ' · you replied last' : ''}
                        {acct ? ` · ${acct.email.split('@')[0]}` : ''}
                        {wouldArchive(t, acct) ? ' · would archive' : ''}
                      </div>
                    </div>
                    <div className="bucket-pick" aria-label="Correct the bucket">
                      {([3, 2, 1] as const).map(b => {
                        const mine = filter === 'check' ? t.bucket === b : effective(t) === b;
                        return (
                          <button key={b} disabled={leaving.has(k)}
                            className={['bp', mine ? (filter === 'check' ? 'is-sorted' : 'is-yours') : ''].join(' ')}
                            title={filter === 'check'
                              ? (mine ? `Confirm ${BUCKET_LABEL[b]}` : `Change to ${BUCKET_LABEL[b]}`)
                              : (mine ? 'Send back to To check' : `Move to ${BUCKET_LABEL[b]}`)}
                            onClick={() => pick(t, b)}>
                            {filter === 'check' && mine ? `✓ ${BUCKET_LABEL[b]}` : BUCKET_LABEL[b]}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                );
  }
}
