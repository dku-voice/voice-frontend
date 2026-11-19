import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPaymentApi } from '../scripts/mock-payment-api.js';
import { startMockDemo } from '../scripts/dev-mock.js';
import { createApiClient } from '../src/api/client.js';
import { createKioskApi } from '../src/api/kiosk.js';
import { normalizeMenus, createCartItem } from '../src/domain/kiosk.js';
import { createCheckoutManager } from '../src/domain/checkout.js';

async function withMock(run) {
  const { server } = createMockPaymentApi();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { await run(baseUrl); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
const jsonRequest = (base, path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const store = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};

test('실제 로컬 HTTP 모의 서버로 메뉴 옵션→장바구니→TEST 승인→영수증이 동작한다', async () => {
  await withMock(async (baseUrl) => {
    const api = createKioskApi({ client: createApiClient({ baseUrl }) });
    const menus = normalizeMenus(await api.fetchMenus());
    assert(menus.some((menu) => menu.categoryNameKo === '버거'));
    assert(menus.some((menu) => menu.categoryNameKo === '음료'));
    const burger = menus.find((menu) => menu.menuId === 1);
    const fries = menus.find((menu) => menu.menuId === 9);
    const cart = [createCartItem(burger, [101, 102], 2), createCartItem(fries, [900])];
    const manager = createCheckoutManager({ api, storage: store(), uuid: () => 'mock-transaction-1' });
    const first = manager.payTest(cart);
    assert.equal(manager.payTest(cart), first);
    const paid = await first;
    assert.equal(paid.status, 'PAID');
    assert(paid.orderNumber.startsWith('MOCK-'));
    assert.equal(paid.totalPrice, (5900 + 500) * 2 + 2500);
    assert.deepEqual(paid.items[0].optionIds, [101, 102]);
    assert.equal((await manager.readReceipt(paid.orderId)).status, 'PAID');
    manager.clearPaid();
    const next = await manager.prepare([createCartItem(burger)]);
    assert.notEqual(next.orderId, paid.orderId);
  });
});

test('모의 서버도 잘못된 금액·TOSS 승인·중복 승인을 거부한다', async () => {
  await withMock(async (base) => {
    const order = (await (await jsonRequest(base, '/api/orders', { items: [{ menuId: 1, quantity: 1, optionIds: [] }] })).json()).data;
    const payload = { pgProvider: 'TEST', pgTransactionId: 'mock-unique-1', orderId: order.orderId, amount: order.totalPrice, method: 'CARD' };
    assert.equal((await jsonRequest(base, '/api/payments/confirm', { ...payload, pgProvider: 'TOSS' })).status, 400);
    assert.equal((await jsonRequest(base, '/api/payments/confirm', { ...payload, amount: 1 })).status, 400);
    assert.equal((await (await fetch(`${base}/api/orders/${order.orderId}`)).json()).data.status, 'PENDING');
    assert.equal((await jsonRequest(base, '/api/payments/confirm', payload)).status, 200);
    assert.equal((await jsonRequest(base, '/api/payments/confirm', payload)).status, 409);
  });
});

test('모의 서버가 모르는 메뉴·옵션·영수증·경로를 운영 서버로 전달하지 않는다', async () => {
  await withMock(async (base) => {
    assert.equal((await jsonRequest(base, '/api/orders', { items: [{ menuId: 999, quantity: 1, optionIds: [] }] })).status, 400);
    assert.equal((await jsonRequest(base, '/api/orders', { items: [{ menuId: 1, quantity: 1, optionIds: [999] }] })).status, 400);
    assert.equal((await jsonRequest(base, '/api/orders', { items: [{ menuId: 9, quantity: 1, optionIds: [900, 901] }] })).status, 400);
    assert.equal((await fetch(base + '/api/orders/999')).status, 404);
    const unknown = await fetch(base + '/api/admin/orders');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get('x-voice-mock'), 'local-only');
  });
});

test('독립 Vite 환경은 API·AI·WS를 loopback으로 제한하고 토스 키와 브라우저 제목을 분리한다', async () => {
  const originalKey = process.env.VITE_TOSS_CLIENT_KEY;
  const demo = await startMockDemo({ port: 0 });
  try {
    assert(demo.url.startsWith('http://127.0.0.1:'));
    for (const proxy of Object.values(demo.vite.config.server.proxy)) assert(proxy.target.startsWith('http://127.0.0.1:'));
    assert.equal(demo.vite.config.env.VITE_TOSS_CLIENT_KEY, '');
    assert.equal(demo.vite.config.env.VITE_API_BASE_URL, '');
    const html = await fetch(demo.url).then((response) => response.text());
    assert(html.includes('로컬 모의 결제 | DKU Voice'));
    assert(html.includes('voice-local-mock-instance'));
    assert(!html.includes('테스트 결제·실제 과금 없음'));
    for (const path of ['/payment/success', '/payment/fail']) {
      const callbackPage = await fetch(demo.url + path);
      assert.equal(callbackPage.status, 200);
      assert((await callbackPage.text()).includes('id="root"'));
    }
    const response = await fetch(demo.url + '/api/menus');
    assert.equal(response.headers.get('x-voice-mock'), 'local-only');
    assert.equal((await response.json()).success, true);
    const api = createKioskApi({ client: createApiClient({ baseUrl: demo.url }) });
    const [menu] = normalizeMenus(await api.fetchMenus());
    const manager = createCheckoutManager({ api, storage: store() });
    assert.equal((await manager.payTest([createCartItem(menu)])).status, 'PAID');
    assert.equal((await fetch(demo.url + '/ai/api/vision/analyze_age')).status, 404);
  } finally { await demo.close(); }
  assert.equal(process.env.VITE_TOSS_CLIENT_KEY, originalKey);
});
