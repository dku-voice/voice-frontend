import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSession, readSession, clearSession } from '../src/integration/session.js';
const store = () => { const map = new Map(); return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) }; };

test('로그인 응답 중 토큰·권한·24시간 만료만 저장하고 비밀번호는 저장하지 않는다', () => {
  const storage = store();
  const session = saveSession({ accessToken: 'mock-token', role: 'STAFF', password: 'ignored' }, storage, 1000);
  assert.equal(session.expiresAt, 1000 + 24 * 60 * 60 * 1000);
  assert.deepEqual(Object.keys(session).sort(), ['accessToken', 'expiresAt', 'role']);
  assert.deepEqual(readSession(storage, 2000), session);
});

test('만료되었거나 손상된 세션은 복원하지 않는다', () => {
  const storage = store();
  const session = saveSession({ accessToken: 'mock-token', role: 'ADMIN' }, storage, 1000);
  assert.equal(readSession(storage, session.expiresAt), null);
  storage.setItem('voice-kiosk-session', '{broken');
  assert.equal(readSession(storage), null);
});

test('지원하지 않는 권한과 잘못된 토큰은 저장하지 않는다', () => {
  assert.throws(() => saveSession({ accessToken: '', role: 'ADMIN' }, store()));
  assert.throws(() => saveSession({ accessToken: 'mock token', role: 'STAFF' }, store()));
  assert.throws(() => saveSession({ accessToken: 'mock-token', role: 'USER' }, store()));
});

test('로그아웃 후 토큰은 제거되고 저장소가 차단되어도 메모리 로그인 결과를 사용할 수 있다', () => {
  const storage = store();
  saveSession({ accessToken: 'mock-token', role: 'ADMIN' }, storage);
  clearSession(storage);
  assert.equal(readSession(storage), null);
  const blocked = { setItem() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(saveSession({ accessToken: 'mock-token', role: 'ADMIN' }, blocked).role, 'ADMIN');
  assert.equal(readSession(blocked), null);
  clearSession(blocked);
});
