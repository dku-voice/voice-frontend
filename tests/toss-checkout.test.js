import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKOUT_STORAGE_KEY, createCheckoutManager } from '../src/domain/checkout.js';

const cart = [{ menuId: 1, id: 1, lineId: '1:', name: '버거', quantity: 2, optionIds: [], price: 2800 }];
const pendingOrder = {
  orderId: 31, orderNumber: 'ORD-MOCK-31', status: 'PENDING', totalPrice: 6000,
  items: [{ menuId: 1, menuNameKo: '버거', quantity: 2, unitPrice: 3000, subtotal: 6000, options: [] }],
};
const callback = { paymentKey: 'mock-payment-key', orderNumber: pendingOrder.orderNumber, amount: pendingOrder.totalPrice };
const store = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};
const setup = () => {
  const storage = store();
  const calls = [];
  const state = { order: structuredClone(pendingOrder) };
  const api = {
    createOrder: async (body) => { calls.push(['create', body]); return structuredClone(state.order); },
    getOrder: async (orderId) => { calls.push(['get', orderId]); return structuredClone(state.order); },
    confirmPayment: async (body) => { calls.push(['confirm', body]); state.order.status = 'PAID'; return { paymentId: 7 }; },
  };
  const manager = createCheckoutManager({ api, storage, uuid: () => 'test-transaction' });
  return { manager, api, storage, calls, state };
};
const confirmations = (calls) => calls.filter(([kind]) => kind === 'confirm');
const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
};

test('Toss 콜백은 PG 주문번호를 대조하고 백엔드에는 숫자 DB ID와 서버 총액을 전달한다', async () => {
  const { manager, calls } = setup();
  const original = structuredClone(cart);
  await manager.prepare(cart);
  assert.equal((await manager.confirmToss(callback)).status, 'PAID');
  assert.deepEqual(calls, [
    ['create', { items: [{ menuId: 1, quantity: 2, optionIds: [] }] }],
    ['get', 31],
    ['confirm', { pgProvider: 'TOSS', pgTransactionId: callback.paymentKey, orderId: 31, amount: 6000, method: 'CARD' }],
    ['get', 31],
  ]);
  assert.deepEqual(cart, original);
  assert.equal(manager.getSaved().phase, 'paid');
});

test('markTossRequested는 요청 없이 선택한 수단을 저장하고 콜백은 저장된 수단만 사용한다', async () => {
  for (const method of ['CARD', 'KAKAO_PAY', 'NAVER_PAY', 'TOSS']) {
    const { manager, api, storage, calls } = setup();
    await manager.prepare(cart);
    const before = calls.length;
    assert.deepEqual(manager.markTossRequested({ orderNumber: callback.orderNumber, amount: callback.amount, method }), {
      pgProvider: 'TOSS', orderNumber: callback.orderNumber, amount: callback.amount, method,
    });
    assert.equal(calls.length, before);
    const restored = createCheckoutManager({ api, storage });
    await restored.confirmToss({ ...callback, method: 'unsupported-query-value' });
    assert.equal(confirmations(calls)[0][1].method, method);
  }
});

test('선택 마커가 없는 이전 checkout 기록의 결제수단 기본값은 CARD다', async () => {
  const { manager, api, storage, calls } = setup();
  await manager.prepare(cart);
  const restored = createCheckoutManager({ api, storage });
  await restored.confirmToss(callback);
  assert.equal(confirmations(calls)[0][1].method, 'CARD');
});

