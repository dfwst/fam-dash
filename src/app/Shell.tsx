import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import TabPage from './TabPage';
import Settings from './Settings';
import Review from './Review';

export type Tab = { id: string; slug: string; name: string; sort_order: number };

export default function Shell() {
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [error, setError] = useState('');
  const [urgentTabs, setUrgentTabs] = useState<Set<string>>(new Set());

  // The only "badge" in the app: a small red dot on a tab holding a declined
  // payment or security alert. Nothing else gets a counter.
  useEffect(() => {
    const check = () => supabase.from('email_threads')
      .select('user_bucket, connected_accounts(default_tab_id)')
      .eq('in_inbox', true).eq('priority', true).in('category', ['payment_issue', 'security'])
      .then(({ data }) => {
        const ids = (data ?? [])
          .filter(r => r.user_bucket == null || r.user_bucket === 3)
          .map(r => (r.connected_accounts as unknown as { default_tab_id: string | null } | null)?.default_tab_id)
          .filter((x): x is string => !!x);
        setUrgentTabs(new Set(ids));
      });
    check();
    const onFocus = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, []);

  useEffect(() => {
    supabase
      .from('tabs')
      .select('id, slug, name, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data, error }) => {
        if (error) setError(error.message);
        setTabs(data ?? []);
      });
  }, []);

  if (!tabs) return <div className="center muted">Loading…</div>;

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand">rlyfe</NavLink>
        <div className="topbar-actions">
          <NavLink to="/review" className="link">Review</NavLink>
          <NavLink to="/settings" className="link">Settings</NavLink>
          <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>

      {tabs.length > 0 && (
        <nav className="tabs">
          {tabs.map(t => (
            <NavLink key={t.id} to={`/${t.slug}`} className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
              {t.name}
              {urgentTabs.has(t.id) && <span className="dot" aria-label="needs attention" />}
            </NavLink>
          ))}
        </nav>
      )}

      <main className="content">
        {error && <p className="error">{error}</p>}
        {tabs.length === 0 ? (
          <p className="center muted">No tabs to show yet.</p>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to={`/${tabs[0].slug}`} replace />} />
            {tabs.map(t => <Route key={t.id} path={`/${t.slug}`} element={<TabPage tab={t} />} />)}
            <Route path="/settings" element={<Settings />} />
            <Route path="/review" element={<Review />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
