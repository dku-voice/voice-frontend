import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api/client.js';
import { createKioskApi } from '../src/api/kiosk.js';
import { normalizeMenus, createCartItem } from '../src/domain/kiosk.js';
import { createCheckoutManager } from '../src/domain/checkout.js';

test('모의 HTTP 서버로 메뉴 옵션→주문→TEST 승인→영수증을 실제 모듈 조합으로 검증한다', async () => {
  let state = 'PENDING';
  const requests = [];
  const receipt = () => ({ orderId: 123, orderNumber: 'ORD-MOCK-123', status: state, totalPrice: 6600, orderedAt: '2026-11-13T12:00:00', items: [
    { menuId: 1, menuNameKo: '데리버거', quantity: 2, unitPrice: 3300, subtotal: 6600, options: [{ optionId: 10, nameKo: '치즈 추가', extraPrice: 500 }] },
  ] });
  const fetchImpl = async (url, options) => {
    assert(url.startsWith('/api/'));
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, method: options.method, body });
    let data;
    if (url === '/api/menus') data = [{ menuId: 1, nameKo: '데리버거', price: 2800, status: 'ACTIVE', categoryNameKo: '버거', options: [{ optionId: 10, nameKo: '치즈 추가', optionType: 'ADD', extraPrice: 500 }] }];
    else if (url === '/api/orders' && options.method === 'POST') {
      assert.deepEqual(body, { items: [{ menuId: 1, quantity: 2, optionIds: [10] }] }); data = receipt();
    } else if (url === '/api/payments/confirm') {
      assert.equal(body.pgProvider, 'TEST'); assert.equal(body.orderId, 123); assert.equal(body.amount, 6600);
      state = 'PAID'; data = { paymentId: 77, orderId: 123, pgProvider: 'TEST', pgTransactionId: body.pgTransactionId, amount: 6600, method: 'CARD' };
    } else if (url === '/api/orders/123') data = receipt();
    else assert.fail(`명세 외 요청: ${url}`);
    return new Response(JSON.stringify({ success: true, data, message: null }), { headers: { 'content-type': 'application/json' } });
  };
  const api = createKioskApi({ client: createApiClient({ fetchImpl }) });
  const [menu] = normalizeMenus(await api.fetchMenus());
  const cart = [createCartItem(menu, [10], 2)];
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const manager = createCheckoutManager({ api, storage, uuid: () => 'mock-unique-transaction' });
  const [paid, duplicate] = await Promise.all([manager.payTest(cart), manager.payTest(cart)]);
  assert.equal(paid.orderId, duplicate.orderId);
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.items[0].optionNames[0], '치즈 추가');
  assert.equal((await manager.readReceipt(123)).totalPrice, 6600);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 2);
});