test('주문번호·금액·인증키 위변조와 준비되지 않은 주문은 승인하지 않는다', async () => {
  const { manager, calls } = setup();
  await assert.rejects(manager.confirmToss(callback), /이전 주문/);
  await manager.prepare(cart);
  const snapshot = manager.getSaved();
  for (const change of [
    { orderNumber: 'OTHER-ORDER' }, { amount: 1 }, { amount: '6000' },
    { paymentKey: '' }, { paymentKey: 'bad key' }, { paymentKey: null },
  ]) await assert.rejects(manager.confirmToss({ ...callback, ...change }));
  for (const payload of [
    { orderNumber: 'OTHER-ORDER', amount: 6000, method: 'CARD' },
    { orderNumber: callback.orderNumber, amount: 1, method: 'CARD' },
    { ...callback, method: 'PAYCO' }, { ...callback, method: 'TRANSFER' },
  ]) assert.throws(() => manager.markTossRequested(payload));
  assert.deepEqual(manager.getSaved(), snapshot);
  assert.equal(calls.length, 1);
  assert.equal(manager.getPendingTossReturn(), null);
});

test('첫 주문 GET이 500이어도 검증된 인증을 보관하고 새 manager의 명시적 재시도로 한 번만 승인한다', async () => {
  const { manager, api, storage, calls } = setup();
  await manager.prepare(cart);
  manager.markTossRequested({ ...callback, method: 'KAKAO_PAY' });
  assert.equal(manager.getPendingTossReturn(), null);
  const read = api.getOrder;
  let gets = 0;
  api.getOrder = async (id) => {
    gets += 1;
    if (gets === 1) {
      assert.deepEqual(manager.getPendingTossReturn(), { type: 'success', ...callback });
      throw Object.assign(new Error('order read 500'), { status: 500 });
    }
    return read(id);
  };
  await assert.rejects(manager.confirmToss(callback), /order read 500/);
  assert.equal(manager.getSaved().phase, 'ready');
  assert.equal(confirmations(calls).length, 0);

  const restored = createCheckoutManager({ api, storage });
  const before = calls.length;
  const retry = restored.getPendingTossReturn();
  assert.deepEqual(retry, { type: 'success', ...callback });
  assert.equal(calls.length, before);
  retry.amount = 1;
  assert.deepEqual(restored.getPendingTossReturn(), { type: 'success', ...callback });
  assert.equal((await restored.confirmToss(restored.getPendingTossReturn())).status, 'PAID');
  assert.equal(confirmations(calls).length, 1);
  assert.equal(confirmations(calls)[0][1].method, 'KAKAO_PAY');
  assert.equal(restored.getPendingTossReturn(), null);
  await restored.confirmToss(callback);
  assert.equal(confirmations(calls).length, 1);
  restored.clearPaid();
  assert.equal(restored.getSaved(), null);
});

test('첫 GET 실패 뒤 다른 키·금액이나 새 인증·TEST·새 주문으로 보관한 콜백을 대체하지 않는다', async () => {
  const { manager, api, storage, calls } = setup();
  await manager.prepare(cart);
  let gets = 0;
  api.getOrder = async () => { gets += 1; throw Object.assign(new Error('read failed'), { status: 500 }); };
  await assert.rejects(manager.confirmToss(callback), /read failed/);
  const restored = createCheckoutManager({ api, storage });
  const snapshot = restored.getSaved();
  for (const change of [{ paymentKey: 'different-key' }, { amount: 1 }, { orderNumber: 'OTHER-ORDER' }]) {
    await assert.rejects(restored.confirmToss({ ...callback, ...change }));
  }
  assert.throws(() => restored.markTossRequested({ ...callback, method: 'TOSS' }), /이전 주문/);
  await assert.rejects(restored.prepare([{ ...cart[0], quantity: 3 }]), /이전 주문/);
  await assert.rejects(restored.payTest(cart), /이전 주문/);
  assert.throws(() => restored.beginNewCheckout(), /이전 주문/);
  assert.deepEqual(restored.getSaved(), snapshot);
  assert.equal(gets, 1);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(confirmations(calls).length, 0);
});

