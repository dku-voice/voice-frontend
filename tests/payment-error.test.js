import test from 'node:test';
import assert from 'node:assert/strict';
import { describePaymentError } from '../src/integration/payment-error.js';

test('인증 후 주문 GET 실패를 결제 승인 실패와 구분하고 HTTP 진단 정보만 보존한다', () => {
  const failure = describePaymentError({ message: '서버 오류가 발생했습니다.', status: 500,
    requestPath: '/api/orders/31', requestMethod: 'GET' }, { afterAuthentication: true });
  assert.equal(failure.stage, '주문 상태 조회');
  assert.equal(failure.title, '주문 상태를 확인하지 못했습니다.');
  assert.equal(failure.status, 500);
  assert.equal(failure.requestPath, '/api/orders/31');
  const approval = describePaymentError({ message: '승인 오류', status: 500,
    requestPath: '/api/payments/confirm', requestMethod: 'POST' }, { afterAuthentication: true });
  assert.equal(approval.stage, '결제 승인');
  assert.equal(approval.title, '결제 승인 결과를 확인하지 못했습니다.');
});

test('주문 생성 실패는 장바구니 유지로 안내하고 네트워크 실패를 HTTP 500으로 단정하지 않는다', () => {
  const creation = describePaymentError({ message: '품절', status: 400, requestPath: '/api/orders', requestMethod: 'POST' });
  assert.equal(creation.stage, '주문 생성');
  assert(creation.title.includes('장바구니는 유지'));
  const network = describePaymentError(new Error('네트워크 오류'), { afterAuthentication: true });
  assert.equal(network.status, null);
  assert.equal(network.stage, '결제 결과 확인');
  assert(!network.title.includes('실패한 결제'));
});

test('진단 화면에서 결제 키·쿼리·오류 객체의 본문과 토큰을 노출하지 않는다', () => {
  const key = 'private-fixture-payment-key';
  const failure = describePaymentError({ message: `확인 불가 ${key}`, requestPath: `/api/orders/31?paymentKey=${key}#private`,
    requestMethod: 'GET', token: 'private-token', body: { password: 'private-password' } }, { paymentKey: key });
  const output = JSON.stringify(failure);
  for (const secret of [key, 'private-token', 'private-password']) assert(!output.includes(secret));
  assert.equal(failure.requestPath, '/api/orders/31');
  assert(failure.message.includes('[결제 인증정보]'));
});
