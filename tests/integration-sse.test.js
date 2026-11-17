import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, openKdsStream } from '../src/integration/sse.js';

const encoder = new TextEncoder();
const waitFor = async (condition) => {
  for (let i = 0; i < 150; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('비동기 SSE 조건이 충족되지 않았습니다.');
};
const source = (chunks, { closed = false, status = 200, type = 'text/event-stream; charset=UTF-8' } = {}) => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
      if (closed) controller.close();
    },
    cancel() { canceled = true; },
  });
  return { response: new Response(body, { status, headers: { 'Content-Type': type } }), canceled: () => canceled };
};
const event = (id, orderId) => `event: new-order\nid: ${id}\ndata: {"orderId":${orderId}}\n\n`;

test('파서는 CRLF 경계와 멀티라인, 주석, BOM을 처리하고 미완성 이벤트는 보내지 않는다', () => {
  const events = [];
  const ids = [];
  const parser = createSseParser({ onEvent: (value) => events.push(value), onId: (value) => ids.push(value) });
  for (const chunk of ['\ufeff: heartbeat\r', '\nevent: new-order\r', '\nid: order-1\r\ndata: first\r', '\ndata: second\r', '\n\r', '\ndata: incomplete']) parser.push(chunk);
  assert.deepEqual(events, [{ name: 'new-order', data: 'first\nsecond', id: 'order-1' }]);
  assert.deepEqual(ids, ['order-1']);
});

test('SSE는 Bearer 헤더로만 인증하며 connect 평문과 UTF-8 분할된 주문 JSON을 구분한다', async () => {
  const text = ': keepalive\r\nevent: connect\r\ndata: KDS 연결 완료\r\n\r\nevent: new-order\r\nid: one\r\ndata: {"orderId":1,\r\ndata: "menuNameKo":"버거"}\r\n\r\n';
  const bytes = encoder.encode(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
  const input = source(chunks);
  const orders = [];
  const statuses = [];
  let requests = 0;
  const stop = openKdsStream({
    token: 'private-token', storeId: '서울 매장', baseUrl: 'https://example.test/',
    fetchImpl: async (address, options) => {
      requests += 1;
      const url = new URL(address);
      assert.equal(url.pathname, '/api/kds/stream');
      assert.equal(url.searchParams.get('storeId'), '서울 매장');
      assert.equal(address.includes('private-token'), false);
      assert.equal(options.headers.Authorization, 'Bearer private-token');
      assert.equal(options.headers.Accept, 'text/event-stream');
      return input.response;
    },
    onOrder: (order) => orders.push(order), onStatus: (status) => statuses.push(status),
  });
  await waitFor(() => orders.length === 1);
  stop();
  assert.deepEqual(orders, [{ orderId: 1, menuNameKo: '버거' }]);
  assert.deepEqual(statuses, ['connecting', 'open', 'closed']);
  assert.equal(requests, 1);
  await waitFor(input.canceled);
});

test('연결이 끝나면 재연결하고 기존 이벤트 ID를 중복 제거하며 마지막 ID를 헤더에 보낸다', async () => {
  const first = source([event('one', 1)], { closed: true });
  const second = source([event('one', 1) + event('two', 2)]);
  const orders = [];
  const statuses = [];
  let requests = 0;
  const stop = openKdsStream({
    token: 'token', retryMs: 1,
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (requests === 1) return first.response;
      assert.equal(options.headers['Last-Event-ID'], 'one');
      return second.response;
    },
    onOrder: (order) => orders.push(order), onStatus: (status) => statuses.push(status),
  });
  await waitFor(() => orders.length === 2);
  stop();
  assert.deepEqual(orders.map((order) => order.orderId), [1, 2]);
  assert.equal(requests, 2);
  assert.equal(statuses.includes('reconnecting'), true);
  await waitFor(second.canceled);
});

test('이벤트 ID 저장 개수 상한을 넘으면 가장 오래된 ID를 제거한다', async () => {
  const input = source([event('one', 1) + event('two', 2) + event('three', 3) + event('one', 1) + event('three', 3)]);
  const orders = [];
  const stop = openKdsStream({ token: 'token', maxEventIds: 2, fetchImpl: async () => input.response, onOrder: (order) => orders.push(order) });
  await waitFor(() => orders.length === 4);
  stop();
  assert.deepEqual(orders.map((order) => order.orderId), [1, 2, 3, 1]);
});

