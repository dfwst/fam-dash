import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/functions';
import { UNSUB_ERRORS, unsubLabel, unsubscribeRetireItem } from '../lib/unsubscribe';

// Per-item unsubscribe progress on this page
type UnsubState = { busy?: boolean; msg?: string; url?: string; error?: boolean };

// "Retire this address": everyone who still has this email address, and your progress moving
// them to a new one. Built from a header scan of the whole mailbox; while "retiring" is on,
// anyone who emails the old address again is flagged at the top.
type Kind = 'update' | 'unsubscribe' | 'person' | 'ignore';
type Item = {
  id: string; group_key: string; name: string; kind: Kind; reason: string | null;
  message_count: number; first_seen: string | null; last_seen: string | null; samples: string[];
  sender: string | null; unsubscribe: string | null; status: 'todo' | 'done' | 'skipped';
  flagged_at: string | null; unsubscribed_at: string | null; unsubscribe_method: string | null;
};
type Acct = { id: string; email: string; nickname: string | null; retiring: boolean; retire_scanned_at: string | null };
type Scan = { messages: number; groups: number; partial: boolean; update: number; unsubscribe: number; person: number; ignore: number; cost: number };

const SECTIONS: { kind: Kind; title: string; help: string; doneLabel: string }[] = [
  { kind: 'update', title: 'Change your email here', help: 'Accounts tied to this address. Log in to each and switch to your new email.', doneLabel: 'Updated' },
  { kind: 'person', title: 'Tell these people', help: 'Real people who email this address.', doneLabel: 'Told them' },
  { kind: 'unsubscribe', title: 'Just unsubscribe', help: 'Mailing lists with no account — unsubscribe, or simply let them go.', doneLabel: 'Done' },
  { kind: 'ignore', title: 'Nothing to do', help: 'Old one-offs, spam, and likely phishing — never update your email at these.', doneLabel: 'OK' },
];
const KIND_NAME: Record<Kind, string> = { update: 'Change email', person: 'Tell them', unsubscribe: 'Unsubscribe', ignore: 'Nothing to do' };

const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  return days < 60 ? `${Math.max(1, Math.round(days))}d ago` : d.toLocaleDateString([], { month: 'short', year: 'numeric' });
};

