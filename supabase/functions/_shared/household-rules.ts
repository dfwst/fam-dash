// Household rules ("everything about Karen Williams → Karen tab"). See migration 023.
//   exact — phrases in sender / subject / recipients / text, or a listed sender (address or domain)
//   smart — a plain-words description Claude judges while sorting (classify.ts) or in bulk (apply)
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import type { Mailbox } from './mailbox.ts';

export type HouseholdRule = {
  id: string; name: string; tab_id: string | null; phrases: string[]; senders: string[];
  description: string | null; share_matches: boolean; always_real: boolean; gmail_label: string | null;
  created_by: string | null;
};

export async function loadRules(admin: SupabaseClient, householdId: string): Promise<HouseholdRule[]> {
  const { data } = await admin.from('rules')
    .select('id, name, tab_id, phrases, senders, description, share_matches, always_real, gmail_label, created_by')
    .eq('household_id', householdId).eq('enabled', true).order('created_at');
  return (data ?? []) as HouseholdRule[];
}

// A rule that doesn't share its matches only organizes its creator's own mail
export const appliesTo = (r: HouseholdRule, accountOwner: string) => r.share_matches || r.created_by === accountOwner;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

export type Facts = { fromEmail: string; fromName: string; subject: string; to?: string; text?: string };

export function exactMatch(rules: HouseholdRule[], f: Facts): HouseholdRule | null {
  const hay = norm([f.fromName, f.fromEmail, f.subject, f.to ?? '', f.text ?? ''].join(' \n '));
  const from = f.fromEmail.toLowerCase();
  const domain = from.split('@')[1] ?? '';
  for (const r of rules) {
    if (r.senders.some(s => {
      const x = s.trim().toLowerCase().replace(/^@/, '');
      return x && (x.includes('@') ? from === x : domain === x || domain.endsWith(`.${x}`));
    })) return r;
    if (r.phrases.some(p => p.trim() && hay.includes(norm(p.trim())))) return r;
  }
  return null;
}

// Record a match on the email: its tab, the rule, sharing, and Real if the rule says so
export async function markMatch(
  admin: SupabaseClient, accountId: string, threadId: string, r: HouseholdRule, mb?: Mailbox,
) {
  const values: Record<string, unknown> = {
    tab_id: r.tab_id, rule_id: r.id, shared: r.share_matches, updated_at: new Date().toISOString(),
  };
  if (r.always_real) {
    values.bucket = 3;
    values.reason = `Rule: ${r.name}`.slice(0, 200);
  }
  await admin.from('email_threads').update(values).eq('account_id', accountId).eq('thread_id', threadId);
  if (r.gmail_label && mb?.addLabel) {
    await mb.addLabel(threadId, r.gmail_label).catch(e => console.error('rule label failed', e instanceof Error ? e.message : e));
  }
}
