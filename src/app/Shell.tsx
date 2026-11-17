import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import TabPage from './TabPage';
import Settings from './Settings';
import Review from './Review';
import Logo from './Logo';
import ThreadView from './reader/ThreadView';
import Retire from './Retire';
import { usePullToRefresh } from '../lib/usePullToRefresh';
import { REFRESH_EVENT, type RefreshDetail } from '../lib/refresh';
import { callFn } from '../lib/functions';
import { clearJoinToken, getJoinToken } from '../lib/join';
import AboutYou from './AboutYou';
import AllTodos from './AllTodos';

export type Tab = { id: string; slug: string; name: string; sort_order: number };
type Me = { display_name: string | null; profile: Record<string, string>; onboarded_at: string | null };

export default function Shell() {
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [error, setError] = useState('');
  const [urgentTabs, setUrgentTabs] = useState<Set<string>>(new Set());
  const [remount, setRemount] = useState(0);

  // Pull down to refresh: the page on screen reloads its own data if it knows how
  // (keeps your place); otherwise it's opened fresh.
  const { pull, refreshing, ready } = usePullToRefresh(async () => {
    const detail: RefreshDetail = { waits: [] };
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail }));
    if (detail.waits.length) await Promise.allSettled(detail.waits);
    else setRemount(k => k + 1);
  });

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
    const onRefresh = () => { check(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
    };
  }, []);

  // Who am I in this household? Not a member yet + arrived from an invite → join now.
  const [me, setMe] = useState<Me | null | 'none'>(null);
  const [joinError, setJoinError] = useState('');
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const load = () => supabase.from('household_members').select('display_name, profile, onboarded_at')
        .eq('user_id', user?.id ?? '').limit(1).maybeSingle();
      let { data } = await load();
      const token = getJoinToken();
      if (!data && token) {
        try {
          await callFn('invite-accept', { token });
          clearJoinToken();
          ({ data } = await load());
        } catch (e) {
          const m = e instanceof Error ? e.message : 'failed';
          setJoinError(m === 'invite-expired' ? 'That invite link has expired or was already used. Ask for a new one.' : `Couldn’t join (${m}).`);
          clearJoinToken();
        }
      }
      setMe(data ? (data as Me) : 'none');
    })();
  }, []);

  useEffect(() => {
    if (!me || me === 'none') return;
    supabase
      .from('tabs')
      .select('id, slug, name, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data, error }) => {
        if (error) setError(error.message);
        setTabs(data ?? []);
      });
  }, [me]);

  if (me === 'none') {
    return (
      <main className="card-page">
        <div className="card">
          <h1 className="card-logo"><Logo height={44} /></h1>
          <p>{joinError || 'You’re signed in, but not part of a household yet.'}</p>
          <p className="muted small">Ask whoever set up rlyfe for an invite link, then open it on this device.</p>
          <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </main>
    );
  }
  if (!me || !tabs) return <div className="center muted">Loading…</div>;
  // First time in: a few quick questions so sorting knows what matters to you
  if (!me.onboarded_at && location.pathname !== '/welcome') return <Navigate to="/welcome" replace />;

  return (
    <div className="shell">
      {(pull > 0 || refreshing) && (
        <div className="ptr" style={{ height: pull }} aria-live="polite">
          <span className={refreshing ? 'ptr-icon spin' : 'ptr-icon'}
                style={refreshing ? undefined : { transform: `rotate(${pull * 3}deg)`, opacity: Math.min(1, pull / 60) }}>↻</span>
          <span className="ptr-text">{refreshing ? 'Refreshing…' : ready ? 'Release to refresh' : 'Pull to refresh'}</span>
        </div>
      )}
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="rlyfe home"><Logo height={22} /></NavLink>
        <div className="topbar-actions">
          <NavLink to="/review" className="link">Review</NavLink>
          <NavLink to="/settings" className="link">Settings</NavLink>
          <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>

      {tabs.length > 0 && (
        <nav className="tabs">
          <NavLink to="/todos" className={({ isActive }) => (isActive ? 'tab todos active' : 'tab todos')}>✓ To-Do</NavLink>
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
          <Routes key={remount}>
            <Route path="/" element={<Navigate to={`/${tabs[0].slug}`} replace />} />
            {tabs.map(t => <Route key={t.id} path={`/${t.slug}`} element={<TabPage tab={t} />} />)}
            <Route path="/todos" element={<AllTodos tabs={tabs} />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/review" element={<Review />} />
            <Route path="/t/:accountId/:threadId" element={<ThreadView />} />
            <Route path="/retire/:accountId" element={<Retire />} />
            <Route path="/welcome" element={<AboutYou me={me} first onSaved={m => setMe({ ...me, ...m })} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
