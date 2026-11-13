import { supabase } from './supabase';

export type Account = {
  id: string;
  email: string;
  provider: 'google' | 'microsoft';
  policy: 'read_only' | 'junk_only' | 'full';
  status: 'active' | 'needs_reconnect' | 'disabled';
  default_tab_id: string | null;
  tabs: { name: string } | null;
};

export async function loadAccounts(tabId?: string): Promise<Account[]> {
  let q = supabase
    .from('connected_accounts')
    .select('id, email, provider, policy, status, default_tab_id, tabs(name)')
    .order('email');
  if (tabId) q = q.eq('default_tab_id', tabId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Account[];
}

// Open a thread in Gmail, signed in as the right account
export const gmailLink = (email: string, threadId: string) =>
  `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#inbox/${threadId}`;
