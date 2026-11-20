import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api/client.js';
import { createKioskApi } from '../src/api/kiosk.js';
import { createCheckoutManager } from '../src/domain/checkout.js';
import { normalizeMenus, createCartItem } from '../src/domain/kiosk.js';
import { prepareTossWidget, readPaymentReturn } from '../src/integration/payment.js';

const storageFor = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

test('Toss 전체 모듈 조합은 서버 총액·선택 수단·PG 주문번호를 새로고침 후 승인까지 보존한다 (메모리 mock)', async () => {
  for (const [selection, expectedMethod] of [
    [{ type: 'NORMAL', method: '카드' }, 'CARD'],
    [{ type: 'NORMAL', method: '간편결제', easyPay: { provider: 'KAKAOPAY' } }, 'KAKAO_PAY'],
  ]) {
    const requests = [];
    let serverOrder;
    const paymentKey = `mock-payment-key-${expectedMethod}`;
    const fetchImpl = async (url, options) => {
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      requests.push({ url, method: options.method, body });
      assert.equal(options.headers.Authorization, undefined);
      let data;
      if (url === '/api/menus' && options.method === 'GET') {
        data = [{
          menuId: 1, nameKo: '데리버거', price: 2800, status: 'ACTIVE', categoryNameKo: '버거',
          options: [{ optionId: 10, nameKo: '치즈 추가', optionType: 'ADD', extraPrice: 500 }],
        }];
      } else if (url === '/api/orders' && options.method === 'POST') {
        assert.deepEqual(body, { items: [{ menuId: 1, quantity: 2, optionIds: [10] }] });
        // The server has a newer price than the menu loaded into the cart.
        serverOrder = {
          orderId: 731, orderNumber: `ORD-MOCK-FLOW-${expectedMethod}`, status: 'PENDING', totalPrice: 7000,
          orderedAt: '2026-11-15T08:00:00Z', items: [{
            menuId: 1, menuNameKo: '데리버거', quantity: 2, unitPrice: 3500, subtotal: 7000,
            options: [{ optionId: 10, nameKo: '치즈 추가', optionType: 'ADD', extraPrice: 500 }],
          }],
        };
        data = serverOrder;
      } else if (url === '/api/orders/731' && options.method === 'GET') {
        data = serverOrder;
      } else if (url === '/api/payments/confirm' && options.method === 'POST') {
        assert.deepEqual(body, {
          pgProvider: 'TOSS', pgTransactionId: paymentKey, orderId: 731, amount: 7000, method: expectedMethod,
        });
        serverOrder.status = 'PAID';
        data = {
          paymentId: 92, orderId: 731, pgProvider: 'TOSS', pgTransactionId: paymentKey,
          amount: 7000, method: expectedMethod, paidAt: '2026-11-15T08:01:00Z',
        };
      } else assert.fail(`예상하지 않은 모의 요청: ${options.method} ${url}`);
      return new Response(JSON.stringify({ success: true, data, message: null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const api = createKioskApi({ client: createApiClient({ fetchImpl }) });
    const [menu] = normalizeMenus(await api.fetchMenus());
    const cart = [createCartItem(menu, [10], 2)];
    const original = structuredClone(cart);
    assert.equal(cart[0].price * cart[0].quantity, 6600);
    const storage = storageFor();
    const manager = createCheckoutManager({ api, storage, uuid: () => 'mock-test-transaction' });
    const preparedOrder = await manager.prepare(cart);
    assert.equal(preparedOrder.totalPrice, 7000);

    let ready;
    let renderedAmount;
    let pgRequest;
    let widgetReady = false;
    const preparing = prepareTossWidget({
      key: 'test_gck_local_fixture', order: preparedOrder, timeoutMs: 1000,
      loadWidget: async (key, customerKey) => {
        assert.equal(key, 'test_gck_local_fixture');
        assert.match(customerKey, /^voice-kiosk-/);
        return {
          renderPaymentMethods: (selector, amount) => {
            assert.equal(selector, '#payment-widget');
            renderedAmount = amount;
            return {
              on: (event, callback) => { assert.equal(event, 'ready'); ready = callback; },
              getSelectedPaymentMethod: () => selection,
            };
          },
          renderAgreement: (selector) => {
            assert.equal(selector, '#agreement-widget');
            return { getAgreementStatus: () => ({ agreedRequiredTerms: true }) };
          },
          requestPayment: async (parameters) => { pgRequest = parameters; },
        };
      },
    }).then((widget) => { widgetReady = true; return widget; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderedAmount, 7000);
    assert.equal(widgetReady, false);
    assert.equal(pgRequest, undefined);
    ready();
    const widget = await preparing;
    assert.equal(pgRequest, undefined);
    await widget.request({
      origin: 'https://kiosk.example.test',
      onRequest: (request) => manager.markTossRequested(request),
    });
    assert.equal(pgRequest.orderId, preparedOrder.orderNumber);
    assert.notEqual(pgRequest.orderId, String(preparedOrder.orderId));
    assert.equal(pgRequest.successUrl, 'https://kiosk.example.test/payment/success');
    assert.equal(pgRequest.failUrl, 'https://kiosk.example.test/payment/fail');
    assert.equal(manager.getSaved().tossRequest.method, expectedMethod);
    assert.equal(requests.filter((request) => request.url === '/api/payments/confirm').length, 0);

    const redirect = new URL(pgRequest.successUrl);
    redirect.search = new URLSearchParams({
      paymentKey, orderId: pgRequest.orderId, amount: String(renderedAmount), paymentType: 'NORMAL',
    }).toString();
    const returned = readPaymentReturn(redirect);
    assert.equal(returned.type, 'success');
    const afterReload = createCheckoutManager({ api, storage });
    const paid = await afterReload.confirmToss(returned);
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.orderId, 731);
    assert.equal(paid.totalPrice, 7000);
    assert.equal(paid.items[0].optionNames[0], '치즈 추가');
    assert.equal((await afterReload.readReceipt(731)).totalPrice, 7000);
    const duplicateReturn = createCheckoutManager({ api, storage });
    assert.equal((await duplicateReturn.confirmToss(returned)).status, 'PAID');
    assert.equal(requests.filter((request) => request.url === '/api/payments/confirm').length, 1);
    assert.equal(requests.filter((request) => request.url === '/api/orders' && request.method === 'POST').length, 1);
    assert.deepEqual(cart, original);
    widget.dispose();
  }
});
