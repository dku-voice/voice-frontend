import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api/client.js';
import { createKioskApi, kioskApi } from '../src/api/kiosk.js';

const success = (data) => new Response(JSON.stringify({ success: true, data, message: null }), {
  headers: { 'Content-Type': 'application/json' },
});
const apiWith = (fetchImpl) => createKioskApi({ client: createApiClient({ fetchImpl }) });

test('공개 메뉴와 카테고리 조회는 명세 경로만 사용하고 원형 데이터를 반환한다', async () => {
  const menus = [{ menuId: 14, nameKo: '펩시콜라', status: 'ACTIVE', price: 1800, options: [] }];
  const urls = [];
  const api = apiWith(async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, undefined);
    return success(menus);
  });
  assert.deepEqual(await api.fetchMenus(), menus);
  assert.deepEqual(await api.fetchMenus({ categoryId: 3 }), menus);
  assert.deepEqual(urls, ['/api/menus', '/api/menus?categoryId=3']);
  assert.equal(typeof kioskApi.fetchMenus, 'function');
});

test('주문 생성은 가격을 보내지 않고 서버 totalPrice와 영수증 응답을 보존한다', async () => {
  const original = { items: [{ menuId: 14, quantity: 2, optionIds: [1, 1], price: 1 }], totalPrice: 2 };
  const snapshot = structuredClone(original);
  const order = { orderId: 42, orderNumber: 'ORD-42', totalPrice: 4600, status: 'PENDING', items: [] };
  const calls = [];
  const api = apiWith(async (url, options) => {
    calls.push([url, options.method]);
    if (options.method === 'POST') assert.deepEqual(JSON.parse(options.body), { items: [{ menuId: 14, quantity: 2, optionIds: [1] }] });
    return success(order);
  });
  assert.deepEqual(await api.createOrder(original), order);
  assert.deepEqual(await api.getOrder(42), order);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(calls, [['/api/orders', 'POST'], ['/api/orders/42', 'GET']]);
});

test('문자열 메뉴 ID·잘못된 수량·누락된 옵션 배열은 전송하지 않는다', async () => {
  const api = apiWith(() => assert.fail('전송하면 안 됩니다.'));
  for (const body of [
    null, { items: [] }, { items: [null] },
    { items: [{ menuId: '14', quantity: 1, optionIds: [] }] },
    { items: [{ menuId: 14, quantity: 0, optionIds: [] }] },
    { items: [{ menuId: 14, quantity: 1.5, optionIds: [] }] },
    { items: [{ menuId: 14, quantity: 1 }] },
    { items: [{ menuId: 14, quantity: 1, optionIds: [0] }] },
  ]) await assert.rejects(api.createOrder(body), { code: 'INVALID_INPUT' });
  await assert.rejects(api.getOrder('../payments'), { code: 'INVALID_INPUT' });
});

test('결제는 TEST/CARD만 허용하고 서버 DB ID·확정 금액·고유 거래 ID를 그대로 전송한다', async () => {
  const payload = { pgProvider: 'TEST', pgTransactionId: 'unique-test-id', orderId: 42, amount: 4600, method: 'CARD' };
  let calls = 0;
  const api = apiWith(async (url, options) => {
    calls += 1;
    assert.equal(url, '/api/payments/confirm');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), payload);
    return success({ paymentId: 9, orderId: 42, amount: 4600, pgTransactionId: payload.pgTransactionId });
  });
  assert.equal((await api.confirmPayment(payload)).paymentId, 9);
  for (const change of [{ pgProvider: 'TOSS' }, { method: 'TOSS' }, { amount: 0 }, { orderId: '42' }, { pgTransactionId: '' }]) {
    await assert.rejects(api.confirmPayment({ ...payload, ...change }), { code: 'INVALID_INPUT' });
  }
  assert.equal(calls, 1);
});

test('환불은 거래 ID와 취소 사유만 전달하며 응답을 원형으로 반환한다', async () => {
  const result = { paymentId: 9, orderId: 42, refundAmount: 4600, orderStatus: 'REFUNDED' };
  const api = apiWith(async (url, options) => {
    assert.equal(url, '/api/payments/cancel');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { pgTransactionId: 'unique-test-id', cancelReason: '고객 요청' });
    return success(result);
  });
  assert.deepEqual(await api.cancelPayment({ pgTransactionId: 'unique-test-id', cancelReason: '고객 요청' }), result);
});

