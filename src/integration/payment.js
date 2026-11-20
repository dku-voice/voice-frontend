const orderNumberPattern = /^[A-Za-z0-9_=-]{6,64}$/;
const aborted = () => Object.assign(new Error('결제 화면 준비가 취소되었습니다.'), { name: 'AbortError' });

export function assertTestWidgetKey(key) {
  if (typeof key !== 'string' || !/^test_gck_[A-Za-z0-9_]+$/.test(key)) {
    throw new Error('결제위젯용 테스트 클라이언트 키를 확인해 주세요.');
  }
}

export function readPaymentReturn(location) {
  if (!location || !['/payment/success', '/payment/fail'].includes(location.pathname)) return null;
  const parameters = new URLSearchParams(location.search);
  const invalid = () => ({ type: 'invalid', message: '결제 결과 정보가 올바르지 않습니다. 주문 내역을 확인해 주세요.' });
  if (location.pathname === '/payment/fail') {
    return { type: 'fail', message: '결제가 취소되었거나 인증에 실패했습니다. 장바구니를 확인한 뒤 다시 시도해 주세요.' };
  }
  if (['paymentKey', 'orderId', 'amount'].some((name) => parameters.getAll(name).length !== 1)) return invalid();
  const paymentKey = parameters.get('paymentKey');
  const orderNumber = parameters.get('orderId');
  const rawAmount = parameters.get('amount');
  const amount = Number(rawAmount);
  if (!paymentKey || /\s/.test(paymentKey) || !orderNumberPattern.test(orderNumber)
    || !/^[0-9]+$/.test(rawAmount) || !Number.isSafeInteger(amount) || amount <= 0) return invalid();
  const paymentType = parameters.get('paymentType');
  if (paymentType && paymentType !== 'NORMAL') return invalid();
  return { type: 'success', paymentKey, orderNumber, amount };
}

export function getTossPaymentMethod(selection) {
  if (selection?.type && selection.type !== 'NORMAL') throw new Error('이 결제 방식은 아직 지원하지 않습니다. 일반 결제수단을 선택해 주세요.');
  const provider = selection?.easyPay?.provider?.replace(/[\s_-]/g, '').toUpperCase();
  if (provider === 'KAKAOPAY' || provider === '카카오페이') return 'KAKAO_PAY';
  if (provider === 'NAVERPAY' || provider === '네이버페이') return 'NAVER_PAY';
  if (provider === 'TOSSPAY' || provider === '토스페이') return 'TOSS';
  if (provider === 'APPLEPAY' || provider === '애플페이') return 'CARD';
  if (!provider && ['카드', 'CARD'].includes(selection?.method)) return 'CARD';
  throw new Error('이 결제수단은 아직 주문 서버와 연결되지 않았습니다. 신용·체크카드 또는 지원되는 간편결제를 선택해 주세요.');
}

// SDK v1 emits `ready` after rendering its iframe. Loading the SDK alone is not readiness.
// Dependencies are injected so the full request contract can be checked without a live PG.
export async function prepareTossWidget({ key, order, loadWidget, signal, timeoutMs = 20000,
  methodsSelector = '#payment-widget', agreementSelector = '#agreement-widget' }) {
  assertTestWidgetKey(key);
  if (!orderNumberPattern.test(order?.orderNumber) || !Number.isSafeInteger(order.totalPrice) || order.totalPrice <= 0) {
    throw new Error('서버에서 결제 주문번호와 금액을 확인할 수 없습니다.');
  }
  let loading = true;
  let disposed = false;
  let requesting = false;
  let timer;
  let onAbort;
  const check = () => { if (!loading || signal?.aborted) throw aborted(); };
  const interrupted = new Promise((_resolve, reject) => {
    onAbort = () => reject(aborted());
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(new Error('결제 수단을 불러오는 시간이 초과되었습니다. 다시 시도해 주세요.')), timeoutMs);
  });
  try {
    check();
    return await Promise.race([interrupted, (async () => {
      const widget = await loadWidget(key, `voice-kiosk-${globalThis.crypto.randomUUID()}`);
      check();
      const methods = widget.renderPaymentMethods(methodsSelector, order.totalPrice);
      const agreement = widget.renderAgreement(agreementSelector);
      await new Promise((resolve) => methods.on('ready', resolve));
      check();
      return {
        dispose: () => { disposed = true; },
        request({ origin, onRequest }) {
          if (disposed || signal?.aborted) throw aborted();
          if (requesting) throw new Error('이미 결제를 요청하고 있습니다.');
          if (!agreement.getAgreementStatus().agreedRequiredTerms) throw new Error('필수 결제 약관에 동의해 주세요.');
          const method = getTossPaymentMethod(methods.getSelectedPaymentMethod());
          const url = new URL(origin);
          if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('결제 결과 주소를 확인해 주세요.');
          requesting = true;
          try {
            onRequest({ orderNumber: order.orderNumber, amount: order.totalPrice, method });
            return Promise.resolve(widget.requestPayment({
              orderId: order.orderNumber,
              orderName: `${order.items?.[0]?.menuNameKo || '키오스크 주문'}${order.items?.length > 1 ? ` 외 ${order.items.length - 1}건` : ''}`.slice(0, 100),
              successUrl: `${origin}/payment/success`, failUrl: `${origin}/payment/fail`,
            })).catch((failure) => { requesting = false; throw failure; });
          } catch (failure) { requesting = false; throw failure; }
        },
      };
    })()]);
  } finally {
    loading = false;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
