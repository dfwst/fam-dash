// "Open in Gmail": the Gmail website on a computer, the Gmail app on an iPhone.
//
// Tested on Jason's iPhone (Nov 2026): the Gmail app opens from a googlegmail:// link but
// ignores anything after it — thread ids, account, and search all land on the inbox.
// Google publishes no deep link to a specific email, so on iPhone this just opens the app;
// reading, Done/Ignore/Remind and (M5) replies happen inside rlyfe instead.

export type OpenMode = 'web' | 'app';

export const OPEN_MODES: { mode: OpenMode; label: string; help: string }[] = [
  { mode: 'app', label: 'Gmail app', help: 'Opens the app (on the account you used last — it can’t jump to the email).' },
  { mode: 'web', label: 'Gmail website', help: 'Opens the exact email, signed in as the right account, in the browser.' },
];

const KEY = 'rlyfe.gmailOpenMode';

export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function getOpenMode(): OpenMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'app' || saved === 'web') return saved;
    if (saved) return 'app'; // an earlier test format — they all behaved like "open the app"
  } catch { /* private mode etc. */ }
  return isIOS() ? 'app' : 'web';
}

export function setOpenMode(mode: OpenMode) {
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
}

// subject is unused now; kept so callers don't change if a real deep link ever appears
export function gmailUrl(email: string, threadId: string, mode: OpenMode = getOpenMode(), _subject?: string | null): string {
  if (mode === 'app') return 'googlegmail://';
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${threadId}`;
}

export const opensInNewTab = (mode: OpenMode = getOpenMode()) => mode === 'web';
