import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTestWidgetKey, readPaymentReturn, getTossPaymentMethod, prepareTossWidget } from '../src/integration/payment.js';

const key = 'test_gck_local_fixture';
const order = { orderId: 13, orderNumber: 'ORD-20261115-ABC12345', totalPrice: 6900,
  items: [{ menuNameKo: '치즈 버거' }] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fakeSdk() {
  const calls = [];
  let ready;
  let agreed = true;
  let selection = { type: 'NORMAL', method: '카드' };
  let payment = () => new Promise(() => {});
  return {
    calls, ready: () => ready(), setAgreed: (value) => { agreed = value; },
    setSelection: (value) => { selection = value; }, setPayment: (value) => { payment = value; },
    loadWidget: async () => ({
      renderPaymentMethods: (selector, amount) => {
        calls.push({ operation: 'methods', selector, amount });
        return { on: (event, callback) => { assert.equal(event, 'ready'); ready = callback; }, getSelectedPaymentMethod: () => selection };
      },
      renderAgreement: (selector) => {
        calls.push({ operation: 'agreement', selector });
        return { getAgreementStatus: () => ({ agreedRequiredTerms: agreed }) };
      },
      requestPayment: (parameters) => { calls.push({ operation: 'request', parameters }); return payment(); },
    }),
  };
}

test('테스트 위젯 키와 PG 주문번호를 검증하고 라이브 키에서는 SDK를 호출하지 않는다', async () => {
  for (const invalid of ['', 'live_gck_example', 'test_ck_example']) assert.throws(() => assertTestWidgetKey(invalid));
  assert.doesNotThrow(() => assertTestWidgetKey(key));
  let loads = 0;
  const loadWidget = () => { loads += 1; };
  await assert.rejects(prepareTossWidget({ key: 'live_gck_example', order, loadWidget }));
  await assert.rejects(prepareTossWidget({ key, order: { ...order, orderNumber: '13' }, loadWidget }));
  await assert.rejects(prepareTossWidget({ key, order: { ...order, totalPrice: 0 }, loadWidget }));
  assert.equal(loads, 0);
});

test('위젯은 서버 금액으로 자동 렌더되며 ready 이후 명시적인 클릭에서만 같은 PG 주문번호로 요청한다', async () => {
  const sdk = fakeSdk();
  let ready = false;
  const preparing = prepareTossWidget({ key, order, loadWidget: sdk.loadWidget }).then((widget) => { ready = true; return widget; });
  await tick();
  assert.equal(ready, false);
  assert.deepEqual(sdk.calls.map((call) => call.operation), ['methods', 'agreement']);
  assert.equal(sdk.calls[0].amount, 6900);
  sdk.ready();
  const widget = await preparing;
  const marked = [];
  const requesting = widget.request({ origin: 'https://kiosk.example.test', onRequest: (value) => marked.push(value) });
  assert.deepEqual(marked, [{ orderNumber: order.orderNumber, amount: 6900, method: 'CARD' }]);
  assert.deepEqual(sdk.calls[2].parameters, {
    orderId: order.orderNumber, orderName: '치즈 버거',
    successUrl: 'https://kiosk.example.test/payment/success', failUrl: 'https://kiosk.example.test/payment/fail',
  });
  assert.throws(() => widget.request({ origin: 'https://kiosk.example.test', onRequest: () => {} }), /이미 결제/);
  assert.equal(sdk.calls.filter((call) => call.operation === 'request').length, 1);
  // Pending redirect intentionally holds the lock; never await it as a success result.
  void requesting;
  widget.dispose();
});

test('약관 미동의·지원하지 않는 수단은 요청하지 않고, 취소 이후 같은 주문으로 다시 요청할 수 있다', async () => {
  const sdk = fakeSdk();
  const preparing = prepareTossWidget({ key, order, loadWidget: sdk.loadWidget });
  await tick(); sdk.ready();
  const widget = await preparing;
  const options = { origin: 'https://kiosk.example.test', onRequest: () => {} };
  sdk.setAgreed(false);
  assert.throws(() => widget.request(options), /필수 결제 약관/);
  sdk.setAgreed(true);
  sdk.setSelection({ type: 'NORMAL', method: '계좌이체' });
  assert.throws(() => widget.request(options), /아직 주문 서버/);
  assert.equal(sdk.calls.some((call) => call.operation === 'request'), false);
  sdk.setSelection({ type: 'NORMAL', method: '간편결제', easyPay: { provider: 'KAKAOPAY' } });
  sdk.setPayment(() => Promise.reject(Object.assign(new Error('취소'), { code: 'USER_CANCEL' })));
  await assert.rejects(widget.request(options), { code: 'USER_CANCEL' });
  const marked = [];
  await assert.rejects(widget.request({ ...options, onRequest: (value) => marked.push(value) }), { code: 'USER_CANCEL' });
  assert.equal(marked[0].method, 'KAKAO_PAY');
  widget.dispose();
  assert.throws(() => widget.request(options), { name: 'AbortError' });
});

test('화면을 나간 뒤 늦게 로드된 SDK는 렌더하지 않고 ready 시간 초과도 종료한다', async () => {
  const controller = new AbortController();
  let loaded;
  let renders = 0;
  const preparing = prepareTossWidget({ key, order, signal: controller.signal,
    loadWidget: () => new Promise((resolve) => { loaded = resolve; }) });
  controller.abort();
  await assert.rejects(preparing, { name: 'AbortError' });
  loaded({ renderPaymentMethods: () => { renders += 1; } });
  await tick();
  assert.equal(renders, 0);
  const sdk = fakeSdk();
  await assert.rejects(prepareTossWidget({ key, order, loadWidget: sdk.loadWidget, timeoutMs: 5 }), /시간이 초과/);
});

test('리다이렉트 결과는 필수 값·중복 파라미터·금액·지원 결제유형을 검증하고 실패 문구를 그대로 신뢰하지 않는다', () => {
  const success = (search) => readPaymentReturn({ pathname: '/payment/success', search });
  assert.deepEqual(success('?paymentKey=local-fixture&orderId=ORD-ABC123&amount=6900&paymentType=NORMAL'),
    { type: 'success', paymentKey: 'local-fixture', orderNumber: 'ORD-ABC123', amount: 6900 });
  for (const search of [
    '?orderId=ORD-ABC123&amount=6900', '?paymentKey=x&orderId=ORD-ABC123&amount=1e3',
    '?paymentKey=x&orderId=ORD-ABC123&amount=6900&amount=1', '?paymentKey=x&orderId=13&amount=6900',
    '?paymentKey=x&orderId=ORD-ABC123&amount=6900&paymentType=BRANDPAY',
  ]) assert.equal(success(search).type, 'invalid');
  assert.equal(readPaymentReturn({ pathname: '/', search: '?paymentKey=x' }), null);
  const failure = readPaymentReturn({ pathname: '/payment/fail', search: '?message=sensitive-value' });
  assert.equal(failure.type, 'fail');
  assert(!failure.message.includes('sensitive-value'));
  assert.equal(getTossPaymentMethod({ method: '간편결제', easyPay: { provider: 'NAVERPAY' } }), 'NAVER_PAY');
  assert.equal(getTossPaymentMethod({ method: '간편결제', easyPay: { provider: '토스페이' } }), 'TOSS');
  assert.throws(() => getTossPaymentMethod({ type: 'BRANDPAY', method: '카드' }));
});
