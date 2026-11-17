// The three ways rlyfe sorts mail — ONE place for the names and the "what happens" wording,
// so every screen says the same thing. (Inside the database and Claude's prompt these are
// still buckets 3 / 2 / 1, a.k.a. real / glance / junk — only what people read changed.)
export type Bucket = 1 | 2 | 3;

export const BUCKETS: Record<Bucket, { name: string; what: string; then: string }> = {
  3: {
    name: 'Important',
    what: 'A person or a deadline needs you.',
    then: 'Stays in your inbox and on your Mail list until you handle it. Never cleared for you.',
  },
  2: {
    name: 'Glance',
    what: 'Good to know, nothing to do.',
    then: 'Listed under “Worth a glance” for a week, then drops off the list.',
  },
  1: {
    name: 'Noise',
    what: 'Promotions and clutter.',
    then: 'Never shown in rlyfe.',
  },
};

export const BUCKET_LABEL: Record<Bucket, string> = { 3: BUCKETS[3].name, 2: BUCKETS[2].name, 1: BUCKETS[1].name };
export const BUCKET_ORDER: Bucket[] = [3, 2, 1];

// What "cleared" / "archived" means — said the same way everywhere
export const ARCHIVE_NOTE = 'Cleared mail is archived, never deleted: it leaves your inbox but stays in your mailbox, '
  + 'and you can put it back from Review › Activity.';

// Text saved by the server before the rename still says Real / Junk — show today's names
export const relabel = (s: string | null | undefined) =>
  (s ?? '').replace(/\bReal\b/g, 'Important').replace(/\bJunk\b/g, 'Noise');
