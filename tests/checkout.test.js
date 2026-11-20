import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutManager } from '../src/domain/checkout.js';
const makeStore = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }; };
const cart = [{ menuId: 1, id: 1, lineId: '1:', name: '버거', quantity: 2, optionIds: [], price: 2800 }];
const order = { orderId: 31, orderNumber: 'ORD-MOCK-31', status: 'PENDING', totalPrice: 6000, items: [
  { menuId: 1, menuNameKo: '버거', quantity: 2, unitPrice: 3000, subtotal: 6000, options: [] },
] };
const setup = (overrides = {}, storage = makeStore()) => {
  const calls = [];
  let current = structuredClone(order);
  const api = {
    createOrder: async (body) => { calls.push(['create', body]); return current; },
    getOrder: async () => { calls.push(['get']); return current; },
    confirmPayment: async (body) => { calls.push(['confirm', body]); current = { ...current, status: 'PAID' }; return { paymentId: 1 }; },
    ...overrides,
  };
  const manager = createCheckoutManager({ api, storage, uuid: () => 'unique-mock-id' });
  return { manager, api, storage, calls };
};

test('실제 API 흐름은 주문 생성→TEST 승인→주문 조회이며 표시 금액 대신 서버 총액을 쓴다', async () => {
  const { manager, calls } = setup();
  const original = structuredClone(cart);
  const paid = await manager.payTest(cart);
  assert.equal(paid.status, 'PAID');
  assert.deepEqual(calls, [
    ['create', { items: [{ menuId: 1, quantity: 2, optionIds: [] }] }],
    ['confirm', { pgProvider: 'TEST', pgTransactionId: 'test-unique-mock-id', orderId: 31, amount: 6000, method: 'CARD' }],
    ['get'],
  ]);
  assert.deepEqual(cart, original);
  assert.equal(manager.getSaved().phase, 'paid');
});

test('빠른 중복 결제와 새로고침 후 이미 PAID인 주문은 생성·승인을 반복하지 않는다', async () => {
  const { manager, api, storage, calls } = setup();
  const first = manager.payTest(cart);
  const duplicate = manager.payTest(cart);
  assert.equal(first, duplicate);
  await first;
  const reentered = createCheckoutManager({ api, storage, uuid: () => 'other-id' });
  await reentered.payTest(cart);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'confirm').length, 1);
});

test('생성 요청의 결과가 불명확하면 재진입해도 POST하지 않고 장바구니를 복원한다', async () => {
  let posts = 0;
  const { manager, api, storage } = setup({ createOrder: async () => { posts += 1; throw Object.assign(new Error('network'), { code: 'NETWORK_ERROR' }); } });
  await assert.rejects(manager.payTest(cart));
  const reentered = createCheckoutManager({ api, storage });
  await assert.rejects(reentered.payTest(cart), /이전 주문/);
  assert.equal(posts, 1);
  assert.deepEqual(reentered.restoreCart(), cart);
  assert.throws(() => reentered.beginNewCheckout(), /이전 주문/);
});

test('확정적인 주문 4xx 실패는 재시도를 허용하며 저장이 안 되면 POST 전에 중단한다', async () => {
  let posts = 0;
  const { manager } = setup({ createOrder: async () => { posts += 1; throw Object.assign(new Error('sold out'), { status: 400 }); } });
  await assert.rejects(manager.payTest(cart));
  await assert.rejects(manager.payTest(cart));
  assert.equal(posts, 2);
  const blocked = createCheckoutManager({ api: { createOrder: () => assert.fail('전송 금지') }, storage: { getItem: () => null, setItem: () => { throw new Error('blocked'); } } });
  await assert.rejects(blocked.payTest(cart), /저장/);
});

test('승인 응답이 유실되어도 GET에서 PAID를 확인하면 완료하고 승인 POST를 반복하지 않는다', async () => {
  let paid = false;
  let confirms = 0;
  const { manager } = setup({
    confirmPayment: async () => { confirms += 1; paid = true; throw new Error('lost response'); },
    getOrder: async () => ({ ...order, status: paid ? 'PAID' : 'PENDING' }),
  });
  assert.equal((await manager.payTest(cart)).status, 'PAID');
  await manager.payTest(cart);
  assert.equal(confirms, 1);
});

test('승인 후 여전히 PENDING이면 성공으로 처리하지 않고 재진입 재승인을 막는다', async () => {
  let confirms = 0;
  const { manager, api, storage } = setup({
    confirmPayment: async () => { confirms += 1; }, getOrder: async () => order,
  });
  await assert.rejects(manager.payTest(cart), /결제 완료 상태/);
  const reentered = createCheckoutManager({ api, storage });
  await assert.rejects(reentered.payTest(cart), /이전 주문/);
  assert.equal(confirms, 1);
});

test('저장된 주문의 번호·금액이 서버와 다르면 승인하지 않는다', async () => {
  const { manager, api, calls } = setup();
  await manager.prepare(cart);
  api.getOrder = async () => ({ ...order, orderNumber: 'ORD-OTHER' });
  await assert.rejects(manager.payTest(cart), /저장된 주문/);
  assert.equal(calls.filter(([kind]) => kind === 'confirm').length, 0);
});

test('진행 중인 prepare를 payTest의 결제 완료 결과로 잘못 공유하지 않는다', async () => {
  let release;
  const { manager } = setup({ createOrder: () => new Promise((resolve) => { release = resolve; }) });
  const preparing = manager.prepare(cart);
  await Promise.resolve();
  await assert.rejects(manager.payTest(cart), /이전 요청/);
  release(order);
  await preparing;
});


test('주문번호와 총액이 같아도 서버 항목이 바뀌면 승인하지 않는다', async () => {
  const { manager, api, calls } = setup();
  await manager.prepare(cart);
  api.getOrder = async () => ({ ...order, items: [{ ...order.items[0], menuId: 2 }] });
  await assert.rejects(manager.payTest(cart), /주문 항목/);
  assert.equal(calls.filter(([kind]) => kind === 'confirm').length, 0);
});