test('확인 중인 인증은 GET이 계속 실패해도 복구 정보만 반환하며 승인 POST를 추가하지 않는다', async () => {
  const { manager, api, storage, state } = setup();
  let posts = 0;
  api.confirmPayment = async () => { posts += 1; throw Object.assign(new Error('approval timeout'), { code: 'TIMEOUT' }); };
  await manager.prepare(cart);
  await assert.rejects(manager.confirmToss(callback), /approval timeout/);
  api.getOrder = async () => { throw Object.assign(new Error('read 500'), { status: 500 }); };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const restored = createCheckoutManager({ api, storage });
    assert.deepEqual(restored.getPendingTossReturn(), { type: 'success', ...callback });
    await assert.rejects(restored.confirmToss(restored.getPendingTossReturn()), /read 500/);
    assert.equal(restored.getSaved().phase, 'confirming');
  }
  assert.equal(posts, 1);
  state.order.status = 'PAID';
  api.getOrder = async () => structuredClone(state.order);
  const recovered = createCheckoutManager({ api, storage });
  assert.equal((await recovered.confirmToss(recovered.getPendingTossReturn())).status, 'PAID');
  assert.equal(recovered.getPendingTossReturn(), null);
  assert.equal(posts, 1);
});

test('이전 confirming의 TOSS 거래키만으로 GET-only 복구하며 PAID 확인 전 승인 POST를 반복하지 않는다', async () => {
  const { manager, api, storage, state, calls } = setup();
  await manager.prepare(cart);
  manager.markTossRequested({ ...callback, method: 'KAKAO_PAY' });
  const legacy = {
    ...manager.getSaved(), phase: 'confirming',
    confirmation: { provider: 'TOSS', transactionId: callback.paymentKey, method: 'KAKAO_PAY' },
  };
  assert.equal(legacy.tossReturn, undefined);
  const before = calls.length;
  for (const invalid of [
    { ...legacy, phase: 'ready' }, { ...legacy, phase: 'paid' }, { ...legacy, phase: 'closed' },
    { ...legacy, confirmation: { ...legacy.confirmation, provider: 'TEST' } },
    { ...legacy, confirmation: { ...legacy.confirmation, transactionId: undefined } },
    { ...legacy, confirmation: { ...legacy.confirmation, transactionId: 'bad key' } },
    { ...legacy, confirmation: { ...legacy.confirmation, method: 'PAYCO' } },
    { ...legacy, confirmation: { ...legacy.confirmation, method: undefined } },
  ]) {
    storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(invalid));
    assert.equal(createCheckoutManager({ api, storage }).getPendingTossReturn(), null);
  }
  storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(legacy));
  const restored = createCheckoutManager({ api, storage });
  assert.deepEqual(restored.getPendingTossReturn(), { type: 'success', ...callback });
  assert.equal(calls.length, before);
  assert.equal(restored.getSaved().tossReturn, undefined);
  await assert.rejects(restored.confirmToss({ ...callback, paymentKey: 'different-key' }), /인증 정보와 다릅니다/);
  await assert.rejects(restored.confirmToss(restored.getPendingTossReturn()), /이전 주문/);
  assert.equal(confirmations(calls).length, 0);
  assert.equal(restored.getSaved().phase, 'confirming');
  state.order.status = 'PAID';
  const recovered = createCheckoutManager({ api, storage });
  assert.equal((await recovered.confirmToss(recovered.getPendingTossReturn())).status, 'PAID');
  assert.equal(recovered.getPendingTossReturn(), null);
  assert.equal(confirmations(calls).length, 0);
});

test('복구 getter는 종료·완료·손상된 콜백이나 주문·결제수단을 네트워크 없이 거부한다', async () => {
  const { manager, api, storage, calls } = setup();
  await manager.prepare(cart);
  api.getOrder = async () => { throw new Error('read failed'); };
  await assert.rejects(manager.confirmToss(callback));
  const saved = manager.getSaved();
  const variants = [
    { ...saved, phase: 'paid' }, { ...saved, phase: 'closed' },
    { ...saved, tossReturn: { ...saved.tossReturn, type: 'fail' } },
    { ...saved, tossReturn: { ...saved.tossReturn, paymentKey: 'bad key' } },
    { ...saved, tossReturn: { ...saved.tossReturn, orderNumber: 'OTHER-ORDER' } },
    { ...saved, tossReturn: { ...saved.tossReturn, amount: 1 } },
    { ...saved, tossRequest: { pgProvider: 'TOSS', ...callback, method: 'PAYCO' } },
    { ...saved, cart: [{ ...cart[0], quantity: 1 }] },
    { ...saved, phase: 'confirming', confirmation: { provider: 'TOSS', transactionId: 'different-key', method: 'CARD' } },
  ];
  const before = calls.length;
  for (const variant of variants) {
    storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(variant));
    assert.equal(createCheckoutManager({ api, storage }).getPendingTossReturn(), null);
  }
  assert.equal(calls.length, before);
});

