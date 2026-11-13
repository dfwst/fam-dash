import type { Tab } from './Shell';

// Milestone 0: every tab is empty. The to-do list arrives in Milestone 3.
export default function TabPage({ tab }: { tab: Tab }) {
  return (
    <section className="caught-up" aria-label={tab.name}>
      <div className="check" aria-hidden>✓</div>
      <h2>All caught up.</h2>
    </section>
  );
}
