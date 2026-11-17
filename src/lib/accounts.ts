import { supabase } from './supabase';

export type Account = {
  id: string;
  email: string;
  provider: 'google' | 'microsoft' | 'imap';
  mail_service: 'yahoo' | 'aol' | 'icloud' | 'other' | null;
  policy: 'read_only' | 'junk_only' | 'full';
  status: 'active' | 'needs_reconnect' | 'disabled';
  default_tab_id: string | null;
  nickname: string | null;
  ai_context: string | null;   // "what's this account for?" — guides sorting
  owner_id: string;
  shared: boolean;
  tabs: { name: string } | null;
};

// "Gmail", "Microsoft", "Yahoo"… for Settings
const SERVICE_NAME = { yahoo: 'Yahoo', aol: 'AOL', icloud: 'iCloud', other: 'IMAP' } as const;
export const serviceName = (a: Pick<Account, 'provider' | 'mail_service'>) =>
  a.provider === 'google' ? 'Gmail' : a.provider === 'microsoft' ? 'Microsoft' : SERVICE_NAME[a.mail_service ?? 'other'];

export const accountLabel = (a: Account) => a.nickname || a.email.split('@')[0];

export async function loadAccounts(tabId?: string): Promise<Account[]> {
  let q = supabase
    .from('connected_accounts')
    .select('id, email, provider, mail_service, policy, status, default_tab_id, nickname, ai_context, owner_id, shared, tabs(name)')
    .order('email');
  if (tabId) q = q.eq('default_tab_id', tabId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Account[];
}

// Open a thread in Gmail, signed in as the right account
export const gmailLink = (email: string, threadId: string) =>
  `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#inbox/${threadId}`;
