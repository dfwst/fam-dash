import { ARCHIVE_NOTE, BUCKETS, BUCKET_ORDER } from '../lib/buckets';

// "How rlyfe sorts your mail" — the one explanation of Important / Glance / Noise and what
// happens to each. Shown wherever someone has to decide something about sorting.
export default function SortingGuide({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'guide compact' : 'guide'}>
      <ul className="guide-list">
        {BUCKET_ORDER.map(b => (
          <li key={b} className={`guide-row b${b}`}>
            <span className="guide-dot" aria-hidden />
            <div>
              <div className="guide-name">{BUCKETS[b].name} <span className="guide-what">{BUCKETS[b].what}</span></div>
              <div className="guide-then">{BUCKETS[b].then}</div>
            </div>
          </li>
        ))}
      </ul>
      {!compact && (
        <p className="guide-note">
          By default rlyfe only sorts what <em>you see here</em> — your real inbox is untouched. If you turn on
          <strong> Morning cleanup</strong> for an account (You › Accounts), Noise — and Glance, if you choose — is
          also cleared out of that inbox each morning. {ARCHIVE_NOTE}
        </p>
      )}
    </div>
  );
}
