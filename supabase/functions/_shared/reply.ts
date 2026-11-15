// Build a reply that Gmail (and everyone else's mail app) threads correctly.
//   - who it goes to: Reply-To / From of the latest message that isn't yours (Reply),
//     plus everyone else on it (Reply all) — never yourself
//   - In-Reply-To + References: what makes it land in the same conversation
//   - text + HTML versions, your Gmail signature, and the quoted message underneath
import { b64urlText, findPart, header, parseFrom, type GmailMessage, type GmailThread } from './gmail-parse.ts';

export type Recipients = { to: string[]; cc: string[] };

// "A <a@x.com>, \"Last, First\" <b@y.com>, c@z.com" → one entry per address
export function splitAddresses(raw: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false, angle = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const emailOf = (addr: string) => parseFrom(addr).email;
const isMine = (m: GmailMessage, me: string) =>
  (m.labelIds ?? []).includes('SENT') || emailOf(header(m, 'From')) === me;

// The message you're answering: the newest one someone else sent (or your own, if it's all you)
export function replyBase(t: GmailThread, accountEmail: string): GmailMessage {
  const me = accountEmail.toLowerCase();
  const msgs = t.messages.filter(m => !(m.labelIds ?? []).includes('DRAFT'));
  return [...msgs].reverse().find(m => !isMine(m, me)) ?? msgs[msgs.length - 1];
}

export function recipients(t: GmailThread, accountEmail: string, all: boolean): Recipients {
  const me = accountEmail.toLowerCase();
  const base = replyBase(t, accountEmail);
  const mine = isMine(base, me);

  // Following up on your own message → it goes to the people you wrote to
  const primary = mine
    ? splitAddresses(header(base, 'To'))
    : splitAddresses(header(base, 'Reply-To') || header(base, 'From'));
  const others = all
    ? [...(mine ? [] : splitAddresses(header(base, 'To'))), ...splitAddresses(header(base, 'Cc'))]
    : [];

  const seen = new Set([me]);
  const keep = (list: string[]) => list.filter(a => {
    const e = emailOf(a);
    if (!e.includes('@') || seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  const to = keep(primary);
  const cc = keep(others);
  return { to, cc };
}

// ── MIME ────────────────────────────────────────────────────────────

const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim(); // no header injection
const utf8 = new TextEncoder();

function b64(s: string): string {
  const bytes = utf8.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

// A display name: plain ASCII is quoted when it has , ; < > etc. ("Doe, Ann" must stay one address)
function displayName(name: string): string {
  const n = name.replace(/["\\]/g, '');
  if (!/^[\x20-\x7e]*$/.test(n)) return encodeWord(n);
  return /[()<>\[\]:;@,.]/.test(n) ? `"${n}"` : n;
}

function encodeAddress(addr: string): string {
  const { name, email } = parseFrom(addr);
  if (!name || name.toLowerCase() === email) return email;
  return `${displayName(name)} <${email}>`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const htmlToText = (html: string) => html
  .replace(/<br\s*\/?>|<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

export type Sender = { email: string; displayName: string; signatureHtml: string };

export function buildReply(
  t: GmailThread, from: Sender, to: string[], cc: string[], body: string,
): { raw: string; subject: string } {
  const base = replyBase(t, from.email);
  const first = t.messages[0];
  const original = header(first, 'Subject') || header(base, 'Subject');
  const subject = /^\s*re:/i.test(original) ? original : `Re: ${original}`;

  const msgId = header(base, 'Message-ID') || header(base, 'Message-Id');
  const refs = [header(base, 'References'), msgId].filter(Boolean).join(' ');

  // The message being answered, quoted underneath (mail apps fold it away)
  const when = new Date(Number(base.internalDate)).toUTCString().replace(' GMT', ' UTC');
  const who = header(base, 'From');
  const qHtmlPart = findPart(base.payload, 'text/html');
  const qTextPart = findPart(base.payload, 'text/plain');
  const qText = qTextPart ? b64urlText(qTextPart.body!.data!) : qHtmlPart ? htmlToText(b64urlText(qHtmlPart.body!.data!)) : '';
  const qHtml = qHtmlPart ? b64urlText(qHtmlPart.body!.data!) : escapeHtml(qText).replace(/\n/g, '<br>');

  const sigText = from.signatureHtml ? htmlToText(from.signatureHtml) : '';
  const text = [
    body.trim(),
    sigText ? `\n-- \n${sigText}` : '',
    `\n\nOn ${when}, ${who} wrote:\n${qText.split('\n').map(l => `> ${l}`).join('\n')}`,
  ].join('');
  const html = [
    `<div dir="ltr">${escapeHtml(body.trim()).replace(/\n/g, '<br>')}</div>`,
    from.signatureHtml ? `<br><div class="gmail_signature">${from.signatureHtml}</div>` : '',
    `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On ${escapeHtml(when)}, ${escapeHtml(who)} wrote:<br></div>`,
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${qHtml}</blockquote></div>`,
  ].join('');

  const boundary = `rlyfe_${crypto.randomUUID().replace(/-/g, '')}`;
  const fromHeader = from.displayName ? `${displayName(clean(from.displayName))} <${from.email}>` : from.email;
  const lines = [
    `From: ${fromHeader}`,
    `To: ${to.map(a => encodeAddress(clean(a))).join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.map(a => encodeAddress(clean(a))).join(', ')}`] : []),
    `Subject: ${encodeWord(clean(subject))}`,
    ...(msgId ? [`In-Reply-To: ${clean(msgId)}`, `References: ${clean(refs)}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(html)),
    `--${boundary}--`,
    '',
  ];
  const raw = b64(lines.join('\r\n')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { raw, subject };
}
