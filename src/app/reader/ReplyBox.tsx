import { useEffect, useRef, useState } from 'react';
import * as reply from '../../lib/reply';

// Reply from inside rlyfe. It goes out from the account that received the email, in the
// same conversation, with your Gmail signature. Nothing sends until you tap Send — and
// then there are a few seconds to Undo.
type Phase =
  | { kind: 'edit' }
  | { kind: 'counting'; left: number; done: boolean; cancel: () => void }
  | { kind: 'sending' }
  | { kind: 'sent'; to: string[]; logId: number | null; done: boolean };

export default function ReplyBox({ accountId, threadId, onSent, onClose }: {
  accountId: string; threadId: string;
  onSent: (r: { done: boolean; logId: number | null }) => void;
  onClose: () => void;
}) {
  const ref = { accountId, threadId };
  const [who, setWho] = useState<Awaited<ReturnType<typeof reply.prepare>> | null>(null);
  const [all, setAll] = useState(false);
  const [body, setBody] = useState(() => reply.loadDraft(ref));
  const [before, setBefore] = useState<string | null>(null); // your text before Claude touched it
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const tick = useRef<number | undefined>(undefined);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    reply.prepare(ref).then(setWho).catch(e => setError(reply.SEND_ERRORS[e.message] ?? `Couldn't load the recipients (${e.message}).`));
    return () => window.clearInterval(tick.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, threadId]);

  // Grow the box with the text (phone-friendly, no inner scrollbar)
  useEffect(() => {
    const el = box.current;
    if (el) {
      el.style.height = 'auto';
      const border = el.offsetHeight - el.clientHeight; // border-box: add the border back
      el.style.height = `${Math.min(el.scrollHeight + border, 480)}px`;
    }
  }, [body]);

  const edit = (text: string) => { setBody(text); reply.saveDraft(ref, text); };

  // Empty box → Claude drafts. Your rough note → Claude polishes it. Either way you can go back.
  async function askClaude() {
    setDrafting(true); setError('');
    try {
      const d = await reply.draft(ref, body);
      setBefore(body);
      edit(d.body);
      box.current?.focus();
    } catch (e) {
      const m = e instanceof Error ? e.message : 'failed';
      setError(reply.SEND_ERRORS[m] ?? `Claude couldn't draft this (${m}).`);
    } finally {
      setDrafting(false);
    }
  }

  function send(done: boolean) {
    if (!body.trim()) return setError('Write something first.');
    setError('');
    const cancel = reply.queueSend(ref, body, { replyAll: all, done }, {
      onSent: s => { setPhase({ kind: 'sent', to: s.to, logId: s.logId, done }); onSent({ done, logId: s.logId }); },
      onError: m => { setPhase({ kind: 'edit' }); setError(reply.SEND_ERRORS[m] ?? `Didn't send (${m}). Your reply is still here.`); },
    });
    let left = reply.UNDO_SECONDS;
    setPhase({ kind: 'counting', left, done, cancel });
    window.clearInterval(tick.current);
    tick.current = window.setInterval(() => {
      left -= 1;
      if (left <= 0) { window.clearInterval(tick.current); setPhase({ kind: 'sending' }); }
      else setPhase(p => (p.kind === 'counting' ? { ...p, left } : p));
    }, 1000);
  }

  function undo() {
    if (phase.kind !== 'counting') return;
    phase.cancel();
    window.clearInterval(tick.current);
    setPhase({ kind: 'edit' });
  }

  const r = who ? (all ? who.replyAll : who.reply) : null;
  const noReply = !!r && r.to.some(a => /no[-_.]?reply|do[-_.\s]?not[-_.\s]?reply/i.test(a));
  const canAll =!!who && (who.replyAll.to.length + who.replyAll.cc.length) > (who.reply.to.length + who.reply.cc.length);

  if (phase.kind === 'sent') {
    return (
      <div className="reply sent" role="status">
        ✓ Sent to {phase.to.map(reply.shortName).join(', ')}{phase.done ? ' · email archived' : ''}.
      </div>
    );
  }

  const locked = phase.kind !== 'edit';
  return (
    <div className="reply">
      <div className="reply-head">
        <span className="muted small ellipsis">
          {r ? <>To {r.to.map(reply.shortName).join(', ')}{r.cc.length ? <> · cc {r.cc.map(reply.shortName).join(', ')}</> : null}</> : 'Loading…'}
        </span>
        {canAll && (
          <button className="link small" disabled={locked} onClick={() => setAll(a => !a)}>
            {all ? 'Reply to sender only' : 'Reply all'}
          </button>
        )}
      </div>

      {noReply && (
        <p className="warn-note small">
          This came from a “do not reply” address — a reply probably won’t be read. Use the link or contact in the email instead.
        </p>
      )}

      <textarea ref={box} className="reply-text" value={body} disabled={locked || drafting} rows={4}
                placeholder="Write your reply — or jot a rough note and tap Polish" onChange={e => edit(e.target.value)} />

      <div className="reply-claude">
        <button disabled={locked || drafting} onClick={askClaude}>
          {drafting ? (body.trim() ? 'Polishing…' : 'Drafting…') : body.trim() ? '✨ Polish with Claude' : '✨ Draft with Claude'}
        </button>
        {before !== null && !drafting && !locked && (
          <button className="link small" onClick={() => { edit(before); setBefore(null); }}>
            {before.trim() ? 'Undo polish' : 'Clear draft'}
          </button>
        )}
      </div>
      {who && <p className="muted small">From {who.from}{who.provider === 'google' ? ' · your Gmail signature is added' : ''}</p>}

      {error && <p className="error">{error}</p>}

      {phase.kind === 'counting' ? (
        <div className="toast inline" role="status">
          <span>Sending in {phase.left}…</span>
          <button onClick={undo}>Undo</button>
        </div>
      ) : phase.kind === 'sending' ? (
        <p className="muted">Sending…</p>
      ) : (
        <div className="row-buttons">
          <button className="primary" disabled={!r || !body.trim()} onClick={() => send(false)}>Send</button>
          <button disabled={!r || !body.trim()} onClick={() => send(true)}>Send + Done</button>
          <button className="link push" onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  );
}
