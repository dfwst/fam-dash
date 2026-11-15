import { callFn } from './functions';

// Replies (Milestone 5). Sending is always your tap — then a few seconds to change your mind.
export type Recipients = { to: string[]; cc: string[] };
type Ref = { accountId: string; threadId: string };

export const prepare = (r: Ref) =>
  callFn<{ from: string; provider: 'google' | 'microsoft' | 'imap'; reply: Recipients; replyAll: Recipients }>('thread-reply', { action: 'prepare', ...r });

// Empty rough → Claude drafts from the email; otherwise Claude polishes your rough note
export const draft = (r: Ref, rough: string) =>
  callFn<{ body: string; cost: number }>('thread-reply', { action: 'draft', ...r, rough });

type Sent = { sent: string; to: string[]; cc: string[]; logId: number | null };

export const UNDO_SECONDS = 5;

// The countdown lives outside the screen, so leaving the reader doesn't cancel a send you tapped.
export function queueSend(
  r: Ref, body: string, opts: { replyAll: boolean; done: boolean },
  cb: { onSent: (s: Sent) => void; onError: (msg: string) => void },
): () => void {
  const timer = window.setTimeout(() => {
    callFn<Sent>('thread-reply', { action: 'send', ...r, body, ...opts })
      .then(s => { clearDraft(r); cb.onSent(s); })
      .catch(e => cb.onError(e instanceof Error ? e.message : 'send-failed'));
  }, UNDO_SECONDS * 1000);
  return () => window.clearTimeout(timer);
}

// What you've typed is kept on this device until it's sent, so nothing is lost by leaving.
const key = (r: Ref) => `rlyfe.draft.${r.accountId}.${r.threadId}`;
export function loadDraft(r: Ref): string {
  try { return localStorage.getItem(key(r)) ?? ''; } catch { return ''; }
}
export function saveDraft(r: Ref, text: string) {
  try { if (text.trim()) localStorage.setItem(key(r), text); else localStorage.removeItem(key(r)); } catch { /* ignore */ }
}
export function clearDraft(r: Ref) {
  try { localStorage.removeItem(key(r)); } catch { /* ignore */ }
}

// "Ann Doe <ann@x.com>" → "Ann Doe"
export const shortName = (addr: string) => {
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return (m?.[1].trim() || m?.[2] || addr).trim();
};

export const SEND_ERRORS: Record<string, string> = {
  'needs-reconnect': 'Google sign-in expired for this account — reconnect it in Settings. Your reply is saved.',
  'no-recipient': "Couldn't tell who to reply to.",
  empty: 'Write something first.',
  'too-long': 'That reply is too long.',
  'no-draft': "Claude didn't write a draft for this one.",
};