test('복구 getter는 저장된 인증을 우선하고 유효한 URL 후보만 저장·요청 없이 반환한다', async () => {
  const { manager, api, storage, calls } = setup();
  await manager.prepare(cart);
  manager.markTossRequested({ ...callback, method: 'KAKAO_PAY' });
  const ready = manager.getSaved();
  const before = calls.length;
  assert.deepEqual(manager.getPendingTossReturn({ type: 'success', ...callback }), { type: 'success', ...callback });
  for (const candidate of [
    callback, { type: 'fail', ...callback }, { type: 'success', ...callback, amount: 1 },
    { type: 'success', ...callback, amount: '6000' }, { type: 'success', ...callback, orderNumber: 'OTHER-ORDER' },
    { type: 'success', ...callback, paymentKey: '' }, { type: 'success', ...callback, paymentKey: 'bad key' },
  ]) assert.equal(manager.getPendingTossReturn(candidate), null);
  assert.deepEqual(manager.getSaved(), ready);
  assert.equal(calls.length, before);

  api.getOrder = async () => { throw new Error('read failed'); };
  await assert.rejects(manager.confirmToss(callback));
  const saved = manager.getSaved();
  assert.deepEqual(manager.getPendingTossReturn({ type: 'success', ...callback, paymentKey: 'different-key', amount: 1 }), {
    type: 'success', ...callback,
  });
  for (const change of [
    { phase: 'paid' }, { phase: 'closed' },
    { tossRequest: { ...saved.tossRequest, method: 'PAYCO' } },
    { tossReturn: { ...saved.tossReturn, amount: 1 } },
  ]) {
    storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify({ ...saved, ...change }));
    assert.equal(createCheckoutManager({ api, storage }).getPendingTossReturn({ type: 'success', ...callback }), null);
  }
  assert.equal(calls.length, before);
});

test('같은 주문의 영수증 GET은 다섯 terminal 상태를 저장해 미확정 결제를 해제한다', async () => {
  for (const status of ['PAID', 'PREPARING', 'COMPLETED', 'CANCELLED', 'REFUNDED']) {
    const { manager, api, state, calls } = setup();
    await manager.prepare(cart);
    const read = api.getOrder;
    api.getOrder = async () => { throw new Error('first GET failed'); };
    await assert.rejects(manager.confirmToss(callback));
    assert.ok(manager.getPendingTossReturn());
    api.getOrder = read;
    state.order.status = status;
    assert.equal((await manager.readReceipt(31)).status, status);
    assert.equal(manager.getSaved().phase, ['CANCELLED', 'REFUNDED'].includes(status) ? 'closed' : 'paid');
    assert.equal(manager.getSaved().order.status, status);
    assert.equal(manager.getPendingTossReturn(), null);
    assert.deepEqual(manager.restoreCart(), cart);
    assert.equal(confirmations(calls).length, 0);
    manager.beginNewCheckout();
    assert.equal(manager.getSaved(), null);
  }
});

