// POST (signed in, 2FA) — one-time "clean up old mail" for an IMAP account (Yahoo, AOL, iCloud…).
//
//   { action: 'preview', accountId, cutoffDays }   counts only — changes nothing
//   { action: 'run',     accountId, cutoffDays, batchId? }   archive in chunks; call again while remaining > 0
//   { action: 'undo',    accountId, batchId }       put it all back (call again while remaining > 0)
//
// Archives (moves to Archive + marks read) inbox mail received before the cutoff, EXCEPT:
//   - messages you starred (flagged)
//   - mail from people you've written to (anyone in your Sent folder's To/Cc)
//   - senders / companies you've marked Real in rlyfe
// Never deletes. Every archived Message-ID is recorded in cleanup_batches so Undo can find it.
import { requireMember, type Ctx } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';
import { decrypt } from '../_shared/crypto.ts';
import { findFolders, newImapClient, type ImapCreds } from '../_shared/imap.ts';

const BUDGET_MS = 100_000;  // leave room under the function time limit; the app calls again
const CHUNK = 250;          // messages per MOVE command
const PERSONAL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'aol.com', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'att.net', 'sbcglobal.net', 'comcast.net']);

class Refused extends Error {}
// deno-lint-ignore no-explicit-any
type Client = any;
type Env = { uid: number; from: string; subject: string; date: string; messageId?: string; flagged: boolean; seen: boolean };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const ctx = await requireMember(req);
  if (ctx instanceof Response) return ctx;

  const body = await req.json().catch(() => ({}));
  const started = Date.now();
  let client: Client = null;
  try {
    const { data: acct } = await ctx.admin.from('connected_accounts').select('id, email, provider')
      .eq('id', String(body.accountId ?? '')).eq('household_id', ctx.householdId).maybeSingle();
    if (!acct || acct.provider !== 'imap') throw new Refused('not-found');
    const { data: s } = await ctx.admin.from('account_secrets').select('refresh_token_enc').eq('account_id', acct.id).single();
    client = newImapClient(JSON.parse(await decrypt(s!.refresh_token_enc)) as ImapCreds);
    await client.connect();
    const folders = await findFolders(client);

    switch (body.action) {
      case 'preview': return json(await preview(ctx, client, folders, cutoffFrom(body.cutoffDays)));
      case 'run':     return json(await run(ctx, client, folders, acct.id, cutoffFrom(body.cutoffDays), body.batchId, started));
      case 'undo':    return json(await undo(ctx, client, folders, acct.id, String(body.batchId ?? ''), started));
      default:        return json({ error: 'unknown-action' }, 400);
    }
  } catch (e) {
    if (e instanceof Refused) return json({ error: e.message }, 400);
    const msg = e instanceof Error ? e.message : String(e);
    console.error('old-mail failed', body.action, msg);
    return json({ error: /auth|credential/i.test(msg) ? 'needs-reconnect' : 'cleanup-failed' }, 502);
  } finally {
    await client?.logout().catch(() => {});
  }
});

function cutoffFrom(days: unknown): Date {
  const d = Number(days);
  if (![30, 90, 180, 365].includes(d)) throw new Refused('bad-cutoff');
  return new Date(Date.now() - d * 86_400_000);
}

const addr = (a?: { address?: string }) => (a?.address ?? '').toLowerCase();

async function inFolder<T>(client: Client, path: string, fn: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(path);
  try { return await fn(); } finally { lock.release(); }
}

// Old inbox mail with the facts needed to decide
async function oldInbox(client: Client, cutoff: Date): Promise<Env[]> {
  return inFolder(client, 'INBOX', async () => {
    const uids: number[] = (await client.search({ before: cutoff }, { uid: true })) || [];
    const out: Env[] = [];
    if (!uids.length) return out;
    for await (const m of client.fetch(uids, { uid: true, flags: true, envelope: true }, { uid: true })) {
      out.push({
        uid: m.uid,
        from: addr(m.envelope?.from?.[0]),
        subject: (m.envelope?.subject ?? '').slice(0, 120),
        date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : '',
        messageId: m.envelope?.messageId || undefined,
        flagged: !!m.flags?.has('\\Flagged'),
        seen: !!m.flags?.has('\\Seen'),
      });
    }
    return out;
  });
}

