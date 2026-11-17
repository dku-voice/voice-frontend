import {
  buildOrderBody, cartFingerprint, normalizeOrder, isPaidOrder,
  assertOrderMatchesCheckout, isUncertainOrderError,
} from './kiosk.js';

export const CHECKOUT_STORAGE_KEY = 'voice-kiosk-checkout-v2';
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const uncertain = () => new Error('이전 주문 또는 결제의 처리 결과를 확인하지 못했습니다. 관리자에게 주문 내역 확인을 요청해 주세요.');
const TOSS_METHODS = new Set(['CARD', 'KAKAO_PAY', 'NAVER_PAY', 'TOSS']);
const hasPendingTossReturn = (saved) => Boolean(saved?.tossReturn && ['ready', 'confirming'].includes(saved.phase));
// A 409 can wrap an ambiguous PG failure in the current backend. Do not retry it.
const definiteApprovalRejection = (error) => error?.code === 'INVALID_INPUT'
  || [400, 401, 403, 404, 405, 422].includes(error?.status);

export function createCheckoutManager({ api, storage, uuid = () => globalThis.crypto.randomUUID() }) {
  let memory = null;
  let preferMemory = false;
  let running = null;
  let revision = 0;
  let receiptReadSeq = 0;
  const read = () => {
    if (preferMemory) return memory;
    try {
      const saved = JSON.parse(storage.getItem(CHECKOUT_STORAGE_KEY));
      if (saved?.version === 1 && typeof saved.fingerprint === 'string' && Array.isArray(saved.cart)) return saved;
    } catch { /* Recover from memory within this page if storage becomes unavailable. */ }
    return memory;
  };
  const save = (saved) => {
    revision += 1;
    const next = { ...saved, updatedAt: Date.now() };
    const json = JSON.stringify(next);
    try {
      storage.setItem(CHECKOUT_STORAGE_KEY, json);
      if (storage.getItem(CHECKOUT_STORAGE_KEY) !== json) throw new Error('storage');
    } catch {
      // Preserve the uncertain state in memory; do not issue another POST.
      memory = copy(next);
      preferMemory = true;
      throw new Error('주문 정보를 저장할 수 없습니다. 브라우저의 저장소 설정을 확인해 주세요.');
    }
    memory = copy(next);
    preferMemory = false;
    return next;
  };
  const clear = () => {
    revision += 1;
    try { storage.removeItem(CHECKOUT_STORAGE_KEY); } catch { throw new Error('저장된 주문을 정리할 수 없습니다.'); }
    memory = null;
    preferMemory = false;
  };
  const prepareInternal = async (cart) => {
    const body = buildOrderBody(cart);
    const fingerprint = cartFingerprint(cart);
    let saved = read();
    if (hasPendingTossReturn(saved) && saved.fingerprint !== fingerprint) throw uncertain();
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
  const savedTossOrder = ({ orderNumber, amount } = {}) => {
    const saved = read();
    if (!saved?.order || !['ready', 'confirming', 'paid'].includes(saved.phase)) throw uncertain();
    const order = normalizeOrder(saved.order);
    if (saved.fingerprint !== cartFingerprint(saved.cart) || saved.fingerprint !== cartFingerprint(order.items)) {
      throw new Error('저장된 장바구니와 주문 항목이 다릅니다. 주문 내역을 확인해 주세요.');
    }
    if (typeof orderNumber !== 'string' || orderNumber !== order.orderNumber
      || !Number.isSafeInteger(amount) || amount <= 0 || amount !== order.totalPrice) {
      throw new Error('결제 주문번호 또는 금액이 저장된 주문과 다릅니다.');
    }
    return { saved, order };
  };
  const validateTossConfirmation = (payload) => {
    const { saved, order } = savedTossOrder(payload);
    const paymentKey = payload?.paymentKey;
    if (typeof paymentKey !== 'string' || !paymentKey || /\s/.test(paymentKey)) {
      throw new Error('결제 인증 정보를 확인할 수 없습니다.');
    }
    const requested = saved.tossRequest;
    if (requested && (requested.pgProvider !== 'TOSS' || requested.orderNumber !== order.orderNumber
      || requested.amount !== order.totalPrice || !TOSS_METHODS.has(requested.method))) {
      throw new Error('저장된 결제 수단 또는 주문 정보가 올바르지 않습니다.');
    }
    if (saved.phase === 'confirming' && saved.confirmation?.provider === 'TOSS'
      && saved.confirmation.transactionId !== paymentKey) {
      throw new Error('처리 중인 결제 인증 정보와 다릅니다. 주문 내역을 확인해 주세요.');
    }
    const previousReturn = saved.tossReturn;
    if (previousReturn && (previousReturn.type !== 'success'
      || previousReturn.orderNumber !== order.orderNumber || previousReturn.amount !== order.totalPrice
      || typeof previousReturn.paymentKey !== 'string' || !previousReturn.paymentKey || /\s/.test(previousReturn.paymentKey))) {
      throw new Error('저장된 결제 인증 정보가 올바르지 않습니다. 주문 내역을 확인해 주세요.');
    }
    if (previousReturn && previousReturn.paymentKey !== paymentKey) {
      throw new Error('저장된 결제 인증 정보와 다릅니다. 주문 내역을 확인해 주세요.');
    }
    // Old checkout records have no selection marker; their documented default is CARD.
    const method = requested?.method ?? 'CARD';
    return { saved, order, paymentKey, method };
  };
  const confirmTossInternal = async (payload) => {
    const validated = validateTossConfirmation(payload);
    const { order, paymentKey, method } = validated;
    // Authentication survives a failed first GET and a subsequent page reload.
    // Persist it before any request; a storage failure must not start approval.
    const saved = save({
      ...validated.saved,
      tossReturn: { type: 'success', paymentKey, orderNumber: order.orderNumber, amount: order.totalPrice },
    });
    const observed = normalizeOrder(await api.getOrder(order.orderId));
    assertOrderMatchesCheckout(observed, saved);
    if (isPaidOrder(observed)) {
      save({ ...saved, order: observed, phase: 'paid' });
      return observed;
    }
    if (observed.status !== 'PENDING') {
      save({ ...saved, order: observed, phase: 'closed' });
      throw new Error('이 주문은 결제할 수 없는 상태입니다. 주문 내역을 확인해 주세요.');
    }
    if (saved.phase !== 'ready') throw uncertain();
    const confirming = {
      ...saved, phase: 'confirming',
      confirmation: { provider: 'TOSS', transactionId: paymentKey, method },
    };
    save(confirming);
    try {
      await api.confirmPayment({
        pgProvider: 'TOSS', pgTransactionId: paymentKey,
        orderId: order.orderId, amount: order.totalPrice, method,
      });
    } catch (failure) {
      let reconciled;
      try {
        reconciled = normalizeOrder(await api.getOrder(order.orderId));
        assertOrderMatchesCheckout(reconciled, saved);
      } catch { reconciled = null; }
      if (isPaidOrder(reconciled)) {
        save({ ...confirming, order: reconciled, phase: 'paid' });
        return reconciled;
      }
      if (reconciled?.status === 'PENDING' && definiteApprovalRejection(failure)) {
        // A definite rejection plus an unchanged server order allows a later explicit attempt.
        // Network, timeout, 409, 429 and 5xx errors retain the confirming marker.
        save({ ...confirming, phase: 'ready', confirmation: null });
      }
      throw failure;
    }
    const paid = normalizeOrder(await api.getOrder(order.orderId));
    assertOrderMatchesCheckout(paid, saved);
    if (!isPaidOrder(paid)) throw new Error('승인 요청 후 결제 완료 상태를 확인하지 못했습니다. 주문 내역을 확인해 주세요.');
    save({ ...confirming, order: paid, phase: 'paid' });
    return paid;
  };
  const readReceipt = async (orderId) => {
    const startedReadSeq = ++receiptReadSeq;
    const saved = copy(read());
    const startedRevision = revision;
    const snapshot = JSON.stringify(saved);
    const order = normalizeOrder(await api.getOrder(orderId));
    if (saved?.order?.orderId !== orderId) return order;
    assertOrderMatchesCheckout(order, saved);
    // Only the latest receipt lookup can reconcile state, even when that newer
    // lookup fails. Also preserve newer checkouts/approvals across managers.
    if (startedReadSeq !== receiptReadSeq || revision !== startedRevision
      || JSON.stringify(read()) !== snapshot) return order;
    const phase = isPaidOrder(order) ? 'paid'
      : ['CANCELLED', 'REFUNDED'].includes(order.status) ? 'closed' : null;
    if (phase) save({ ...saved, order, phase });
    return order;
  };
  return {
    getSaved: () => copy(read()),
    getPendingTossReturn: (candidate) => {
      const saved = read();
      if (!['ready', 'confirming'].includes(saved?.phase)) return null;
      let pendingReturn = saved.tossReturn;
      // Earlier versions saved the key immediately before approval, but not the
      // callback itself. Only that known TOSS confirmation shape is recoverable.
      if (pendingReturn == null && saved.phase === 'confirming'
        && saved.confirmation?.provider === 'TOSS' && TOSS_METHODS.has(saved.confirmation.method)) {
        pendingReturn = {
          type: 'success', paymentKey: saved.confirmation.transactionId,
          orderNumber: saved.order?.orderNumber, amount: saved.order?.totalPrice,
        };
      }
      pendingReturn ??= candidate;
      if (pendingReturn?.type !== 'success') return null;
      try {
        const { order, paymentKey } = validateTossConfirmation(pendingReturn);
        return { type: 'success', paymentKey, orderNumber: order.orderNumber, amount: order.totalPrice };
      } catch { return null; }
    },
    restoreCart: () => copy(read()?.cart || []),
    prepare: (cart) => exclusive(cart, 'prepare', () => prepareInternal(cart)),
    markTossRequested: (payload) => {
      if (running) throw new Error('이전 요청을 처리 중입니다.');
      const { saved, order } = savedTossOrder(payload);
      if (hasPendingTossReturn(saved)) throw uncertain();
      if (saved.phase !== 'ready' || order.status !== 'PENDING') throw uncertain();
      if (!TOSS_METHODS.has(payload?.method)) throw new Error('지원하는 결제 수단을 선택해 주세요.');
      const tossRequest = { pgProvider: 'TOSS', orderNumber: order.orderNumber, amount: order.totalPrice, method: payload.method };
      save({ ...saved, tossRequest });
      return copy(tossRequest);
    },
    confirmToss: (payload) => {
      let confirmation;
      try { confirmation = validateTossConfirmation(payload); } catch (failure) { return Promise.reject(failure); }
      const snapshot = {
        paymentKey: confirmation.paymentKey,
        orderNumber: confirmation.order.orderNumber,
        amount: confirmation.order.totalPrice,
      };
      return exclusive(confirmation.saved.cart, `toss:${confirmation.paymentKey}`, () => confirmTossInternal(snapshot));
    },
    payTest: (cart) => exclusive(cart, 'pay', async () => {
      if (hasPendingTossReturn(read())) throw uncertain();
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
    readReceipt,
    beginNewCheckout: () => {
      const saved = read();
      if (running || ['creating', 'confirming'].includes(saved?.phase) || hasPendingTossReturn(saved)) throw uncertain();
      clear();
    },
    clearPaid: () => { if (read()?.phase === 'paid') clear(); },
  };
}
