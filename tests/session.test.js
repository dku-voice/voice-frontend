import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSession, readSession, clearSession } from '../src/integration/session.js';
const store = () => { const map = new Map(); return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) }; };
const token = (claims) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

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

test('JWT exp가 있으면 임의의 24시간 대신 서버 토큰의 만료 시각을 사용한다', () => {
  for (const exp of [3600, 48 * 60 * 60]) {
    const storage = store();
    const session = saveSession({ accessToken: token({ exp, name: '직원' }), role: 'STAFF' }, storage, 1000);
    assert.equal(session.expiresAt, exp * 1000);
    assert.deepEqual(readSession(storage, exp * 1000 - 1), session);
    assert.equal(readSession(storage, exp * 1000), null);
  }
});

test('이미 만료된 JWT를 로그인 성공으로 저장하거나 기존 유효 세션을 덮어쓰지 않는다', () => {
  const storage = store();
  const previous = saveSession({ accessToken: 'existing-token', role: 'ADMIN' }, storage, 1000);
  assert.throws(() => saveSession({ accessToken: token({ exp: 2 }), role: 'STAFF' }, storage, 2000), /이미 만료/);
  assert.deepEqual(readSession(storage, 2000), previous);
});

test('JWT exp가 없거나 해석할 수 없으면 기존 24시간 fallback을 유지한다', () => {
  for (const accessToken of ['opaque-token', 'header.not-base64.signature', token({}), token({ exp: '3600' }), token({ exp: null })]) {
    const session = saveSession({ accessToken, role: 'STAFF' }, store(), 1000);
    assert.equal(session.expiresAt, 1000 + 24 * 60 * 60 * 1000);
  }
});

test('기존에 24시간으로 저장했던 세션도 JWT exp가 먼저 만료되면 복원하지 않는다', () => {
  const storage = store();
  storage.setItem('voice-kiosk-session', JSON.stringify({ accessToken: token({ exp: 3600 }), role: 'STAFF', expiresAt: 86400000 }));
  assert.equal(readSession(storage, 3600000), null);
  assert.equal(storage.getItem('voice-kiosk-session'), null);
});
