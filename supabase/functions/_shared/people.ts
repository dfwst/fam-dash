// Who a mailbox belongs to, in words Claude can use: name + what matters to them.
// Comes from household_members.profile (the "help rlyfe sort" answers).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';

export type Person = { name: string; about: string };

const LABELS: Record<string, string> = {
  family: 'Family', kids: 'Kids & school', church: 'Church & volunteering', work: 'Work',
  important: 'Always important', noise: 'Usually noise', other: 'Also',
};

export function describe(name: string, profile: Record<string, unknown> | null | undefined): Person {
  const lines = Object.entries(profile ?? {})
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `- ${LABELS[k] ?? k}: ${String(v).trim().slice(0, 600)}`);
  return { name: name || 'the account owner', about: lines.join('\n') || '- (no details given yet)' };
}

const cache = new Map<string, Promise<Person>>();
export function loadPerson(admin: SupabaseClient, userId: string): Promise<Person> {
  if (!cache.has(userId)) {
    cache.set(userId, Promise.resolve(admin.from('household_members').select('display_name, profile').eq('user_id', userId).limit(1).maybeSingle())
      .then(({ data }) => describe(data?.display_name ?? '', data?.profile as Record<string, unknown> | null)));
  }
  return cache.get(userId)!;
}

// Where a newly connected account lands: one of the connecting person's OWN tabs —
// the one named `prefer` (e.g. 'able' for a work Microsoft account) if they have it, else their first.
export async function defaultTabFor(admin: SupabaseClient, householdId: string, userId: string, prefer?: string): Promise<string | null> {
  const { data } = await admin.from('tabs').select('id, slug')
    .eq('household_id', householdId).eq('owner_id', userId).eq('is_active', true).order('sort_order');
  return (data ?? []).find(t => t.slug === prefer)?.id ?? data?.[0]?.id ?? null;
}
