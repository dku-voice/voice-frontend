export function describePaymentError(error, { afterAuthentication = false, paymentKey = '' } = {}) {
  const requestPath = typeof error?.requestPath === 'string' ? error.requestPath.split(/[?#]/, 1)[0] : '';
  const requestMethod = typeof error?.requestMethod === 'string' ? error.requestMethod : '';
  let stage = afterAuthentication ? '결제 결과 확인' : '결제 준비';
  let title = afterAuthentication ? '결제 완료 여부를 확인하지 못했습니다.' : '결제를 준비하지 못했습니다.';
  if (/^\/api\/orders\/\d+$/.test(requestPath) && requestMethod === 'GET') {
    stage = '주문 상태 조회';
    title = '주문 상태를 확인하지 못했습니다.';
  } else if (requestPath === '/api/orders' && requestMethod === 'POST') {
    stage = '주문 생성';
    title = '주문을 생성하지 못했습니다. 장바구니는 유지됩니다.';
  } else if (requestPath === '/api/payments/confirm') {
    stage = '결제 승인';
    title = '결제 승인 결과를 확인하지 못했습니다.';
  }
  let message = typeof error?.message === 'string' ? error.message : '처리 결과를 확인할 수 없습니다.';
  if (paymentKey) message = message.split(paymentKey).join('[결제 인증정보]');
  return { title, stage, message, requestPath, requestMethod,
    status: Number.isInteger(error?.status) ? error.status : null };
}
