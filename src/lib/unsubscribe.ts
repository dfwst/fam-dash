import { callFn } from './functions';

// Unsubscribe from a mailing list. one-click / email happen on the server; 'link' means the sender
// only offers a web page — the app shows it for you to open (it can't be safely auto-clicked).
export type UnsubResult = { method: 'one-click' | 'email' | 'link' | 'none'; ok: boolean; url?: string };

export const unsubscribeThread = (accountId: string, threadId: string) =>
  callFn<UnsubResult>('unsubscribe', { accountId, threadId });

export const unsubscribeRetireItem = (retireItemId: string) =>
  callFn<UnsubResult>('unsubscribe', { retireItemId });

export const UNSUB_ERRORS: Record<string, string> = {
  'looks-like-spam': 'This sender looks like spam or phishing — unsubscribing would only confirm your address. Ignore it instead.',
  'is-a-person': 'That’s a person, not a mailing list.',
  'priority-mail': 'Priority mail (security, payments) isn’t unsubscribed from.',
  'rescan-needed': 'Scan this mailbox again first (it needs to find the latest email from this sender).',
  'needs-reconnect': 'This account needs reconnecting in Settings.',
};

export const unsubLabel = (r: UnsubResult) =>
  r.method === 'one-click' && r.ok ? 'Unsubscribed'
  : r.method === 'email' && r.ok ? 'Unsubscribe email sent'
  : r.method === 'link' ? 'Needs the sender’s page'
  : 'No unsubscribe option';
