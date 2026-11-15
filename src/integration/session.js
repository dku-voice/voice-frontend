const SESSION_KEY = 'voice-kiosk-session';

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
      || session.expiresAt <= now) {
      storage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(data, storage = browserSessionStorage, now = Date.now()) {
  if (typeof data?.accessToken !== 'string' || !data.accessToken.trim()
    || /\s/.test(data.accessToken) || !['ADMIN', 'STAFF'].includes(data.role)) {
    throw new Error('로그인 응답을 확인할 수 없습니다.');
  }
  const session = { accessToken: data.accessToken, role: data.role, expiresAt: now + 24 * 60 * 60 * 1000 };
  // A blocked browser store still permits an in-memory session until the page closes.
  try { storage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* Memory only. */ }
  return session;
}

export function clearSession(storage = browserSessionStorage) {
  try { storage.removeItem(SESSION_KEY); } catch { /* Memory state is also cleared by the caller. */ }
}
