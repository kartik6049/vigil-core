/**
 * The JWT lives in memory plus sessionStorage (gone when the tab closes), never localStorage.
 * Trade-off vs an httpOnly cookie: any script running on this page could read the token (XSS),
 * whereas an httpOnly cookie is invisible to scripts but needs CSRF protection and a same-site
 * API. We avoid XSS by escaping all output and loading only a few pinned third-party scripts,
 * and the token expires after 1 hour.
 */
const KEY = 'vigil.session';

export function decodeExp(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function saveSession(token, user) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ token, user }));
  } catch {
    /* private mode: the in-memory copy still works for this page load */
  }
}

export function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (s && s.token && decodeExp(s.token) > Date.now() + 5000) return s;
  } catch {
    /* fall through */
  }
  clearSession();
  return null;
}

export function clearSession() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