// Everyone you've written to (last 5 years of Sent)
async function peopleYouWrote(client: Client, sent: string): Promise<Set<string>> {
  const people = new Set<string>();
  await inFolder(client, sent, async () => {
    const uids: number[] = (await client.search({ since: new Date(Date.now() - 5 * 365 * 86_400_000) }, { uid: true })) || [];
    if (!uids.length) return;
    for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
      for (const a of [...(m.envelope?.to ?? []), ...(m.envelope?.cc ?? [])]) if (addr(a)) people.add(addr(a));
    }
  }).catch(() => {}); // no Sent folder → nobody
  return people;
}

async function keepRules(ctx: Ctx, client: Client, sent: string) {
  const [wrote, { data: sp }, { data: dp }] = await Promise.all([
    peopleYouWrote(client, sent),
    ctx.admin.from('sender_prefs').select('sender_email').eq('household_id', ctx.householdId).eq('bucket', 3),
    ctx.admin.from('domain_prefs').select('domain').eq('household_id', ctx.householdId).eq('bucket', 3),
  ]);
  const realSenders = new Set((sp ?? []).map(r => r.sender_email));
  const realDomains = new Set((dp ?? []).map(r => r.domain));
  return (m: Env): string | null => {
    if (m.flagged) return 'starred';
    if (wrote.has(m.from)) return 'you wrote to them';
    const domain = m.from.split('@')[1] ?? '';
    if (realSenders.has(m.from) || (!PERSONAL.has(domain) && realDomains.has(domain))) return 'marked Real';
    if (!m.messageId) return 'no message id'; // can't be found again for Undo → leave it
    return null;
  };
}

function top(list: string[], n: number) {
  const counts = new Map<string, number>();
  for (const x of list) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([sender, count]) => ({ sender, count }));
}

// ── preview ─────────────────────────────────────────────────────────

async function preview(ctx: Ctx, client: Client, f: { sent: string }, cutoff: Date) {
  const [old, keep] = await Promise.all([oldInbox(client, cutoff), keepRules(ctx, client, f.sent)]);
  const kept = old.map(m => ({ m, why: keep(m) })).filter(x => x.why);
  const archive = old.filter(m => !keep(m));
  const reasons: Record<string, number> = {};
  for (const k of kept) reasons[k.why!] = (reasons[k.why!] ?? 0) + 1;
  const status = await client.status('INBOX', { messages: true }).catch(() => ({ messages: null }));
  return {
    cutoff: cutoff.toISOString(),
    inboxTotal: status.messages,
    totalOld: old.length,
    toArchive: archive.length,
    unreadToArchive: archive.filter(m => !m.seen).length,
    keep: kept.length,
    keepReasons: reasons,
    topArchived: top(archive.map(m => m.from), 10),
    keptSamples: kept.slice(0, 25).map(({ m, why }) => ({ from: m.from, subject: m.subject, date: m.date, why })),
  };
}

// ── run ─────────────────────────────────────────────────────────────

async function run(ctx: Ctx, client: Client, f: { archive: string; sent: string }, accountId: string,
  cutoff: Date, batchId: unknown, started: number) {
  let batch: { id: string; message_ids: string[]; unread_ids: string[]; archived: number; cutoff: string };
  if (typeof batchId === 'string' && batchId) {
    const { data } = await ctx.admin.from('cleanup_batches').select('id, message_ids, unread_ids, archived, cutoff, status')
      .eq('id', batchId).eq('account_id', accountId).eq('household_id', ctx.householdId).maybeSingle();
    if (!data || data.status !== 'running') throw new Refused('bad-batch');
    batch = data;
    cutoff = new Date(data.cutoff); // keep the cutoff the run started with
  } else {
    const { data, error } = await ctx.admin.from('cleanup_batches').insert({
      household_id: ctx.householdId, account_id: accountId, cutoff: cutoff.toISOString(), created_by: ctx.userId,
    }).select('id, message_ids, unread_ids, archived, cutoff').single();
    if (error) throw error;
    batch = data;
  }

  const [old, keep] = await Promise.all([oldInbox(client, cutoff), keepRules(ctx, client, f.sent)]);
  const todo = old.filter(m => !keep(m));
  const keptCount = old.length - todo.length;
  const ids = [...batch.message_ids];
  const unread = [...batch.unread_ids];
  let moved = 0;

  for (let i = 0; i < todo.length && Date.now() - started < BUDGET_MS; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const uids = chunk.map(m => m.uid);
    await inFolder(client, 'INBOX', async () => {
      await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      await client.messageMove(uids, f.archive, { uid: true });
    });
    ids.push(...chunk.map(m => m.messageId!));
    unread.push(...chunk.filter(m => !m.seen).map(m => m.messageId!));
    moved += chunk.length;
    // Record as we go, so Undo knows about every moved message even if this call is cut short
    await ctx.admin.from('cleanup_batches').update({
      message_ids: ids, unread_ids: unread, archived: batch.archived + moved, kept: keptCount,
    }).eq('id', batch.id);
  }

  const remaining = todo.length - moved;
  if (remaining === 0) {
    await ctx.admin.from('cleanup_batches').update({ status: 'done', kept: keptCount, finished_at: new Date().toISOString() })
      .eq('id', batch.id);
  }
  return { batchId: batch.id, archived: batch.archived + moved, kept: keptCount, remaining };
}

// ── undo ────────────────────────────────────────────────────────────

async function undo(ctx: Ctx, client: Client, f: { archive: string }, accountId: string, batchId: string, started: number) {
  const { data: b } = await ctx.admin.from('cleanup_batches')
    .select('id, cutoff, status, message_ids, unread_ids, restored')
    .eq('id', batchId).eq('account_id', accountId).eq('household_id', ctx.householdId).maybeSingle();
  if (!b || b.status === 'undone') throw new Refused('nothing-to-undo');
  if (b.status !== 'undoing') await ctx.admin.from('cleanup_batches').update({ status: 'undoing' }).eq('id', b.id);

  const wanted = new Set<string>(b.message_ids);
  const unread = new Set<string>(b.unread_ids);
  const cutoff = new Date(b.cutoff);

  // Find them in Archive (they kept their original dates, so they're all before the cutoff)
  const found = await inFolder(client, f.archive, async () => {
    const uids: number[] = (await client.search({ before: new Date(cutoff.getTime() + 86_400_000) }, { uid: true })) || [];
    const out: { uid: number; id: string }[] = [];
    if (!uids.length) return out;
    for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
      if (m.envelope?.messageId && wanted.has(m.envelope.messageId)) out.push({ uid: m.uid, id: m.envelope.messageId });
    }
    return out;
  });

  let moved = 0;
  for (let i = 0; i < found.length && Date.now() - started < BUDGET_MS; i += CHUNK) {
    const uids = found.slice(i, i + CHUNK).map(x => x.uid);
    await inFolder(client, f.archive, () => client.messageMove(uids, 'INBOX', { uid: true }));
    moved += uids.length;
  }
  const remaining = found.length - moved;

  if (remaining === 0) {
    // Make the ones that were unread unread again
    await inFolder(client, 'INBOX', async () => {
      const uids: number[] = (await client.search({ before: new Date(cutoff.getTime() + 86_400_000), seen: true }, { uid: true })) || [];
      const back: number[] = [];
      if (uids.length) {
        for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          if (m.envelope?.messageId && unread.has(m.envelope.messageId)) back.push(m.uid);
        }
      }
      for (let i = 0; i < back.length; i += CHUNK) {
        await client.messageFlagsRemove(back.slice(i, i + CHUNK), ['\\Seen'], { uid: true });
      }
    });
    await ctx.admin.from('cleanup_batches').update({
      status: 'undone', undone_at: new Date().toISOString(), restored: b.restored + moved,
    }).eq('id', b.id);
  } else {
    await ctx.admin.from('cleanup_batches').update({ restored: b.restored + moved }).eq('id', b.id);
  }
  return { restored: b.restored + moved, remaining };
}
