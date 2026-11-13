import { useEffect, useState } from 'react';
import type { Tab } from './Shell';
import { loadAccounts, type Account } from '../lib/accounts';
import InboxPreview from './InboxPreview';

// Milestone 1: shows a read-only inbox preview for each account mapped to this tab.
// Milestone 3 replaces this with the sorted to-do list.
export default function TabPage({ tab }: { tab: Tab }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);

  useEffect(() => {
    loadAccounts(tab.id).then(setAccounts).catch(() => setAccounts([]));
  }, [tab.id]);

  if (!accounts) return <p className="muted">Loading…</p>;

  if (accounts.length === 0) {
    return (
      <section className="caught-up" aria-label={tab.name}>
        <div className="check" aria-hidden>✓</div>
        <h2>All caught up.</h2>
      </section>
    );
  }

  return (
    <div className="stack-lg">
      {accounts.map(a => <InboxPreview key={a.id} account={a} />)}
    </div>
  );
}
