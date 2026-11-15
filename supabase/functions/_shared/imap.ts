// IMAP mailboxes (Yahoo, AOL, iCloud, any other) — signed in with an APP PASSWORD, never
// the account's real password. Read/archive over IMAP, replies over SMTP.
//
// IMAP has no conversations, so rlyfe builds them: every message in a conversation names the
// first message in its References header (the "root"). A thread id is that root Message-ID,
// base64url-encoded, so any folder can be searched for the whole conversation by header.
//
//   archive   = move from INBOX to the Archive folder (+ mark read)
//   ignore    = no server-side rules over IMAP → rlyfe applies "Always ignore" at each sync
import { ImapFlow } from 'npm:imapflow@1.0.171';
import { simpleParser } from 'npm:mailparser@3.7.2';
import nodemailer from 'npm:nodemailer@6.9.16';
import type { GmailMessage, Part } from './gmail-parse.ts';
import { buildReply } from './reply.ts';
import type { Mailbox, MailThread } from './mailbox.ts';

export type ImapService = 'yahoo' | 'aol' | 'icloud' | 'other';
export type ImapCreds = {
  service: ImapService; user: string; pass: string;
  imapHost: string; imapPort: number; smtpHost: string; smtpPort: number;
};

export const PRESETS: Record<Exclude<ImapService, 'other'>, Omit<ImapCreds, 'service' | 'user' | 'pass'>> = {
  yahoo:  { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  aol:    { imapHost: 'imap.aol.com',        imapPort: 993, smtpHost: 'smtp.aol.com',        smtpPort: 465 },
  icloud: { imapHost: 'imap.mail.me.com',    imapPort: 993, smtpHost: 'smtp.mail.me.com',    smtpPort: 587 },
};

const MAX_SOURCE = 600_000; // bytes of each message we download — plenty for text, skips huge attachments
const LOOKBACK_DAYS = 120;  // how far back each folder is indexed to piece conversations together

// deno-lint-ignore no-explicit-any
type Client = any;

export function newImapClient(c: ImapCreds): Client {
  return new ImapFlow({
    host: c.imapHost, port: c.imapPort, secure: true, logger: false, emitLogs: false,
    auth: { user: c.user, pass: c.pass },
  });
}

export function newSmtp(c: ImapCreds) {
  return nodemailer.createTransport({
    host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, requireTLS: c.smtpPort !== 465,
    auth: { user: c.user, pass: c.pass },
  });
}

// ── thread ids ──────────────────────────────────────────────────────

function enc(s: string): string { // chunked: large emails would overflow the call stack
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const dec = (s: string) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
};

const firstId = (h: string | undefined) => h?.match(/<[^<>\s]+>/)?.[0];
// The conversation's first message: start of References, else what it replies to, else itself
function rootOf(refs: string | undefined, inReplyTo: string | undefined, messageId: string | undefined, fallback: string) {
  return firstId(refs) ?? firstId(inReplyTo) ?? firstId(messageId) ?? fallback;
}

// ── the mailbox ─────────────────────────────────────────────────────

export function imapMailbox(c: ImapCreds, email: string): Mailbox {
  const client: Client = newImapClient(c);
  const me = email.toLowerCase();
  let ready: Promise<void> | null = null;
  let idle: number | undefined;

  // One connection per function call; it closes itself a few seconds after the last use
  const open = async () => {
    clearTimeout(idle);
    ready ??= client.connect();
    await ready;
  };
  const rest = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { client.logout().catch(() => {}); ready = null; }, 4000);
  };

  let folderPaths: Promise<{ inbox: string; archive: string; sent: string }> | null = null;
  const folders = () => folderPaths ??= (async () => {
    const list: { path: string; specialUse?: string }[] = await client.list();
    const find = (use: string, names: string[]) =>
      list.find(f => f.specialUse === use)?.path ?? list.find(f => names.includes(f.path.toLowerCase()))?.path;
    let archive = find('\\Archive', ['archive', 'archives']);
    if (!archive) { await client.mailboxCreate('Archive'); archive = 'Archive'; }
    return { inbox: 'INBOX', archive, sent: find('\\Sent', ['sent', 'sent messages', 'sent items']) ?? 'Sent' };
  })();

  async function inFolder<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const lock = await client.getMailboxLock(path);
    try { return await fn(); } finally { lock.release(); }
  }

  // Which conversation each recent message in a folder belongs to. Built from each message's
  // own headers on OUR side — Yahoo's server-side header SEARCH can't be relied on.
  // Cached per folder for this function call; moves clear it.
  type Ref = { uid: number; root: string; seen: boolean; messageId?: string };
  const index = new Map<string, Promise<Ref[]>>();
  const indexFolder = (path: string, days = LOOKBACK_DAYS) => {
    const key = `${path}|${days}`;
    if (!index.has(key)) index.set(key, inFolder(path, async () => {
      const since = new Date(Date.now() - days * 86_400_000);
      const uids: number[] = (await client.search({ since }, { uid: true })) || [];
      const out: Ref[] = [];
      if (!uids.length) return out;
      for await (const m of client.fetch(uids, { uid: true, flags: true, envelope: true, headers: ['references'] }, { uid: true })) {
        const refs = m.headers ? new TextDecoder().decode(m.headers).replace(/^references:\s*/i, '') : '';
        out.push({
          uid: m.uid,
          root: rootOf(refs, m.envelope?.inReplyTo, m.envelope?.messageId, `uid:${path}:${m.uid}`),
          seen: !!m.flags?.has('\\Seen'),
          messageId: m.envelope?.messageId,
        });
      }
      return out;
    }));
    return index.get(key)!;
  };
  const forget = (...paths: string[]) => {
    for (const k of [...index.keys()]) if (paths.some(p => k.startsWith(`${p}|`))) index.delete(k);
  };

  // Every recent message in one folder that belongs to the conversation
  async function uidsFor(path: string, root: string): Promise<number[]> {
    return (await indexFolder(path)).filter(r => r.root === root).map(r => r.uid);
  }

  const done = <T>(p: Promise<T>) => p.finally(rest);

  return {
    provider: 'imap',
    email,
    close: async () => { clearTimeout(idle); if (ready) { await client.logout().catch(() => {}); ready = null; } },

    listInbox: (days) => done((async () => {
      await open();
      const byRoot = new Map<string, string[]>();
      for (const r of await indexFolder('INBOX', Math.max(days, LOOKBACK_DAYS))) {
        byRoot.set(r.root, [...(byRoot.get(r.root) ?? []), `${r.uid}${r.seen ? 's' : 'u'}`]);
      }
      // Only conversations with something from the last `days` days (the index looks further back)
      const recent = new Set((await indexFolder('INBOX', days)).map(r => r.root));
      for (const root of [...byRoot.keys()]) if (!recent.has(root)) byRoot.delete(root);
      // version = which messages are in the inbox + their read state
      return [...byRoot].map(([root, parts]) => ({ id: enc(root), version: parts.sort().join('.') }));
    })()),

    getThread: (id, opts) => done((async () => {
      await open();
      const root = dec(id);
      const f = await folders();
      const out: (GmailMessage & { _t: number })[] = [];
      for (const [path, code] of [[f.inbox, 'I'], [f.archive, 'A'], [f.sent, 'S']] as const) {
        const uids = await uidsFor(path, root);
        if (!uids.length) continue;
        await inFolder(path, async () => {
          for await (const m of client.fetch(uids, { uid: true, flags: true, source: { maxLength: MAX_SOURCE } }, { uid: true })) {
            const p = await simpleParser(m.source, { skipImageLinks: true, skipTextToHtml: true });
            const from = p.from?.value?.[0];
            const fromStr = from ? (from.name ? `"${from.name.replace(/"/g, '')}" <${from.address}>` : from.address ?? '') : '';
            const list = (v: unknown) => [v].flat().filter(Boolean).map(a => (a as { text: string }).text).join(', ');
            const header = (n: string) => { const v = p.headers.get(n); return typeof v === 'string' ? v : ''; };
            const parts: Part[] = opts?.attachments
              ? ((p.attachments ?? []) as { contentDisposition?: string; filename?: string; size: number }[])
                  .filter(a => a.contentDisposition !== 'inline')
                  .map(a => ({ filename: a.filename ?? 'attachment', body: { size: a.size } }))
              : [];
            const html = typeof p.html === 'string' ? p.html : '';
            const t = (p.date ?? new Date()).getTime();
            out.push({
              _t: t,
              id: `${code}:${m.uid}`,
              labelIds: [
                ...(path === f.inbox ? ['INBOX'] : []),
                ...(m.flags?.has('\\Seen') ? [] : ['UNREAD']),
                ...(path === f.sent || from?.address?.toLowerCase() === me ? ['SENT'] : []),
              ],
              internalDate: String(t),
              snippet: (p.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
              payload: {
                mimeType: html ? 'text/html' : 'text/plain',
                body: { data: enc(html || p.text || '') },
                parts,
                headers: [
                  { name: 'From', value: fromStr },
                  { name: 'To', value: list(p.to) },
                  { name: 'Cc', value: list(p.cc) },
                  { name: 'Reply-To', value: list(p.replyTo) },
                  { name: 'Subject', value: p.subject ?? '' },
                  { name: 'Message-ID', value: p.messageId ?? '' },
                  { name: 'References', value: [p.references].flat().filter(Boolean).join(' ') },
                  { name: 'List-Unsubscribe', value: header('list-unsubscribe') },
                ],
              },
            });
          }
        });
      }
      if (!out.length) throw new Error('imap-404:conversation-not-found');
      // The same message can sit in two folders (e.g. Sent + Inbox when you mail yourself)
      const seen = new Set<string>();
      const msgs = out.sort((a, b) => a._t - b._t).filter(m => {
        const mid = m.payload.headers?.find(h => h.name === 'Message-ID')?.value || m.id;
        if (seen.has(mid)) return false;
        seen.add(mid);
        return true;
      }).map(({ _t, ...m }) => m);
      return { id, historyId: '', messages: msgs } as MailThread;
    })()),

    archive: (id) => done((async () => {
      await open();
      const f = await folders();
      const uids = await uidsFor(f.inbox, dec(id));
      if (!uids.length) return;
      await inFolder(f.inbox, async () => {
        await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        await client.messageMove(uids, f.archive, { uid: true });
      });
      forget(f.inbox, f.archive);
    })()),

    unarchive: (id, unread) => done((async () => {
      await open();
      const f = await folders();
      const uids = await uidsFor(f.archive, dec(id));
      if (uids.length) await inFolder(f.archive, () => client.messageMove(uids, f.inbox, { uid: true }));
      forget(f.inbox, f.archive);
      if (unread) {
        const back = await uidsFor(f.inbox, dec(id));
        const last = back.sort((a, b) => a - b).pop();
        if (last) await inFolder(f.inbox, () => client.messageFlagsRemove([last], ['\\Seen'], { uid: true }));
      }
    })()),

    markRead: (id) => done((async () => {
      await open();
      const uids = await uidsFor('INBOX', dec(id));
      if (uids.length) await inFolder('INBOX', () => client.messageFlagsAdd(uids, ['\\Seen'], { uid: true }));
    })()),

    // IMAP can't hold server-side filters — rlyfe's sync archives this sender's mail instead
    addIgnoreRule: async (sender) => `rlyfe:${sender}`,
    removeIgnoreRule: async () => {},

    sendReply: (t, to, cc, text) => done((async () => {
      await open();
      const domain = me.split('@')[1] || 'rlyfe.app';
      const messageId = `<${crypto.randomUUID()}@${domain}>`;
      const { raw } = buildReply(t, { email, displayName: '', signatureHtml: '' }, to, cc, text, { messageId, date: new Date() });
      const source = dec(raw);
      const rcpt = [...to, ...cc].map(a => a.match(/<([^>]+)>/)?.[1] ?? a.trim());
      await newSmtp(c).sendMail({ envelope: { from: email, to: rcpt }, raw: source });

      // Most IMAP services don't file SMTP mail in Sent — check, and file it ourselves if not
      const f = await folders();
      await new Promise(r => setTimeout(r, 2500));
      forget(f.sent);
      const filed = (await indexFolder(f.sent, 2)).some(r => r.messageId === messageId);
      if (!filed) await client.append(f.sent, source, ['\\Seen']);
      forget(f.sent);
      return { id: messageId };
    })()),
  };
}

// Sign-in check used when connecting: IMAP login + SMTP login, nothing else
export async function testCreds(c: ImapCreds): Promise<void> {
  const client = newImapClient(c);
  await client.connect();
  await client.logout().catch(() => {});
  await newSmtp(c).verify();
}
