import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { undo } from '../lib/actions';
import { gmailLink, type Account } from '../lib/accounts';

// "Where did that email go?" — everything rlyfe changed in Gmail in the last 7 days,
// newest first, each with Undo. Undoing a morning-sync archive also marks it Real
// (which teaches rlyfe about that sender).
type Entry = {
  id: number; account_id: string; thread_id: string | null; action: string; source: string;
  reason: string | null; created_at: string; undone_at: string | null;
  payload: { subject?: string; from_name?: string; from_email?: string; sender?: string };
};

const LABEL: Record<string, string> = {
  archive: 'Archived', create_filter: 'Always ignore', snooze: 'Snoozed',
};

export default function Activity({ accounts }: { accounts: Map<string, Account> }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [only, setOnly] = useState<'sync' | 'all'>('sync');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    let q = supabase.from('action_log').select('*')
      .in('action', ['archive', 'create_filter', 'snooze']).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(300);
    if (only === 'sync') q = q.eq('source', 'sync');
    const { data, error } = await q;
    if (error) setError(error.message);
    setEntries((data ?? []) as Entry[]);
  }, [only]);

  useEffect(() => { load(); }, [load]);

  async function doUndo(e: Entry) {
    setBusy(e.id); setError('');
    try { await undo(e.id); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Undo failed'); }
    setBusy(null);
  }

  const live = (entries ?? []).filter(e => !e.undone_at);

  return (
    <div className="stack">
      <div className="section-head">
        <h3>Activity · last 7 days</h3>
        <div className="chips">
          <button className={only === 'sync' ? 'chip active' : 'chip'} onClick={() => setOnly('sync')}>Auto-archived</button>
          <button className={only === 'all' ? 'chip active' : 'chip'} onClick={() => setOnly('all')}>Everything</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!entries ? <p className="muted small">Loading…</p>
        : live.length === 0 ? <p className="muted small">{only === 'sync' ? 'The morning sync hasn’t archived anything.' : 'Nothing yet.'}</p>
        : (
          <ul className="list">
            {live.map(e => {
              const acct = accounts.get(e.account_id);
              const title = e.action === 'create_filter'
                ? `Gmail filter for ${e.payload.sender}`
                : e.payload.subject || '(no subject)';
              return (
                <li key={e.id} className="row">
                  <div className="row-main">
                    <div className="row-top">
                      <span className="small muted">{LABEL[e.action] ?? e.action}</span>
                      <span className="muted small push">
                        {new Date(e.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                    {acct && e.thread_id
                      ? <a className="ellipsis row-link" href={gmailLink(acct.email, e.thread_id)} target="_blank" rel="noreferrer">{title}</a>
                      : <div className="ellipsis">{title}</div>}
                    <div className="muted small ellipsis">
                      {e.payload.from_name ? `${e.payload.from_name} · ` : ''}{e.reason}
                      {e.source === 'sync' ? ' · morning sync' : ''}
                    </div>
                  </div>
                  <button className="pill" disabled={busy === e.id} onClick={() => doUndo(e)}>
                    {busy === e.id ? '…' : e.source === 'sync' ? 'Put back' : 'Undo'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
