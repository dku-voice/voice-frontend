const SESSION_KEY = 'voice-kiosk-session';
const FALLBACK_DURATION = 24 * 60 * 60 * 1000;

// This only reads an expiry hint for UI/session timing. JWT signature and access
// permissions must still be checked by the backend on every protected request.
const tokenExpiry = (token) => {
  try {
    const segments = token.split('.');
    if (segments.length !== 3 || !segments[1] || typeof globalThis.atob !== 'function') return null;
    const encoded = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const bytes = Uint8Array.from(globalThis.atob(padded), (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const expiresAt = payload?.exp * 1000;
    return typeof payload?.exp === 'number' && Number.isFinite(expiresAt)
      && Math.abs(expiresAt) <= 8.64e15 ? expiresAt : null;
  } catch {
    return null;
  }
};

export const browserSessionStorage = {
  getItem: (key) => typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
  removeItem: (key) => sessionStorage.removeItem(key),
};

export function readSession(storage = browserSessionStorage, now = Date.now()) {
  try {
    const session = JSON.parse(storage.getItem(SESSION_KEY));
    if (!session || typeof session.accessToken !== 'string' || !session.accessToken.trim()
      || !['ADMIN', 'STAFF'].includes(session.role) || !Number.isFinite(session.expiresAt)
      || /\s/.test(session.accessToken)) {
      storage.removeItem(SESSION_KEY);
      return null;
    }
    const expiresAt = tokenExpiry(session.accessToken) ?? session.expiresAt;
    if (expiresAt <= now) {
      storage.removeItem(SESSION_KEY);
      return null;
    }
    return { accessToken: session.accessToken, role: session.role, expiresAt };
  } catch {
    return null;
  }
}

export function saveSession(data, storage = browserSessionStorage, now = Date.now()) {
  if (typeof data?.accessToken !== 'string' || !data.accessToken.trim()
    || /\s/.test(data.accessToken) || !['ADMIN', 'STAFF'].includes(data.role)) {
    throw new Error('로그인 응답을 확인할 수 없습니다.');
  }
  const expiresAt = tokenExpiry(data.accessToken) ?? now + FALLBACK_DURATION;
  if (expiresAt <= now) throw new Error('로그인 토큰이 이미 만료되었습니다. 다시 로그인해 주세요.');
  const session = { accessToken: data.accessToken, role: data.role, expiresAt };
  // A blocked browser store still permits an in-memory session until the page closes.
  try { storage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* Memory only. */ }
  return session;
}

export function clearSession(storage = browserSessionStorage) {
  try { storage.removeItem(SESSION_KEY); } catch { /* Memory state is also cleared by the caller. */ }
}