test('영수증 PENDING·GET 실패·주문 불일치는 인증 스냅샷을 그대로 보존하고 다른 cart POST를 막는다', async () => {
  const { manager, api, calls } = setup();
  await manager.prepare(cart);
  const read = api.getOrder;
  api.getOrder = async () => { throw new Error('first GET failed'); };
  await assert.rejects(manager.confirmToss(callback));
  const saved = manager.getSaved();
  api.getOrder = read;
  assert.equal((await manager.readReceipt(31)).status, 'PENDING');
  assert.deepEqual(manager.getSaved(), saved);
  api.getOrder = async () => { throw Object.assign(new Error('read 500'), { status: 500 }); };
  await assert.rejects(manager.readReceipt(31), /read 500/);
  api.getOrder = async () => ({ ...structuredClone(pendingOrder), status: 'PAID', orderNumber: 'OTHER-ORDER' });
  await assert.rejects(manager.readReceipt(31), /주문번호 또는 금액/);
  assert.deepEqual(manager.getSaved(), saved);
  await assert.rejects(manager.prepare([{ ...cart[0], quantity: 3 }]), /이전 주문/);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(confirmations(calls).length, 0);
});

test('다른 주문의 영수증 조회는 현재 checkout을 변경하지 않는다', async () => {
  const { manager, api, calls } = setup();
  await manager.prepare(cart);
  const saved = manager.getSaved();
  api.getOrder = async (orderId) => {
    assert.equal(orderId, 99);
    return { ...structuredClone(pendingOrder), orderId, orderNumber: 'ORD-OTHER-99', status: 'PAID' };
  };
  assert.equal((await manager.readReceipt(99)).orderId, 99);
  assert.deepEqual(manager.getSaved(), saved);
  assert.equal(confirmations(calls).length, 0);
});

test('늦은 영수증 GET은 정리된 기록이나 다른 cart로 준비한 새 checkout을 되살리거나 덮지 않는다', async () => {
  for (const prepareNew of [false, true]) {
    const { manager, api, state } = setup();
    await manager.prepare(cart);
    const response = deferred();
    api.getOrder = () => response.promise;
    const receipt = manager.readReceipt(31);
    manager.beginNewCheckout();
    if (prepareNew) {
      state.order = { ...structuredClone(pendingOrder), orderId: 32, orderNumber: 'ORD-NEW-32' };
      state.order.items[0].menuId = 2;
      await manager.prepare([{ ...cart[0], menuId: 2, id: 2 }]);
    }
    const current = manager.getSaved();
    response.resolve({ ...structuredClone(pendingOrder), status: 'PAID' });
    assert.equal((await receipt).status, 'PAID');
    assert.deepEqual(manager.getSaved(), current);
  }
});

test('늦은 영수증 GET은 동일·다른 manager의 새 승인 상태를 덮어쓰지 않는다', async () => {
  for (const otherManager of [false, true]) {
    const { manager, api, storage, state, calls } = setup();
    await manager.prepare(cart);
    const staleResponse = deferred();
    const approvalStarted = deferred();
    const finishApproval = deferred();
    const read = api.getOrder;
    let reads = 0;
    api.getOrder = (id) => ++reads === 1 ? staleResponse.promise : read(id);
    api.confirmPayment = async (body) => {
      calls.push(['confirm', body]);
      approvalStarted.resolve();
      await finishApproval.promise;
      state.order.status = 'PAID';
      return { paymentId: 7 };
    };
    const receipt = manager.readReceipt(31);
    const active = otherManager ? createCheckoutManager({ api, storage }) : manager;
    const approval = active.confirmToss(callback);
    await approvalStarted.promise;
    const confirming = active.getSaved();
    assert.equal(confirming.phase, 'confirming');
    staleResponse.resolve({ ...structuredClone(pendingOrder), status: 'CANCELLED' });
    await receipt;
    assert.deepEqual(active.getSaved(), confirming);
    finishApproval.resolve();
    assert.equal((await approval).status, 'PAID');
    assert.equal(confirmations(calls).length, 1);
  }
});

