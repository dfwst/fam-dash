import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/functions';

// Household rules: "everything about Karen Williams → the Karen tab". A rule matches by exact
// words/senders, or by a plain-words description Claude checks each new email against.
// Shared rules make the matching emails (only those) visible to everyone in the household.
type Rule = {
  id: string; name: string; tab_id: string | null; phrases: string[]; senders: string[];
  description: string | null; share_matches: boolean; always_real: boolean; gmail_label: string | null;
  enabled: boolean; created_by: string;
};
type Tab = { id: string; name: string; owner_id: string | null };
type Draft = {
  id?: string; name: string; tabId: string; newTabName: string; phrases: string; senders: string;
  description: string; share_matches: boolean; always_real: boolean; gmail_label: string;
};
const NEW = '__new';
const blank: Draft = {
  name: '', tabId: NEW, newTabName: '', phrases: '', senders: '', description: '',
  share_matches: true, always_real: true, gmail_label: '',
};
const lines = (s: string) => s.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
const ERRORS: Record<string, string> = {
  'name-required': 'Give the rule a name.',
  'nothing-to-match': 'Add at least one word, sender, or description to match.',
  'bad-tab': 'That tab isn’t yours to send mail to.',
};

export default function Rules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [me, setMe] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = () => {
    supabase.from('rules').select('*').order('created_at').then(({ data }) => setRules((data ?? []) as Rule[]));
    supabase.from('tabs').select('id, name, owner_id').eq('is_active', true).order('sort_order').then(({ data }) => setTabs(data ?? []));
  };
  useEffect(() => {
    load();
    supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? ''));
  }, []);

  const tabName = (id: string | null) => tabs.find(t => t.id === id)?.name ?? '—';
  // A shared rule can only send mail to a shared tab (both of you need to see it); a private one to yours or Shared
  const allowedTabs = (share: boolean) => tabs.filter(t => (share ? !t.owner_id : !t.owner_id || t.owner_id === me));
  const set = (patch: Partial<Draft>) => setDraft(d => (d ? { ...d, ...patch } : d));

  function edit(r: Rule) {
    setError(''); setNote('');
    setDraft({
      id: r.id, name: r.name, tabId: r.tab_id ?? NEW, newTabName: '', phrases: r.phrases.join('\n'),
      senders: r.senders.join('\n'), description: r.description ?? '', share_matches: r.share_matches,
      always_real: r.always_real, gmail_label: r.gmail_label ?? '',
    });
  }

  async function save() {
    if (!draft) return;
    setBusy('save'); setError(''); setNote('');
    try {
      const isNew = draft.tabId === NEW;
      const r = await callFn<{ id: string; tabId: string }>('rules', {
        action: 'save', id: draft.id, name: draft.name,
        ...(isNew ? { newTabName: draft.newTabName || draft.name } : { tabId: draft.tabId }),
        phrases: lines(draft.phrases), senders: lines(draft.senders), description: draft.description,
        share_matches: draft.share_matches, always_real: draft.always_real, gmail_label: draft.gmail_label,
      });
      const first = !draft.id;
      setDraft(null);
      load();
      if (first) await apply(r.id); // a new rule sorts the last 30 days right away
      // A new tab needs the menu to reload
      if (isNew) setNote(n => `${n} Your new tab appears after a refresh.`.trim());
    } catch (e) {
      const m = e instanceof Error ? e.message : 'failed';
      setError(ERRORS[m] ?? `Couldn’t save (${m}).`);
    } finally { setBusy(''); }
  }

  async function apply(id: string) {
    setBusy(`apply:${id}`); setError(''); setNote('Checking the last 30 days…');
    try {
      const r = await callFn<{ matched: number; exact: number; smart: number; checked: number }>('rules', { action: 'apply', id, days: 30 });
      setNote(`Checked ${r.checked} emails from the last 30 days — ${r.matched} matched`
        + (r.smart ? ` (${r.exact} by words/sender, ${r.smart} by description).` : '.'));
    } catch (e) {
      setNote(''); setError(`Couldn’t apply (${e instanceof Error ? e.message : 'failed'}).`);
    } finally { setBusy(''); }
  }

  async function remove(r: Rule) {
    if (!confirm(`Delete the rule “${r.name}”? Its emails go back to their usual tabs and stop being shared. No email is deleted.`)) return;
    setBusy(`del:${r.id}`);
    try { await callFn('rules', { action: 'delete', id: r.id }); load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'failed'); }
    finally { setBusy(''); }
  }

  return (
    <section className="stack">
      <p className="muted small">
        Send mail about one thing to one tab — from any account. Example: everything about Karen Williams → a Karen tab you both see.
      </p>

      {rules.length > 0 && (
        <ul className="plain stack">
          {rules.map(r => (
            <li key={r.id} className="rule-card stack-sm">
              <div><strong>{r.name}</strong> → {tabName(r.tab_id)}</div>
              <div className="muted small">
                {[r.phrases.length ? `words: ${r.phrases.join(', ')}` : '', r.senders.length ? `from: ${r.senders.join(', ')}` : '',
                  r.description ? `about: ${r.description}` : ''].filter(Boolean).join(' · ')}
              </div>
              <div className="muted small">
                {r.share_matches ? 'Shared with the household' : 'Only your mail'}{r.always_real ? ' · always Important' : ''}
                {r.gmail_label ? ` · Gmail label “${r.gmail_label}”` : ''}
              </div>
              <div className="row-buttons">
                <button disabled={!!busy} onClick={() => apply(r.id)}>{busy === `apply:${r.id}` ? 'Checking…' : 'Apply to last 30 days'}</button>
                <button disabled={!!busy} onClick={() => edit(r)}>Edit</button>
                <button className="link" disabled={!!busy} onClick={() => remove(r)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {note && <p className="notice small">{note}</p>}
      {error && !draft && <p className="error">{error}</p>}

      {!draft ? (
        <button onClick={() => { setError(''); setNote(''); setDraft({ ...blank }); }}>New rule…</button>
      ) : (
        <div className="add-todo invite">
          <label className="field"><span className="muted small">Name</span>
            <input value={draft.name} maxLength={60} onChange={e => set({ name: e.target.value })} placeholder="Karen’s care" /></label>

          <label className="field"><span className="muted small">Emails containing any of these words (one per line)</span>
            <textarea rows={2} value={draft.phrases} onChange={e => set({ phrases: e.target.value })} placeholder="Karen Williams" /></label>
          <label className="field"><span className="muted small">…or from these senders — an address or a whole domain (one per line)</span>
            <textarea rows={2} value={draft.senders} onChange={e => set({ senders: e.target.value })} placeholder="drsmith@clinic.com&#10;bswhealth.org" /></label>
          <label className="field"><span className="muted small">…or, in plain words, what it’s about (Claude checks each new email)</span>
            <textarea rows={3} value={draft.description} onChange={e => set({ description: e.target.value })}
                      placeholder="Anything about Karen Williams’ medical care: appointments, doctors, test results, prescriptions, Medicare" /></label>

          <label className="field"><span className="muted small">Send matches to</span>
            <select value={draft.tabId} onChange={e => set({ tabId: e.target.value })}>
              <option value={NEW}>A new tab…</option>
              {allowedTabs(draft.share_matches).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></label>
          {draft.tabId === NEW && (
            <label className="field"><span className="muted small">New tab name</span>
              <input value={draft.newTabName} maxLength={30} onChange={e => set({ newTabName: e.target.value })} placeholder={draft.name || 'Karen'} /></label>
          )}

          <label className="check-row">
            <input type="checkbox" checked={draft.share_matches} onChange={e => set({
              share_matches: e.target.checked,
              // a private tab can't hold shared mail
              tabId: e.target.checked && tabs.find(t => t.id === draft.tabId)?.owner_id ? NEW : draft.tabId,
            })} />
            <span>Share matches with the household <span className="muted small">— everyone sees these emails (only these), from anyone’s account</span></span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={draft.always_real} onChange={e => set({ always_real: e.target.checked })} />
            <span>Always Important <span className="muted small">— stays in the inbox and on the Mail list; never cleared as Glance or Noise</span></span>
          </label>
          <label className="field"><span className="muted small">Gmail label (optional — also labels matches in Gmail)</span>
            <input value={draft.gmail_label} maxLength={40} onChange={e => set({ gmail_label: e.target.value })} placeholder="Karen" /></label>

          {error && <p className="error">{error}</p>}
          <div className="row-buttons">
            <button className="primary" disabled={!!busy || !draft.name.trim()} onClick={save}>
              {busy === 'save' ? 'Saving…' : draft.id ? 'Save' : 'Save & sort last 30 days'}
            </button>
            <button className="link" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
