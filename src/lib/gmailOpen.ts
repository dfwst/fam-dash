// "Open in Gmail": on a computer that's the Gmail website; on an iPhone, the Gmail app.
// Google doesn't publish a supported link for "open THIS email in THIS account" in the
// iPhone app, so there are a few candidate formats. Settings → "Open in Gmail" lets you
// test them on your phone and pick the one that works; the choice is saved per device.

export type OpenMode = 'web' | 'web_u' | 'app' | 'app_thread' | 'app_cv';

export const OPEN_MODES: { mode: OpenMode; label: string; help: string }[] = [
  { mode: 'app', label: 'Gmail app (inbox)', help: 'Opens the app on whatever account you used last. Always works.' },
  { mode: 'app_thread', label: 'Gmail app → this email (format A)', help: 'googlegmail:///thread?th=… — unofficial' },
  { mode: 'app_cv', label: 'Gmail app → this email (format B)', help: 'googlegmail:///cv=… — unofficial' },
  { mode: 'web_u', label: 'Gmail link that may open the app', help: 'mail.google.com/mail/u/<account>/… — opens the app only if iOS hands it over' },
  { mode: 'web', label: 'Gmail website', help: 'Opens in Safari, signed in as the right account.' },
];

const KEY = 'rlyfe.gmailOpenMode';

export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function getOpenMode(): OpenMode {
  try {
    const saved = localStorage.getItem(KEY) as OpenMode | null;
    if (saved && OPEN_MODES.some(m => m.mode === saved)) return saved;
  } catch { /* private mode etc. */ }
  return isIOS() ? 'app' : 'web';
}

export function setOpenMode(mode: OpenMode) {
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
}

export function gmailUrl(email: string, threadId: string, mode: OpenMode = getOpenMode()): string {
  const e = encodeURIComponent(email);
  switch (mode) {
    case 'app': return 'googlegmail://';
    case 'app_thread': return `googlegmail:///thread?th=${threadId}&account=${e}`;
    case 'app_cv': return `googlegmail:///cv=${threadId}/accountId=${e}/searchview=1`;
    case 'web_u': return `https://mail.google.com/mail/u/${e}/#all/${threadId}`;
    default: return `https://mail.google.com/mail/u/?authuser=${e}#all/${threadId}`;
  }
}

export const opensInNewTab = (mode: OpenMode = getOpenMode()) => mode === 'web' || mode === 'web_u';
