import { useEffect, useState } from 'react';
import { callFn } from '../lib/functions';
import { supabase } from '../lib/supabase';

// One-time "clean up old mail" for a Yahoo / iCloud / AOL account.
// Preview first (changes nothing) → confirm → archive in chunks with progress → Undo any time.
type Preview = {
  cutoff: string; totalOld: number; toArchive: number; unreadToArchive: number; keep: number;
  keepReasons: Record<string, number>;
  topArchived: { sender: string; count: number }[];
  keptSamples: { from: string; subject: string; date: string; why: string }[];
};
type Batch = { id: string; status: string; archived: number; kept: number; restored: number; created_at: string; cutoff: string };

const CUTOFFS = [
  { days: 30, label: 'Older than 30 days' },
  { days: 90, label: 'Older than 3 months' },
  { days: 180, label: 'Older than 6 months' },
  { days: 365, label: 'Older than 1 year' },
];
const fmt = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

export default function OldMailCleanup({ accountId, email }: { accountId: string; email: string }) {
  const [days, setDays] = useState(90);
  const [prev, setPrev] = useState<Preview | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [last, setLast] = useState<Batch | null>(null);

  const loadLast = () => supabase.from('cleanup_batches')
    .select('id, status, archived, kept, restored, created_at, cutoff')
    .eq('account_id', accountId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    .then(({ data }) => setLast(data));
  useEffect(() => { loadLast(); }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => {
    const m = e instanceof Error ? e.message : 'failed';
    setError(m === 'needs-reconnect' ? 'The sign-in for this account stopped working — reconnect it.' : `Something went wrong (${m}).`);
  };

  async function preview() {
    setBusy('Looking through old mail…'); setError(''); setPrev(null);
    try { setPrev(await callFn<Preview>('old-mail', { action: 'preview', accountId, cutoffDays: days })); }
    catch (e) { fail(e); }
    finally { setBusy(''); }
  }

  async function run() {
    if (!prev) return;
    if (!confirm(`Archive ${prev.toArchive.toLocaleString()} old emails in ${email}?\n\n`
      + `They move to the Archive folder and are marked read — nothing is deleted. `
      + `${prev.keep.toLocaleString()} stay in your inbox. You can undo the whole cleanup.`)) return;
    setError('');
    let batchId: string | undefined;
    try {
      for (;;) {
        const r = await callFn<{ batchId: string; archived: number; remaining: number }>(
          'old-mail', { action: 'run', accountId, cutoffDays: days, batchId });
        batchId = r.batchId;
        setBusy(`Archiving… ${r.archived.toLocaleString()} done${r.remaining ? `, ${r.remaining.toLocaleString()} to go` : ''}`);
        if (!r.remaining) break;
      }
      setPrev(null);
    } catch (e) { fail(e); }
    finally { setBusy(''); loadLast(); }
  }

  async function undo() {
    if (!last || !confirm(`Put back the ${last.archived.toLocaleString()} emails this cleanup archived?`)) return;
    setError('');
    try {
      for (;;) {
        const r = await callFn<{ restored: number; remaining: number }>('old-mail', { action: 'undo', accountId, batchId: last.id });
        setBusy(`Putting back… ${r.restored.toLocaleString()} done`);
        if (!r.remaining) break;
      }
    } catch (e) { fail(e); }
    finally { setBusy(''); loadLast(); }
  }

  return (
    <div className="cleanup">
      <p className="muted small">
        Archives old inbox mail in one go. Keeps anything you <strong>starred</strong>, mail from <strong>people you’ve
        written to</strong>, and senders you’ve marked <strong>Important</strong>. Nothing is deleted.
      </p>

      {last && last.status !== 'undone' && (
        <p className="notice cleanup-last">
          {last.status === 'done' ? 'Last cleanup' : 'Unfinished cleanup'} ({fmt(last.created_at)}):
          {' '}{last.archived.toLocaleString()} archived, {last.kept.toLocaleString()} kept.
          {' '}<button className="link" disabled={!!busy} onClick={undo}>Undo it</button>
        </p>
      )}

      <div className="row-buttons">
        <select value={days} disabled={!!busy} onChange={e => { setDays(Number(e.target.value)); setPrev(null); }}>
          {CUTOFFS.map(c => <option key={c.days} value={c.days}>{c.label}</option>)}
        </select>
        <button disabled={!!busy} onClick={preview}>Preview</button>
      </div>

      {busy && <p className="muted">{busy}</p>}
      {error && <p className="error">{error}</p>}

      {prev && !busy && (
        prev.totalOld === 0 ? <p className="muted small">No inbox mail older than that. Nothing to do.</p> : (
          <div className="stack cleanup-preview">
            <p>
              <strong>{prev.totalOld.toLocaleString()}</strong> inbox emails are older than {fmt(prev.cutoff)}.
              {' '}<strong>{prev.toArchive.toLocaleString()}</strong> would be archived
              {prev.unreadToArchive ? ` (${prev.unreadToArchive.toLocaleString()} unread)` : ''},
              {' '}<strong>{prev.keep.toLocaleString()}</strong> kept.
            </p>
            {prev.keep > 0 && (
              <p className="muted small">
                Kept because: {Object.entries(prev.keepReasons).map(([why, n]) => `${why} (${n})`).join(' · ')}
              </p>
            )}
            {prev.topArchived.length > 0 && (
              <details>
                <summary className="small">Who most of the archived mail is from</summary>
                <ul className="small cleanup-list">
                  {prev.topArchived.map(t => <li key={t.sender}>{t.sender} <span className="muted">· {t.count}</span></li>)}
                </ul>
              </details>
            )}
            {prev.keptSamples.length > 0 && (
              <details>
                <summary className="small">What stays (first {prev.keptSamples.length})</summary>
                <ul className="small cleanup-list">
                  {prev.keptSamples.map((k, i) => (
                    <li key={i}>{k.from} — {k.subject || '(no subject)'} <span className="muted">· {k.why}</span></li>
                  ))}
                </ul>
              </details>
            )}
            {prev.toArchive > 0 && (
              <button className="primary" onClick={run}>Archive {prev.toArchive.toLocaleString()} emails</button>
            )}
            <p className="muted small">Afterward, tap Sync now on Review — the emails you kept will be sorted into your tabs.</p>
          </div>
        )
      )}
    </div>
  );
}