test('새 영수증 GET 시작 후 이전 GET의 PAID 결과는 새 GET이 500이어도 pending을 해제하지 않는다', async () => {
  const { manager, api, calls } = setup();
  await manager.prepare(cart);
  api.getOrder = async () => { throw new Error('first GET failed'); };
  await assert.rejects(manager.confirmToss(callback));
  const pending = manager.getSaved();
  const oldResponse = deferred();
  const newResponse = deferred();
  let reads = 0;
  api.getOrder = () => {
    reads += 1;
    return reads === 1 ? oldResponse.promise : newResponse.promise.then(() => {
      throw Object.assign(new Error('latest GET 500'), { status: 500 });
    });
  };
  const oldReceipt = manager.readReceipt(31);
  const latestReceipt = manager.readReceipt(31);
  oldResponse.resolve({ ...structuredClone(pendingOrder), status: 'PAID' });
  assert.equal((await oldReceipt).status, 'PAID');
  assert.deepEqual(manager.getSaved(), pending);
  newResponse.resolve();
  await assert.rejects(latestReceipt, /latest GET 500/);
  assert.deepEqual(manager.getSaved(), pending);
  assert.deepEqual(manager.getPendingTossReturn(), { type: 'success', ...callback });
  await assert.rejects(manager.prepare([{ ...cart[0], quantity: 3 }]), /이전 주문/);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(confirmations(calls).length, 0);
});

test('인증 전 일반 ready는 장바구니를 편집한 뒤 새 주문 준비를 계속 허용한다', async () => {
  const { manager, state, calls } = setup();
  await manager.prepare(cart);
  state.order = { ...structuredClone(pendingOrder), orderId: 32, orderNumber: 'ORD-EDITED-32' };
  state.order.items[0] = { ...state.order.items[0], quantity: 3, subtotal: 9000 };
  state.order.totalPrice = 9000;
  assert.equal((await manager.prepare([{ ...cart[0], quantity: 3 }])).orderId, 32);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 2);
  assert.equal(confirmations(calls).length, 0);
});

test('같은 callback 동시 호출은 Promise를 공유하고 다른 인증키는 진행 중에 승인하지 않는다', async () => {
  const { manager, api, calls } = setup();
  await manager.prepare(cart);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const approve = api.confirmPayment;
  api.confirmPayment = async (body) => { await blocked; return approve(body); };
  const first = manager.confirmToss(callback);
  const duplicate = manager.confirmToss({ ...callback });
  assert.equal(first, duplicate);
  await assert.rejects(manager.confirmToss({ ...callback, paymentKey: 'different-key' }), /이전 요청/);
  assert.throws(() => manager.markTossRequested({ ...callback, method: 'TOSS' }), /이전 요청/);
  release();
  assert.equal((await first).status, 'PAID');
  assert.equal(confirmations(calls).length, 1);
});

test('콜백 인자를 나중에 수정해도 검증한 주문과 금액으로만 승인한다', async () => {
  const { manager, calls } = setup();
  await manager.prepare(cart);
  const input = { ...callback };
  const pending = manager.confirmToss(input);
  input.paymentKey = 'mutated-key'; input.amount = 1;
  await pending;
  assert.equal(confirmations(calls)[0][1].pgTransactionId, callback.paymentKey);
  assert.equal(confirmations(calls)[0][1].amount, 6000);
});

test('이미 PAID·PREPARING·COMPLETED인 주문은 새로고침 후에도 다시 승인하지 않는다', async () => {
  for (const status of ['PAID', 'PREPARING', 'COMPLETED']) {
    const { manager, api, storage, state, calls } = setup();
    await manager.prepare(cart);
    state.order.status = status;
    const restored = createCheckoutManager({ api, storage });
    assert.equal((await restored.confirmToss(callback)).status, status);
    await restored.confirmToss(callback);
    assert.equal(confirmations(calls).length, 0);
    assert.equal(restored.getSaved().phase, 'paid');
  }
});

test('승인 응답 유실 뒤 GET에서 PAID이면 복구하고 승인 POST를 반복하지 않는다', async () => {
  const { manager, api, storage, calls } = setup();
  await manager.prepare(cart);
  const approve = api.confirmPayment;
  api.confirmPayment = async (body) => {
    await approve(body);
    throw Object.assign(new Error('lost response'), { code: 'NETWORK_ERROR' });
  };
  assert.equal((await manager.confirmToss(callback)).status, 'PAID');
  const restored = createCheckoutManager({ api, storage });
  await restored.confirmToss(callback);
  assert.equal(confirmations(calls).length, 1);
});