test('로그인 반환은 accessToken/role이며 로그아웃은 Bearer를 요구한다', async () => {
  const calls = [];
  const api = apiWith(async (url, options) => {
    calls.push([url, options.method]);
    if (url.endsWith('/login')) {
      assert.equal(options.headers.Authorization, undefined);
      const body = JSON.parse(options.body);
      assert.equal(body.username, 'staff');
      assert.equal(typeof body.password, 'string');
      return success({ accessToken: 'mock-token', role: 'STAFF' });
    }
    assert.equal(options.headers.Authorization, 'Bearer mock-token');
    return success(null);
  });
  assert.deepEqual(await api.login({ username: 'staff', password: 'mock-credential' }), { accessToken: 'mock-token', role: 'STAFF' });
  await api.logout({ token: 'mock-token' });
  assert.deepEqual(calls, [['/api/auth/login', 'POST'], ['/api/auth/logout', 'POST']]);
  await assert.rejects(api.logout(), { code: 'AUTH_REQUIRED' });
});

test('직원·관리자 경로와 PATCH query는 최신 명세를 사용한다', async () => {
  const calls = [];
  const api = apiWith(async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer mock-token');
    assert.equal(options.body, undefined);
    calls.push([url, options.method]);
    return success(null);
  });
  const auth = { token: 'mock-token' };
  await api.fetchKdsOrders(auth);
  await api.updateKdsStatus(42, 'PREPARING', auth);
  await api.updateKdsStatus(42, 'COMPLETED', auth);
  await api.updateMenuStatus(14, 'SOLD_OUT', auth);
  await api.fetchAdminOrders({ ...auth, storeId: '서울 매장' });
  await api.getAdminOrder(42, auth);
  await api.fetchAdminPayments({ ...auth, storeId: '서울 매장' });
  assert.deepEqual(calls, [
    ['/api/kds/orders?storeId=store-default', 'GET'],
    ['/api/kds/orders/42/status?status=PREPARING', 'PATCH'],
    ['/api/kds/orders/42/status?status=COMPLETED', 'PATCH'],
    ['/api/admin/menus/14/status?status=SOLD_OUT', 'PATCH'],
    ['/api/admin/orders?storeId=%EC%84%9C%EC%9A%B8+%EB%A7%A4%EC%9E%A5', 'GET'],
    ['/api/admin/orders/42', 'GET'],
    ['/api/admin/payments?storeId=%EC%84%9C%EC%9A%B8+%EB%A7%A4%EC%9E%A5', 'GET'],
  ]);
});

test('stats는 명시 from/to를 전달하고 nullable 매출과 [이름,수량] 메뉴 배열을 보존한다', async () => {
  const sales = { totalSales: null, totalOrders: 0, averageOrder: null };
  const menus = [['버거', 3], ['펩시콜라', 2]];
  const api = apiWith(async (url) => {
    assert.match(url, /\?storeId=store-default&from=2026-01-01&to=2026-12-31$/);
    return success(url.startsWith('/api/admin/stats/sales') ? sales : menus);
  });
  const options = { token: 'mock-token', from: '2026-01-01', to: '2026-12-31' };
  assert.deepEqual(await api.fetchSalesStats(options), sales);
  assert.deepEqual(await api.fetchMenuStats(options), menus);
});

test('명세 외 상태와 잘못된 날짜는 네트워크 요청 전에 거부한다', async () => {
  const api = apiWith(() => assert.fail('전송하면 안 됩니다.'));
  const auth = { token: 'mock-token' };
  await assert.rejects(api.updateKdsStatus(42, 'PAID', auth), { code: 'INVALID_INPUT' });
  await assert.rejects(api.updateMenuStatus(14, 'invalid', auth), { code: 'INVALID_INPUT' });
  await assert.rejects(api.fetchSalesStats({ ...auth, from: '2026-02-30', to: '2026-03-01' }), { code: 'INVALID_INPUT' });
  await assert.rejects(api.fetchMenuStats({ ...auth, from: '2026-12-31', to: '2026-01-01' }), { code: 'INVALID_INPUT' });
});
