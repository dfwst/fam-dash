// Invite links look like https://rlyfe.app/join/<token>. The token is remembered on this device
// through sign-up, email confirmation and 2FA setup, then used once to join the household.
const KEY = 'rlyfe.joinToken';

export function captureJoinToken() {
  const m = window.location.pathname.match(/^\/join\/([0-9a-f]{48})\/?$/);
  if (!m) return;
  try { localStorage.setItem(KEY, m[1]); } catch { /* private mode */ }
  window.history.replaceState(null, '', '/'); // the token shouldn't linger in the address bar
}

export const getJoinToken = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const clearJoinToken = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } };
