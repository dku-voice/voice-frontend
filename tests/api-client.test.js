import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api/client.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const success = (data) => json({ success: true, data, message: null });

test('공통 클라이언트는 상대 /api와 envelope를 사용하고 공개 요청에 저장 토큰을 붙이지 않는다', async () => {
  const client = createApiClient({ getAccessToken: () => 'saved-token', fetchImpl: async (url, options) => {
    assert.equal(url, '/api/menus');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers.Authorization, undefined);
    return success([{ menuId: 14 }]);
  } });
  assert.deepEqual(await client.request('/api/menus'), [{ menuId: 14 }]);
});

test('Bearer는 명시 토큰 또는 보호 요청의 getter로 전달하며 토큰을 URL에 넣지 않는다', async () => {
  const headers = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test/', getAccessToken: () => 'stored-token', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.example.test/api/kds/orders');
    assert.equal(url.includes('token'), false);
    headers.push(options.headers.Authorization);
    return success([]);
  } });
  await client.request('/api/kds/orders', { auth: true });
  await client.request('/api/kds/orders', { auth: true, token: 'explicit-token' });
  client.configureAuth({ getAccessToken: () => 'updated-token' });
  await client.request('/api/kds/orders', { auth: true });
  assert.deepEqual(headers, ['Bearer stored-token', 'Bearer explicit-token', 'Bearer updated-token']);
});

test('토큰 없는 보호 요청·잘못된 토큰·API 외 경로는 전송하지 않는다', async () => {
  const client = createApiClient({ fetchImpl: () => assert.fail('전송하면 안 됩니다.') });
  await assert.rejects(client.request('/api/kds/orders', { auth: true }), { code: 'AUTH_REQUIRED', status: 401 });
  await assert.rejects(client.request('/api/kds/orders', { auth: true, token: 'bad\r\ntoken' }), { code: 'INVALID_INPUT' });
  await assert.rejects(client.request('/admin/orders'), { code: 'INVALID_INPUT' });
});

test('HTTP 실패는 최신·구버전 message를 보존하고 POST를 재시도하지 않는다', async () => {
  for (const body of [
    { success: false, data: null, message: '이미 결제 완료된 주문입니다.' },
    { status: 409, message: '이미 결제 완료된 주문입니다.', timestamp: '2026-11-13' },
  ]) {
    let calls = 0;
    const client = createApiClient({ fetchImpl: async () => { calls += 1; return json(body, 409); } });
    await assert.rejects(client.request('/api/payments/confirm', { method: 'POST', body: {} }), {
      code: 'HTTP_ERROR', status: 409, message: body.message, serverMessage: body.message,
    });
    assert.equal(calls, 1);
  }
});

test('HTTP 200의 success:false와 잘못된 JSON·HTML·envelope를 성공으로 처리하지 않는다', async () => {
  const cases = [
    [() => json({ success: false, data: null, message: '조회 실패' }), 'API_ERROR'],
    [() => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }), 'INVALID_RESPONSE'],
    [() => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }), 'INVALID_RESPONSE'],
    [() => json([]), 'INVALID_RESPONSE'],
    [() => json({ success: 'true', data: [] }), 'INVALID_RESPONSE'],
    [() => json({ success: true }), 'INVALID_RESPONSE'],
  ];
  for (const [response, code] of cases) {
    const client = createApiClient({ fetchImpl: async () => response() });
    await assert.rejects(client.request('/api/menus'), { code, status: 200 });
  }
});

test('403은 인증 정리 hook에 요청 당시 토큰을 제공하고 토큰을 오류 JSON에 노출하지 않는다', async () => {
  let currentToken = 'old-token';
  let respond;
  const response = new Promise((resolve) => { respond = resolve; });
  const events = [];
  const client = createApiClient({
    getAccessToken: () => currentToken,
    onAuthError: (error) => { events.push(error); if (error.token === currentToken) currentToken = null; },
    fetchImpl: () => response,
  });
  const pending = client.request('/api/kds/orders', { auth: true });
  currentToken = 'new-token';
  respond(json({ status: 403, message: 'Expired' }, 403));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'FORBIDDEN');
    assert.equal(error.status, 403);
    assert.equal(error.serverMessage, 'Expired');
    assert.equal(error.token, 'old-token');
    assert.equal(JSON.stringify(error).includes('old-token'), false);
    return true;
  });
  assert.equal(currentToken, 'new-token');
  assert.equal(events.length, 1);
});

test('빈 403 응답도 인증 오류로 처리하고 hook 오류가 원래 API 오류를 바꾸지 않는다', async () => {
  const client = createApiClient({
    onAuthError: () => { throw new Error('Cleanup failed'); },
    fetchImpl: async () => new Response('', { status: 403 }),
  });
  await assert.rejects(client.request('/api/kds/orders', { auth: true, token: 'token' }), { code: 'FORBIDDEN', status: 403 });
});

test('네트워크 실패는 원인을 보존하고 요청을 재시도하지 않는다', async () => {
  let calls = 0;
  const cause = new TypeError('Failed to fetch');
  const client = createApiClient({ fetchImpl: async () => { calls += 1; throw cause; } });
  await assert.rejects(client.request('/api/orders', { method: 'POST', body: {} }), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(calls, 1);
});

test('이미 취소된 요청은 전송하지 않으며 진행 중 취소·시간 초과를 구분한다', async () => {
  const already = new AbortController();
  already.abort();
  const client = createApiClient({ fetchImpl: () => assert.fail('전송하면 안 됩니다.') });
  await assert.rejects(client.request('/api/menus', { signal: already.signal }), { code: 'ABORTED' });

  let calls = 0;
  let requestSignal;
  const waiting = createApiClient({ timeoutMs: 10, fetchImpl: (_url, options) => {
    calls += 1; requestSignal = options.signal; return new Promise(() => {});
  } });
  await assert.rejects(waiting.request('/api/orders', { method: 'POST', body: {} }), { code: 'TIMEOUT' });
  assert.equal(calls, 1);
  assert.equal(requestSignal.aborted, true);
  const controller = new AbortController();
  const pending = waiting.request('/api/menus', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
});

test('본문 읽기까지 시간 제한을 적용하고 취소 후 늦은 403은 세션을 지우지 않는다', async () => {
  const stalled = createApiClient({ timeoutMs: 10, fetchImpl: async () => ({
    ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), json: () => new Promise(() => {}),
  }) });
  await assert.rejects(stalled.request('/api/menus'), { code: 'TIMEOUT' });

  let respond;
  let cleared = false;
  const client = createApiClient({ timeoutMs: 10, onAuthError: () => { cleared = true; }, fetchImpl: () => new Promise((resolve) => { respond = resolve; }) });
  await assert.rejects(client.request('/api/kds/orders', { auth: true, token: 'token' }), { code: 'TIMEOUT' });
  respond(json({ message: 'Expired' }, 403));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cleared, false);
});