test('confirming 상태 재진입은 조회만 하고 PENDING이면 차단하며 나중에 PAID일 때 복구한다', async () => {
  const { manager, api, storage, state } = setup();
  let posts = 0;
  api.confirmPayment = async () => { posts += 1; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); };
  await manager.prepare(cart);
  await assert.rejects(manager.confirmToss(callback), /timeout/);
  assert.equal(manager.getSaved().phase, 'confirming');
  const restored = createCheckoutManager({ api, storage });
  await assert.rejects(restored.confirmToss(callback), /이전 주문/);
  await assert.rejects(restored.confirmToss({ ...callback, paymentKey: 'different-key' }), /인증 정보와 다릅니다/);
  assert.throws(() => restored.markTossRequested({ ...callback, method: 'TOSS' }), /이전 주문/);
  state.order.status = 'PAID';
  assert.equal((await restored.confirmToss(callback)).status, 'PAID');
  assert.equal(posts, 1);
});

test('승인 후 최종 GET만 실패해도 다음 페이지에서 PAID를 조회하여 복구한다', async () => {
  const { manager, api, storage, calls } = setup();
  await manager.prepare(cart);
  const read = api.getOrder;
  let gets = 0;
  api.getOrder = async (id) => {
    gets += 1;
    if (gets === 2) throw Object.assign(new Error('read failed'), { code: 'NETWORK_ERROR' });
    return read(id);
  };
  await assert.rejects(manager.confirmToss(callback), /read failed/);
  assert.equal(manager.getSaved().phase, 'confirming');
  const restored = createCheckoutManager({ api, storage });
  assert.equal((await restored.confirmToss(callback)).status, 'PAID');
  assert.equal(confirmations(calls).length, 1);
});

test('확정 400과 GET PENDING을 함께 확인한 경우에만 다음 명시적 승인 시도를 허용한다', async () => {
  const { manager, api, calls } = setup();
  await manager.prepare(cart);
  const approve = api.confirmPayment;
  let posts = 0;
  api.confirmPayment = async (body) => {
    posts += 1;
    if (posts === 1) throw Object.assign(new Error('invalid request'), { status: 400 });
    return approve(body);
  };
  await assert.rejects(manager.confirmToss(callback), /invalid request/);
  assert.equal(posts, 1);
  assert.equal(manager.getSaved().phase, 'ready');
  assert.equal((await manager.confirmToss(callback)).status, 'PAID');
  assert.equal(posts, 2);
  assert.equal(confirmations(calls).length, 1);
});

test('409·429·500은 GET PENDING이어도 불확정 상태를 유지하고 다시 승인하지 않는다', async () => {
  for (const status of [409, 429, 500]) {
    const { manager, api, storage } = setup();
    let posts = 0;
    api.confirmPayment = async () => { posts += 1; throw Object.assign(new Error('ambiguous failure'), { status }); };
    await manager.prepare(cart);
    await assert.rejects(manager.confirmToss(callback));
    const restored = createCheckoutManager({ api, storage });
    await assert.rejects(restored.confirmToss(callback), /이전 주문/);
    assert.equal(posts, 1);
    assert.equal(restored.getSaved().phase, 'confirming');
  }
});

test('400 뒤 서버 조회가 실패하면 재시도 가능 상태로 바꾸지 않는다', async () => {
  const { manager, api, storage } = setup();
  await manager.prepare(cart);
  let posts = 0;
  let gets = 0;
  api.getOrder = async () => { if (++gets > 1) throw new Error('read failed'); return structuredClone(pendingOrder); };
  api.confirmPayment = async () => { posts += 1; throw Object.assign(new Error('bad request'), { status: 400 }); };
  await assert.rejects(manager.confirmToss(callback), /bad request/);
  const restored = createCheckoutManager({ api, storage });
  api.getOrder = async () => structuredClone(pendingOrder);
  await assert.rejects(restored.confirmToss(callback), /이전 주문/);
  assert.equal(posts, 1);
});

