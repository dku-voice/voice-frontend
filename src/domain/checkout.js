import {
  buildOrderBody, cartFingerprint, normalizeOrder, isPaidOrder,
  assertOrderMatchesCheckout, isUncertainOrderError,
} from './kiosk.js';

export const CHECKOUT_STORAGE_KEY = 'voice-kiosk-checkout-v2';
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const uncertain = () => new Error('이전 주문 또는 결제의 처리 결과를 확인하지 못했습니다. 관리자에게 주문 내역 확인을 요청해 주세요.');

export function createCheckoutManager({ api, storage, uuid = () => globalThis.crypto.randomUUID() }) {
  let memory = null;
  let running = null;
  const read = () => {
    try {
      const saved = JSON.parse(storage.getItem(CHECKOUT_STORAGE_KEY));
      if (saved?.version === 1 && typeof saved.fingerprint === 'string' && Array.isArray(saved.cart)) return saved;
    } catch { /* Recover from memory within this page if storage becomes unavailable. */ }
    return memory;
  };
  const save = (saved) => {
    const next = { ...saved, updatedAt: Date.now() };
    const json = JSON.stringify(next);
    try {
      storage.setItem(CHECKOUT_STORAGE_KEY, json);
      if (storage.getItem(CHECKOUT_STORAGE_KEY) !== json) throw new Error('storage');
    } catch {
      // Preserve the uncertain state in memory; do not issue another POST.
      memory = copy(next);
      throw new Error('주문 정보를 저장할 수 없습니다. 브라우저의 저장소 설정을 확인해 주세요.');
    }
    memory = copy(next);
    return next;
  };
  const clear = () => {
    try { storage.removeItem(CHECKOUT_STORAGE_KEY); } catch { throw new Error('저장된 주문을 정리할 수 없습니다.'); }
    memory = null;
  };
  const prepareInternal = async (cart) => {
    const body = buildOrderBody(cart);
    const fingerprint = cartFingerprint(cart);
    let saved = read();
    if (saved && ['creating', 'confirming'].includes(saved.phase) && saved.fingerprint !== fingerprint) throw uncertain();
    if (saved?.fingerprint === fingerprint) {
      if (saved.phase === 'creating') throw uncertain();
      if (saved.order) {
        const order = normalizeOrder(await api.getOrder(saved.order.orderId));
        assertOrderMatchesCheckout(order, saved);
        if (isPaidOrder(order)) { save({ ...saved, order, phase: 'paid' }); return order; }
        if (saved.phase === 'confirming') throw uncertain();
        if (order.status === 'PENDING') return order;
        save({ ...saved, order, phase: 'closed' });
        throw new Error('이 주문은 결제할 수 없는 상태입니다. 새 주문을 시작해 주세요.');
      }
    }
    saved = {
      version: 1, phase: 'creating', fingerprint, cart: copy(cart), order: null,
      transactionId: `test-${uuid()}`, createdAt: Date.now(),
    };
    save(saved);
    try {
      const order = normalizeOrder(await api.createOrder(body));
      if (order.status !== 'PENDING' || cartFingerprint(order.items) !== fingerprint) throw new Error('생성된 주문이 장바구니와 다릅니다. 관리자에게 문의해 주세요.');
      save({ ...saved, order, phase: 'ready' });
      return order;
    } catch (failure) {
      if (!isUncertainOrderError(failure)) clear();
      throw failure;
    }
  };
  const exclusive = (cart, kind, operation) => {
    let fingerprint;
    try { fingerprint = cartFingerprint(cart); } catch (failure) { return Promise.reject(failure); }
    if (running) return running.fingerprint === fingerprint && running.kind === kind ? running.promise : Promise.reject(new Error('이전 요청을 처리 중입니다.'));
    const promise = Promise.resolve().then(operation).finally(() => { if (running?.promise === promise) running = null; });
    running = { fingerprint, kind, promise };
    return promise;
  };
  return {
    getSaved: () => copy(read()),
    restoreCart: () => copy(read()?.cart || []),
    prepare: (cart) => exclusive(cart, 'prepare', () => prepareInternal(cart)),
    payTest: (cart) => exclusive(cart, 'pay', async () => {
      const order = await prepareInternal(cart);
      if (isPaidOrder(order)) return order;
      const saved = read();
      if (!saved || saved.phase !== 'ready' || !saved.transactionId) throw uncertain();
      save({ ...saved, phase: 'confirming' });
      try {
        await api.confirmPayment({
          pgProvider: 'TEST', pgTransactionId: saved.transactionId,
          orderId: order.orderId, amount: order.totalPrice, method: 'CARD',
        });
      } catch (failure) {
        // A lost approval response may already have changed the server's order.
        try {
          const observed = normalizeOrder(await api.getOrder(order.orderId));
          assertOrderMatchesCheckout(observed, saved);
          if (isPaidOrder(observed)) { save({ ...saved, order: observed, phase: 'paid' }); return observed; }
        } catch { /* The uncertain marker is retained. */ }
        throw failure;
      }
      const paid = normalizeOrder(await api.getOrder(order.orderId));
      assertOrderMatchesCheckout(paid, saved);
      if (!isPaidOrder(paid)) throw new Error('승인 요청 후 결제 완료 상태를 확인하지 못했습니다. 주문 내역을 확인해 주세요.');
      save({ ...saved, order: paid, phase: 'paid' });
      return paid;
    }),
    readReceipt: async (orderId) => normalizeOrder(await api.getOrder(orderId)),
    beginNewCheckout: () => {
      if (running || ['creating', 'confirming'].includes(read()?.phase)) throw uncertain();
      clear();
    },
    clearPaid: () => { if (read()?.phase === 'paid') clear(); },
  };
}
