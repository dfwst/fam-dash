// One way to talk to any mailbox. Everything above this layer (sorting, the reader, replies,
// learning) works on the Gmail-shaped thread from gmail-parse.ts — Microsoft conversations are
// translated into that same shape here, so the rest of rlyfe doesn't care where mail lives.
//
//   Gmail      thread  = Gmail thread;          archive = remove INBOX label
//   Microsoft  thread  = Outlook conversation;   archive = move to the Archive folder
//
// Never deletes or trashes anything, on either side.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { gmail, gmailRequest, modifyThread } from './google.ts';
import { graph } from './microsoft.ts';
import { imapMailbox, type ImapCreds } from './imap.ts';
import { accessTokenFor, type Provider } from './accounts.ts';
import { decrypt } from './crypto.ts';
import { parseFrom, type GmailMessage, type GmailThread, type Part } from './gmail-parse.ts';
import { buildReply, replyBase, type Sender } from './reply.ts';

export type MailThread = GmailThread & { webLink?: string | null };

export interface Mailbox {
  provider: Provider;
  email: string;
  /** Threads in the inbox with mail from the last `days` days, each with a version that changes when it does */
  listInbox(days: number): Promise<{ id: string; version: string }[]>;
  getThread(id: string, opts?: { attachments?: boolean }): Promise<MailThread>;
  /** Out of the inbox + marked read */
  archive(id: string): Promise<void>;
  /** Back into the inbox (and unread again if it was) */
  unarchive(id: string, unread: boolean): Promise<void>;
  markRead(id: string): Promise<void>;
  /** Server-side rule: mail from `sender` skips the inbox + is marked read. Returns the rule id. */
  addIgnoreRule(sender: string): Promise<string>;
  removeIgnoreRule(ruleId: string): Promise<void>;
  /** Reply in the same conversation, from this account */
  sendReply(t: MailThread, to: string[], cc: string[], text: string): Promise<{ id: string }>;
  /** Close any open connection (IMAP); a no-op for web APIs */
  close?(): Promise<void>;
}

export function isValidThreadId(provider: Provider, id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (provider === 'microsoft') return /^[A-Za-z0-9+/=_-]{10,400}$/.test(id);
  if (provider === 'imap') return /^[A-Za-z0-9_-]{4,600}$/.test(id); // base64url of the root Message-ID
  return /^[0-9a-f]{6,32}$/i.test(id);
}

export type AccountRef = { id: string; email: string; provider: Provider };

export async function openMailbox(admin: SupabaseClient, acct: AccountRef): Promise<Mailbox> {
  if (acct.provider === 'imap') {
    const { data: s } = await admin.from('account_secrets').select('refresh_token_enc').eq('account_id', acct.id).single();
    const creds = JSON.parse(await decrypt(s!.refresh_token_enc)) as ImapCreds;
    return imapMailbox(creds, acct.email);
  }
  const token = await accessTokenFor(admin, acct.id);
  return acct.provider === 'microsoft' ? graphMailbox(token, acct.email) : gmailMailbox(token, acct.email);
}

// ── Gmail ───────────────────────────────────────────────────────────

function gmailMailbox(token: string, email: string): Mailbox {
  return {
    provider: 'google',
    email,
    async listInbox(days) {
      const out: { id: string; version: string }[] = [];
      let pageToken: string | undefined;
      do {
        const r = await gmail<{ threads?: { id: string; historyId: string }[]; nextPageToken?: string }>(
          'threads', token,
          { labelIds: 'INBOX', q: `newer_than:${days}d`, maxResults: '500', ...(pageToken ? { pageToken } : {}) });
        out.push(...(r.threads ?? []).map(t => ({ id: t.id, version: t.historyId })));
        pageToken = r.nextPageToken;
      } while (pageToken && out.length < 5000);
      return out;
    },
    getThread: (id) => gmail<GmailThread>(`threads/${id}`, token, { format: 'full' }),
    archive: async (id) => { await modifyThread(id, token, { removeLabelIds: ['INBOX', 'UNREAD'] }); },
    unarchive: async (id, unread) => { await modifyThread(id, token, { addLabelIds: unread ? ['INBOX', 'UNREAD'] : ['INBOX'] }); },
    markRead: async (id) => { await modifyThread(id, token, { removeLabelIds: ['UNREAD'] }); },
    async addIgnoreRule(sender) {
      const f = await gmailRequest<{ id: string }>('POST', 'settings/filters', token, {
        body: { criteria: { from: sender }, action: { removeLabelIds: ['INBOX', 'UNREAD'] } },
      });
      return f.id;
    },
    removeIgnoreRule: async (ruleId) => { await gmailRequest('DELETE', `settings/filters/${ruleId}`, token); },
    async sendReply(t, to, cc, text) {
      // Your name + signature exactly as Gmail has them for this address
      let sender: Sender = { email, displayName: '', signatureHtml: '' };
      try {
        const s = await gmail<{ displayName?: string; signature?: string }>(`settings/sendAs/${encodeURIComponent(email)}`, token);
        sender = { email, displayName: s.displayName ?? '', signatureHtml: s.signature ?? '' };
      } catch { /* send without the signature */ }
      const { raw } = buildReply(t, sender, to, cc, text);
      const sent = await gmailRequest<{ id: string }>('POST', 'messages/send', token, { body: { raw, threadId: t.id } });
      return { id: sent.id };
    },
  };
}

