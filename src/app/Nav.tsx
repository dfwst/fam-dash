import { NavLink } from 'react-router-dom';

// The five fixed places. On a phone they're the bottom bar; on a wide screen, a left rail.
// Mail's tabs (Life, DFWST, Karen…) vary per person, so they live inside Mail, not here.
export type Place = 'today' | 'mail' | 'todos' | 'review' | 'you';

const ICONS: Record<Place, React.ReactNode> = {
  today: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m3.5 7.5 8.5 6 8.5-6" /></>,
  todos: <><rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="m8 12.5 3 3 5.5-6.5" /></>,
  review: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  you: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1-4 4-5.5 7.5-5.5s6.5 1.5 7.5 5.5" /></>,
};

const ITEMS: { place: Place; to: string; label: string }[] = [
  { place: 'today', to: '/today', label: 'Today' },
  { place: 'mail', to: '/mail', label: 'Mail' },
  { place: 'todos', to: '/todos', label: 'To-Do' },
  { place: 'review', to: '/review', label: 'Review' },
  { place: 'you', to: '/settings', label: 'You' },
];

export default function Nav({ current, mailCount, urgent, className }: {
  current: Place | null; mailCount: number; urgent: boolean; className: string;
}) {
  return (
    <nav className={className} aria-label="Main">
      {ITEMS.map(i => (
        <NavLink key={i.place} to={i.to} className={current === i.place ? 'nav-item active' : 'nav-item'}
                 aria-current={current === i.place ? 'page' : undefined}
                 // Tapping the place you're already on jumps back to the top, like a native app
                 onClick={e => {
                   if (current === i.place && !location.pathname.startsWith('/t/')) {
                     e.preventDefault();
                     window.scrollTo({ top: 0, behavior: 'smooth' });
                   }
                 }}>
          <span className="nav-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden>{ICONS[i.place]}</svg>
            {i.place === 'mail' && mailCount > 0 && (
              <span className={urgent ? 'nav-badge urgent' : 'nav-badge'} aria-label={`${mailCount} waiting`}>{mailCount > 99 ? '99+' : mailCount}</span>
            )}
          </span>
          <span className="nav-label">{i.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