export default function Retire() {
  const { accountId = '' } = useParams();
  const [acct, setAcct] = useState<Acct | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState<Set<Kind>>(new Set(['update', 'person']));
  const [unsub, setUnsub] = useState<Record<string, UnsubState>>({});
  const [bulk, setBulk] = useState('');

  // One sender: one-click / email happen on the server; a web-page-only sender gets a link to open
  async function unsubscribeOne(it: Item): Promise<boolean> {
    setUnsub(s => ({ ...s, [it.id]: { busy: true } }));
    try {
      const r = await unsubscribeRetireItem(it.id);
      setUnsub(s => ({ ...s, [it.id]: { msg: unsubLabel(r), url: r.url, error: !r.ok && r.method !== 'link' } }));
      if (r.ok) {
        const now = new Date().toISOString();
        setItems(list => list?.map(x => (x.id === it.id ? { ...x, status: 'done', unsubscribed_at: now, unsubscribe_method: r.method } : x)) ?? null);
      }
      return r.ok;
    } catch (e) {
      const m = e instanceof Error ? e.message : 'failed';
      setUnsub(s => ({ ...s, [it.id]: { msg: UNSUB_ERRORS[m] ?? `Couldn’t unsubscribe (${m}).`, error: true } }));
      return false;
    }
  }

  async function unsubscribeAll(list: Item[]) {
    if (!confirm(`Unsubscribe from ${list.length} mailing lists?\n\nrlyfe uses each sender’s official unsubscribe (one-click or email). `
      + 'Senders that only offer a web page are left for you to open.')) return;
    let done = 0;
    for (const it of list) {
      setBulk(`Unsubscribing… ${done} of ${list.length}`);
      if (await unsubscribeOne(it)) done++;
    }
    setBulk(`Unsubscribed from ${done} of ${list.length}. Any left need their page opened (links below).`);
  }

  const [loadError, setLoadError] = useState('');
  const load = useCallback(async () => {
    setLoadError('');
    // Never sit on "Loading…" forever: give up after 15s and offer Try again
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 15_000));
    try {
      const [{ data: a, error: e1 }, { data: it, error: e2 }] = await Promise.race([Promise.all([
        supabase.from('connected_accounts').select('id, email, nickname, retiring, retire_scanned_at').eq('id', accountId).maybeSingle(),
        supabase.from('retire_items').select('*').eq('account_id', accountId)
          .order('flagged_at', { ascending: false, nullsFirst: false }).order('last_seen', { ascending: false }),
      ]), timeout]);
      if (e1 || e2) throw e1 ?? e2;
      if (!a) throw new Error('account not found');
      setAcct(a as Acct);
      setItems((it ?? []) as Item[]);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'failed');
    }
  }, [accountId]);
  useEffect(() => { load(); }, [load]);

  async function runScan() {
    setBusy(true); setError(''); setScan(null);
    try {
      // Big mailboxes take several rounds: start → step… → finish (Claude sorts the senders)
      const s0 = await callFn<{ read: number; total: number }>('retire-scan', { accountId, action: 'start' });
      setProgress(`Reading headers… 0 of ${s0.total.toLocaleString()} emails`);
      for (;;) {
        const r = await callFn<{ read: number; total: number; done: boolean }>('retire-scan', { accountId, action: 'step' });
        setProgress(`Reading headers… ${Math.min(r.read, r.total).toLocaleString()} of ${r.total.toLocaleString()} emails`);
        if (r.done) break;
      }
      setProgress('Sorting senders with Claude…');
      setScan(await callFn<Scan>('retire-scan', { accountId, action: 'finish' }));
      if (acct && !acct.retiring) await setRetiring(true);
      await load();
    } catch (e) {
      const m = e instanceof Error ? e.message : 'failed';
      setError(m === 'needs-reconnect' ? 'This account needs reconnecting in Settings first.' : `The scan didn't finish (${m}). Try again.`);
    } finally { setBusy(false); setProgress(''); }
  }

  async function setRetiring(on: boolean) {
    await supabase.from('connected_accounts').update({ retiring: on }).eq('id', accountId);
    setAcct(a => (a ? { ...a, retiring: on } : a));
  }

  async function setStatus(it: Item, status: Item['status']) {
    const change = { status, done_at: status === 'done' ? new Date().toISOString() : null, flagged_at: status === 'todo' ? it.flagged_at : null };
    setItems(list => list?.map(x => (x.id === it.id ? { ...x, ...change } : x)) ?? null);
    await supabase.from('retire_items').update({ ...change, updated_at: new Date().toISOString() }).eq('id', it.id);
  }

  async function setKind(it: Item, kind: Kind) {
    setItems(list => list?.map(x => (x.id === it.id ? { ...x, kind } : x)) ?? null);
    // kind_by_you: a later rescan won't move it back
    await supabase.from('retire_items').update({ kind, kind_by_you: true, updated_at: new Date().toISOString() }).eq('id', it.id);
  }

  const flagged = useMemo(() => (items ?? []).filter(i => i.flagged_at && i.status === 'todo'), [items]);
  const updates = (items ?? []).filter(i => i.kind === 'update');
  const doneUpdates = updates.filter(i => i.status !== 'todo').length;

  if (loadError) {
    return (
      <section className="stack">
        <Link className="link back" to="/settings">← Settings</Link>
        <p className="error">Couldn’t load this page ({loadError}).</p>
        <button onClick={load}>Try again</button>
        <p className="muted small">If it keeps happening on your phone, close rlyfe completely and open it again.</p>
      </section>
    );
  }
  if (!acct || !items) return <p className="muted">Loading…</p>;

  return (
    <section className="stack retire">
      <Link className="link back" to="/settings">← Settings</Link>
      <h2>Retire {acct.email}</h2>
      <p className="muted small">
        Who still has this address, from a scan of your mail’s senders and subjects (not the emails themselves).
        Nothing in the mailbox changes.
      </p>

      {items.length === 0 ? (
        <button className="primary" disabled={busy} onClick={runScan}>{busy ? 'Scanning…' : 'Scan this mailbox'}</button>
      ) : (
        <>
          {updates.length > 0 && (
            <div className="retire-progress">
              <div className="bar"><span style={{ width: `${(doneUpdates / updates.length) * 100}%` }} /></div>
              <span className="small">{doneUpdates} of {updates.length} accounts updated</span>
            </div>
          )}
          <label className="check-line">
            <input type="checkbox" checked={acct.retiring} onChange={e => setRetiring(e.target.checked)} />
            <span>Watch this address — flag anyone who emails it from now on</span>
          </label>
          <div className="row-buttons">
            <button disabled={busy} onClick={runScan}>{busy ? 'Scanning…' : 'Scan again'}</button>
            <label className="check-line small">
              <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> Show finished
            </label>
          </div>
        </>
      )}

      {scan && (
        <p className="notice" onClick={() => setScan(null)}>
          Found {scan.messages.toLocaleString()} emails from the last 5 years, from {scan.groups.toLocaleString()} senders:
          {' '}{scan.update} to update, {scan.person} people, {scan.unsubscribe} lists, {scan.ignore} nothing to do. Cost ${scan.cost.toFixed(3)}.
        </p>
      )}
      {busy && progress && <p className="muted">{progress}</p>}
      {error && <p className="error">{error}</p>}

      {flagged.length > 0 && (
        <div className="stack">
          <h3 className="section-title">Still emailing the old address</h3>
          <ul className="retire-list">{flagged.map(it => <Row key={it.id} it={it} label={SECTIONS.find(s => s.kind === it.kind)!.doneLabel} onStatus={setStatus} onKind={setKind} unsub={unsub[it.id]} onUnsub={unsubscribeOne} />)}</ul>
        </div>
      )}

      {SECTIONS.map(sec => {
        const list = items.filter(i => i.kind === sec.kind && !(i.flagged_at && i.status === 'todo') && (showDone || i.status === 'todo'));
        const total = items.filter(i => i.kind === sec.kind).length;
        if (!total) return null;
        const isOpen = open.has(sec.kind);
        return (
          <div key={sec.kind} className="stack">
            <button className="section-toggle" aria-expanded={isOpen}
                    onClick={() => setOpen(s => { const n = new Set(s); if (n.has(sec.kind)) n.delete(sec.kind); else n.add(sec.kind); return n; })}>
              {sec.title} · {items.filter(i => i.kind === sec.kind && i.status === 'todo').length} left {isOpen ? '▴' : '▾'}
            </button>
            {isOpen && (
              <>
                <p className="muted small">{sec.help}</p>
                {sec.kind === 'unsubscribe' && (() => {
                  const todo = list.filter(i => i.status === 'todo' && !i.unsubscribed_at);
                  return (
                    <>
                      {todo.length > 1 && (
                        <button className="primary" disabled={!!bulk && bulk.startsWith('Unsubscribing')} onClick={() => unsubscribeAll(todo)}>
                          Unsubscribe from all {todo.length}
                        </button>
                      )}
                      {bulk && <p className="muted small">{bulk}</p>}
                    </>
                  );
                })()}
                <ul className="retire-list">
                  {list.map(it => <Row key={it.id} it={it} label={sec.doneLabel} onStatus={setStatus} onKind={setKind} unsub={unsub[it.id]} onUnsub={unsubscribeOne} />)}
                  {list.length === 0 && <li className="muted small">All done here.</li>}
                </ul>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Row({ it, label, onStatus, onKind, unsub, onUnsub }: {
  it: Item; label: string; onStatus: (it: Item, s: Item['status']) => void; onKind: (it: Item, k: Kind) => void;
  unsub?: UnsubState; onUnsub: (it: Item) => void;
}) {
  const scammy = /^likely (phishing|spam)/i.test(it.reason ?? '');
  const canUnsub = it.kind === 'unsubscribe' && !scammy && !it.unsubscribed_at;
  return (
    <li className={`retire-item ${it.status !== 'todo' ? 'finished' : ''}`}>
      <div className="retire-top">
        <span className="retire-name">{it.name}</span>
        {/^likely phishing/i.test(it.reason ?? '') && <span className="badge urgent">Phishing</span>}
        {it.unsubscribed_at && <span className="badge soft">Unsubscribed</span>}
        {it.flagged_at && it.status === 'todo' && <span className="badge back">New mail</span>}
        <span className="todo-meta">{it.message_count} · last {when(it.last_seen)}</span>
      </div>
      <div className="muted small ellipsis">{it.group_key !== it.name.toLowerCase() ? `${it.group_key} · ` : ''}{it.reason}</div>
      {it.samples[0] && <div className="small ellipsis retire-sample">“{it.samples[0]}”</div>}
      <div className="actions">
        {it.status === 'todo' ? (
          <>
            <button onClick={() => onStatus(it, 'done')}>✓ {label}</button>
            <button onClick={() => onStatus(it, 'skipped')}>Skip</button>
            {canUnsub && <button disabled={unsub?.busy} onClick={() => onUnsub(it)}>{unsub?.busy ? 'Unsubscribing…' : 'Unsubscribe'}</button>}
          </>
        ) : (
          <button onClick={() => onStatus(it, 'todo')}>Undo ({it.status === 'done' ? label : 'skipped'})</button>
        )}
        <select className="retire-kind" value={it.kind} aria-label="Move to" onChange={e => onKind(it, e.target.value as Kind)}>
          {(Object.keys(KIND_NAME) as Kind[]).map(k => <option key={k} value={k}>{KIND_NAME[k]}</option>)}
        </select>
      </div>
      {unsub?.msg && (
        <p className={unsub.error ? 'error small' : 'muted small'}>
          {unsub.msg}{unsub.url && <> — <a href={unsub.url} target="_blank" rel="noreferrer">open their unsubscribe page ↗</a></>}
        </p>
      )}
    </li>
  );
}