// ── Microsoft (Graph) ───────────────────────────────────────────────

type GraphAddr = { emailAddress?: { name?: string; address?: string } };
type GraphMsg = {
  id: string; conversationId: string; subject?: string; from?: GraphAddr; sender?: GraphAddr;
  toRecipients?: GraphAddr[]; ccRecipients?: GraphAddr[]; replyTo?: GraphAddr[];
  receivedDateTime?: string; sentDateTime?: string; lastModifiedDateTime?: string;
  isRead?: boolean; isDraft?: boolean; parentFolderId?: string;
  body?: { contentType: 'html' | 'text'; content: string }; bodyPreview?: string;
  internetMessageId?: string; internetMessageHeaders?: { name: string; value: string }[];
  hasAttachments?: boolean; webLink?: string;
};

const FULL = 'id,conversationId,subject,from,sender,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,'
  + 'isRead,isDraft,parentFolderId,body,bodyPreview,internetMessageId,internetMessageHeaders,hasAttachments,webLink';
const LIGHT = 'id,parentFolderId,isRead,receivedDateTime';

const fmtAddr = (a?: GraphAddr) => {
  const e = a?.emailAddress;
  if (!e?.address) return '';
  const name = (e.name ?? '').replace(/"/g, '').trim();
  return name && name.toLowerCase() !== e.address.toLowerCase() ? `"${name}" <${e.address}>` : e.address;
};
const fmtList = (l?: GraphAddr[]) => (l ?? []).map(fmtAddr).filter(Boolean).join(', ');

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const toRecipient = (addr: string) => {
  const { name, email } = parseFrom(addr);
  return { emailAddress: { address: email, ...(name && name.toLowerCase() !== email ? { name } : {}) } };
};

export function graphMailbox(token: string, email: string): Mailbox { // exported for tests
  const me = email.toLowerCase();

  // Well-known folder ids (Inbox, Archive, Sent, Deleted, Junk), fetched once per call
  let folderIds: Promise<Record<string, string>> | null = null;
  const folders = () => folderIds ??= (async () => {
    const names = ['inbox', 'archive', 'sentitems', 'deleteditems', 'junkemail'];
    const ids = await Promise.all(names.map(n =>
      graph<{ id: string }>('GET', `me/mailFolders/${n}?$select=id`, token).then(f => f.id).catch(() => '')));
    return Object.fromEntries(names.map((n, i) => [n, ids[i]]));
  })();

  // %20 for spaces (not '+'): Graph's OData parser wants the strict form; ids keep '+' as %2B
  const q = (params: Record<string, string>) =>
    Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const convFilter = (id: string) => `conversationId eq '${id.replace(/'/g, "''")}'`;

  // All messages in a conversation (any folder except Deleted/Junk)
  async function conversation(id: string, select: string): Promise<GraphMsg[]> {
    const f = await folders();
    const r = await graph<{ value: GraphMsg[] }>('GET', `me/messages?${q({ $filter: convFilter(id), $select: select, $top: '100' })}`, token);
    return r.value
      .filter(m => m.parentFolderId !== f.deleteditems && m.parentFolderId !== f.junkemail)
      .sort((a, b) => Date.parse(a.receivedDateTime ?? '') - Date.parse(b.receivedDateTime ?? ''));
  }

  const setRead = (m: GraphMsg, isRead: boolean) => graph('PATCH', `me/messages/${m.id}`, token, { isRead });
  const move = (m: GraphMsg, destinationId: string) => graph('POST', `me/messages/${m.id}/move`, token, { destinationId });

  return {
    provider: 'microsoft',
    email,

    async listInbox(days) {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const byConv = new Map<string, { n: number; mod: string }>();
      let url: string | undefined = `me/mailFolders/inbox/messages?${q({
        $select: 'id,conversationId,lastModifiedDateTime', $filter: `receivedDateTime ge ${since}`, $top: '250',
      })}`;
      let seen = 0;
      while (url && seen < 10_000) {
        const r: { value: GraphMsg[]; '@odata.nextLink'?: string } = await graph('GET', url, token);
        for (const m of r.value) {
          const c = byConv.get(m.conversationId) ?? { n: 0, mod: '' };
          c.n++;
          if ((m.lastModifiedDateTime ?? '') > c.mod) c.mod = m.lastModifiedDateTime ?? '';
          byConv.set(m.conversationId, c);
        }
        seen += r.value.length;
        url = r['@odata.nextLink'];
      }
      // version = newest change + how many inbox messages — changes on new mail, read, or move
      return [...byConv].map(([id, c]) => ({ id, version: `${c.mod}|${c.n}` }));
    },

    async getThread(id, opts) {
      const f = await folders();
      const msgs = await conversation(id, FULL);
      if (!msgs.length) throw new Error('graph-404:conversation-empty');
      const out: GmailMessage[] = [];
      for (const m of msgs) {
        const from = fmtAddr(m.from ?? m.sender);
        const extra = (m.internetMessageHeaders ?? []).filter(h => /^(references|list-unsubscribe)$/i.test(h.name));
        const labels = [
          ...(m.parentFolderId === f.inbox ? ['INBOX'] : []),
          ...(m.isRead === false ? ['UNREAD'] : []),
          ...(m.parentFolderId === f.sentitems || parseFrom(from).email === me ? ['SENT'] : []),
          ...(m.isDraft ? ['DRAFT'] : []),
        ];
        const parts: Part[] = [];
        if (opts?.attachments && m.hasAttachments) {
          const a = await graph<{ value: { name: string; size: number; isInline?: boolean }[] }>(
            'GET', `me/messages/${m.id}/attachments?$select=name,size,isInline`, token).catch(() => ({ value: [] }));
          parts.push(...a.value.filter(x => !x.isInline).map(x => ({ filename: x.name, body: { size: x.size } })));
        }
        out.push({
          id: m.id,
          labelIds: labels,
          internalDate: String(Date.parse(m.receivedDateTime ?? m.sentDateTime ?? '') || Date.now()),
          snippet: m.bodyPreview ?? '',
          payload: {
            mimeType: m.body?.contentType === 'html' ? 'text/html' : 'text/plain',
            body: { data: b64url(m.body?.content ?? '') },
            parts,
            headers: [
              { name: 'From', value: from },
              { name: 'To', value: fmtList(m.toRecipients) },
              { name: 'Cc', value: fmtList(m.ccRecipients) },
              { name: 'Reply-To', value: fmtList(m.replyTo) },
              { name: 'Subject', value: m.subject ?? '' },
              { name: 'Message-ID', value: m.internetMessageId ?? '' },
              ...extra,
            ],
          },
        });
      }
      // historyId is Gmail's idea; Microsoft's version comes from listInbox instead
      return { id, historyId: '', messages: out, webLink: msgs[msgs.length - 1].webLink ?? null };
    },

    async archive(id) {
      const f = await folders();
      for (const m of (await conversation(id, LIGHT)).filter(m => m.parentFolderId === f.inbox)) {
        if (m.isRead === false) await setRead(m, true);
        await move(m, f.archive);
      }
    },

    async unarchive(id, unread) {
      const f = await folders();
      const archived = (await conversation(id, LIGHT)).filter(m => m.parentFolderId === f.archive);
      for (const m of archived) await move(m, f.inbox);
      const last = archived[archived.length - 1];
      if (unread && last) await setRead(last, false);
    },

    async markRead(id) {
      for (const m of (await conversation(id, LIGHT)).filter(m => m.isRead === false)) await setRead(m, true);
    },

    async addIgnoreRule(sender) {
      const f = await folders();
      const rule = await graph<{ id: string }>('POST', 'me/mailFolders/inbox/messageRules', token, {
        displayName: `rlyfe: always ignore ${sender}`.slice(0, 250),
        sequence: 1,
        isEnabled: true,
        conditions: { fromAddresses: [{ emailAddress: { address: sender } }] },
        actions: { moveToFolder: f.archive, markAsRead: true },
      });
      return rule.id;
    },

    removeIgnoreRule: async (ruleId) => { await graph('DELETE', `me/mailFolders/inbox/messageRules/${ruleId}`, token); },

    async sendReply(t, to, cc, text) {
      // Outlook builds the quoted original + threading headers; we put your words on top
      const base = replyBase(t, email);
      const draft = await graph<{ id: string; body: { contentType: 'html' | 'text'; content: string } }>(
        'POST', `me/messages/${base.id}/createReply`, token, {});
      const body = draft.body.contentType === 'html'
        ? { contentType: 'HTML', content: `<div>${escapeHtml(text.trim()).replace(/\n/g, '<br>')}</div><br>${draft.body.content}` }
        : { contentType: 'Text', content: `${text.trim()}\n\n${draft.body.content}` };
      await graph('PATCH', `me/messages/${draft.id}`, token, {
        toRecipients: to.map(toRecipient), ccRecipients: cc.map(toRecipient), body,
      });
      await graph('POST', `me/messages/${draft.id}/send`, token);
      return { id: draft.id };
    },
  };
}