test('403은 응답 본문을 기다리지 않고 토큰과 함께 인증 오류를 알리며 재연결하지 않는다', async () => {
  const input = source([], { status: 403, type: 'application/json' });
  const statuses = [];
  let auth;
  let requests = 0;
  const stop = openKdsStream({
    token: 'old-token', retryMs: 0,
    fetchImpl: async () => { requests += 1; return input.response; },
    onStatus: (status) => statuses.push(status), onAuthError: (value) => { auth = value; },
  });
  await waitFor(() => auth);
  assert.equal(auth.token, 'old-token');
  assert.equal(auth.status, 403);
  assert.equal(auth.code, 'FORBIDDEN');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests, 1);
  assert.deepEqual(statuses, ['connecting', 'closed']);
  assert.equal(input.canceled(), true);
  stop();
});

test('이미 취소된 signal과 잘못된 토큰은 HTTP 요청을 만들지 않는다', () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const fetchImpl = async () => { requests += 1; throw new Error('unexpected'); };
  const stop = openKdsStream({ token: 'token', signal: controller.signal, fetchImpl });
  let auth;
  openKdsStream({ token: 'invalid\r\nheader', fetchImpl, onAuthError: (value) => { auth = value; } });
  assert.equal(requests, 0);
  assert.equal(auth.status, 403);
  stop();
});

test('401 응답도 기존 토큰을 전달하고 연결·재연결을 중단한다', async () => {
  let auth;
  let requests = 0;
  const input = source([], { status: 401, type: 'application/json' });
  const statuses = [];
  const stop = openKdsStream({
    token: 'expired-token', retryMs: 0,
    fetchImpl: async () => { requests += 1; return input.response; },
    onStatus: (status) => statuses.push(status), onAuthError: (value) => { auth = value; },
  });
  await waitFor(() => auth);
  assert.equal(auth.status, 401);
  assert.equal(auth.token, 'expired-token');
  assert.equal(auth.code, 'FORBIDDEN');
  assert.deepEqual(statuses, ['connecting', 'closed']);
  assert.equal(input.canceled(), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests, 1);
  stop();
});

test('실행 중 signal 취소는 reader와 재연결을 정리한다', async () => {
  const controller = new AbortController();
  const input = source([]);
  let opened = false;
  let requests = 0;
  openKdsStream({
    token: 'token', retryMs: 0, signal: controller.signal,
    fetchImpl: async () => { requests += 1; return input.response; },
    onStatus: (status) => { if (status === 'open') opened = true; },
  });
  await waitFor(() => opened);
  controller.abort();
  await waitFor(input.canceled);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests, 1);
});

test('stop 이후 늦게 도착한 fetch 응답은 취소하며 주문 콜백을 실행하지 않는다', async () => {
  let resolveFetch;
  let calls = 0;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const stop = openKdsStream({ token: 'token', fetchImpl: () => pending, onOrder: () => { calls += 1; } });
  stop();
  const input = source([event('late', 1)]);
  resolveFetch(input.response);
  await waitFor(input.canceled);
  assert.equal(calls, 0);
});

test('잘못된 주문 JSON을 알려도 다음 정상 주문은 계속 처리한다', async () => {
  const input = source(['event: new-order\ndata: not-json\n\n' + event('valid', 7)]);
  const errors = [];
  const orders = [];
  const stop = openKdsStream({ token: 'token', fetchImpl: async () => input.response, onError: (error) => errors.push(error), onOrder: (order) => orders.push(order) });
  await waitFor(() => orders.length === 1);
  stop();
  assert.equal(errors[0].code, 'INVALID_EVENT');
  assert.deepEqual(orders, [{ orderId: 7 }]);
});

test('일반 HTTP 실패는 재연결 상태로 전환하고 stop은 대기 타이머도 취소한다', async () => {
  let requests = 0;
  let failure;
  const statuses = [];
  const stop = openKdsStream({
    token: 'token', retryMs: 30,
    fetchImpl: async () => { requests += 1; return new Response('', { status: 500 }); },
    onError: (value) => { failure = value; }, onStatus: (status) => statuses.push(status),
  });
  await waitFor(() => failure);
  stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(failure.status, 500);
  assert.equal(statuses.includes('reconnecting'), true);
  assert.equal(requests, 1);
});

test('JSON 응답을 SSE로 처리하지 않고 데이터가 없는 재연결도 정리할 수 있다', async () => {
  let failure;
  const stop = openKdsStream({
    token: 'token', retryMs: 1000,
    fetchImpl: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    onError: (value) => { failure = value; },
  });
  await waitFor(() => failure);
  stop();
  assert.equal(failure.code, 'INVALID_RESPONSE');
});
