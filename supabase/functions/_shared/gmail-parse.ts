// Turn a Gmail thread (format=full) into the facts the sorter needs.
// Message bodies are used only to sort/summarize — they are never stored.

type Header = { name: string; value: string };
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] };
export type GmailMessage = {
  id: string; labelIds?: string[]; internalDate: string; snippet?: string; payload: Part;
};
export type GmailThread = { id: string; historyId: string; messages: GmailMessage[] };

export type ThreadFacts = {
  threadId: string;
  lastMessageId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  to: string;
  date: Date;
  snippet: string;
  messageCount: number;
  unread: boolean;
  lastFromMe: boolean;
  labels: string[];
  hasUnsubscribe: boolean;
  text: string; // latest message(s), cleaned and trimmed — for Claude only
};

const header = (m: GmailMessage, name: string) =>
  m.payload.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function b64urlText(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function findPart(p: Part, mime: string): Part | null {
  if (p.mimeType === mime && p.body?.data) return p;
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Drop quoted history ("On … wrote:", "> …", forwarded headers) and squeeze whitespace
function clean(text: string): string {
  const cut = text.search(/\n\s*(On .{0,200}wrote:|-{2,}\s*Original Message\s*-{2,}|From: .{0,200}\n\s*Sent: )/i);
  const body = cut > 0 ? text.slice(0, cut) : text;
  return body
    .split('\n').filter(l => !l.trim().startsWith('>')).join('\n')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function messageText(m: GmailMessage): string {
  const plain = findPart(m.payload, 'text/plain');
  if (plain) return clean(b64urlText(plain.body!.data!));
  const html = findPart(m.payload, 'text/html');
  if (html) return clean(htmlToText(b64urlText(html.body!.data!)));
  return m.snippet ?? '';
}

export function parseFrom(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2], email: m[2].trim().toLowerCase() };
  return { name: raw.trim(), email: raw.trim().toLowerCase() };
}

export function threadFacts(t: GmailThread, accountEmail: string): ThreadFacts {
  const msgs = t.messages;
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  const from = parseFrom(header(last, 'From'));
  const labels = [...new Set(msgs.flatMap(m => m.labelIds ?? []))];
  const lastFromMe = (last.labelIds ?? []).includes('SENT') || from.email === accountEmail.toLowerCase();

  // Latest message, plus the one before it when you sent the latest (gives Claude the context)
  const parts = [`[Latest message from ${from.name}]\n${messageText(last).slice(0, 2500)}`];
  if (lastFromMe && msgs.length > 1) {
    const prev = msgs[msgs.length - 2];
    parts.push(`[Previous message from ${parseFrom(header(prev, 'From')).name}]\n${messageText(prev).slice(0, 1500)}`);
  }

  return {
    threadId: t.id,
    lastMessageId: last.id,
    subject: header(first, 'Subject') || header(last, 'Subject') || '(no subject)',
    fromName: from.name,
    fromEmail: from.email,
    to: header(last, 'To'),
    date: new Date(Number(last.internalDate)),
    snippet: last.snippet ?? '',
    messageCount: msgs.length,
    unread: msgs.some(m => m.labelIds?.includes('UNREAD')),
    lastFromMe,
    labels,
    hasUnsubscribe: msgs.some(m => header(m, 'List-Unsubscribe') !== ''),
    text: parts.join('\n\n'),
  };
}