test('인증 콜백 저장에 실패하면 첫 GET과 Toss 승인 POST를 모두 보내지 않는다', async () => {
  const { manager, storage, calls } = setup();
  await manager.prepare(cart);
  storage.setItem = () => { throw new Error('storage blocked'); };
  await assert.rejects(manager.confirmToss(callback), /저장/);
  assert.equal(calls.filter(([kind]) => kind === 'get').length, 0);
  assert.equal(confirmations(calls).length, 0);
  assert.deepEqual(manager.getPendingTossReturn(), { type: 'success', ...callback });
  await assert.rejects(manager.payTest(cart), /이전 주문/);
  assert.throws(() => manager.beginNewCheckout(), /이전 주문/);
});

test('인증은 저장됐어도 confirming 저장에 실패하면 승인 POST를 보내지 않는다', async () => {
  const { manager, storage, calls } = setup();
  await manager.prepare(cart);
  const write = storage.setItem;
  storage.setItem = (key, value) => {
    if (JSON.parse(value).phase === 'confirming') throw new Error('storage blocked');
    write(key, value);
  };
  await assert.rejects(manager.confirmToss(callback), /저장/);
  assert.equal(calls.filter(([kind]) => kind === 'get').length, 1);
  assert.equal(confirmations(calls).length, 0);
  assert.equal(manager.getSaved().phase, 'confirming');
  assert.deepEqual(manager.getPendingTossReturn(), { type: 'success', ...callback });
});

test('승인 응답이 성공이어도 주문 GET이 PENDING이면 완료로 표시하거나 재승인하지 않는다', async () => {
  const { manager, api, storage } = setup();
  let posts = 0;
  api.confirmPayment = async () => { posts += 1; return { paymentId: 7 }; };
  await manager.prepare(cart);
  await assert.rejects(manager.confirmToss(callback), /결제 완료 상태/);
  const restored = createCheckoutManager({ api, storage });
  await assert.rejects(restored.confirmToss(callback), /이전 주문/);
  assert.equal(restored.getSaved().phase, 'confirming');
  assert.equal(posts, 1);
});

test('불확정 승인 중 TEST와 TOSS를 바꾸어도 다른 승인 POST를 보내지 않는다', async () => {
  for (const firstProvider of ['TEST', 'TOSS']) {
    const { manager, api } = setup();
    let posts = 0;
    api.confirmPayment = async () => { posts += 1; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); };
    await manager.prepare(cart);
    await assert.rejects(firstProvider === 'TEST' ? manager.payTest(cart) : manager.confirmToss(callback));
    await assert.rejects(firstProvider === 'TEST' ? manager.confirmToss(callback) : manager.payTest(cart), /이전 주문/);
    assert.equal(posts, 1);
  }
});

test('서버 주문 변경·취소와 저장된 결제수단 변조는 승인 전에 거부한다', async () => {
  for (const change of [
    { orderNumber: 'OTHER-ORDER' }, { totalPrice: 8000, items: [{ ...pendingOrder.items[0], unitPrice: 4000, subtotal: 8000 }] },
    { items: [{ ...pendingOrder.items[0], menuId: 2 }] }, { status: 'CANCELLED' }, { status: 'REFUNDED' },
  ]) {
    const { manager, state, calls } = setup();
    await manager.prepare(cart);
    state.order = { ...state.order, ...change };
    await assert.rejects(manager.confirmToss(callback));
    assert.equal(confirmations(calls).length, 0);
  }
  const { manager, storage, calls } = setup();
  await manager.prepare(cart);
  manager.markTossRequested({ ...callback, method: 'CARD' });
  const saved = manager.getSaved();
  saved.tossRequest.method = 'PAYCO';
  storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(saved));
  await assert.rejects(manager.confirmToss(callback), /결제 수단/);
  assert.equal(confirmations(calls).length, 0);
});
