import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import { ApiError } from '../src/api/client.js';
import { createCheckoutManager } from '../src/domain/checkout.js';
import { groupMenus, normalizeMenus } from '../src/domain/kiosk.js';
import { describePaymentError } from '../src/integration/payment-error.js';

const paymentKey = 'private-ssr-authentication-fixture';
const order = { orderId: 731, orderNumber: 'ORD-RECOVERY-731', status: 'PENDING', totalPrice: 2100,
  items: [{ menuId: 14, menuNameKo: '콜라', quantity: 1, unitPrice: 2100, subtotal: 2100, options: [] }] };
const cart = [{ menuId: 14, id: 14, lineId: '14:', name: '콜라', quantity: 1, optionIds: [], price: 2100 }];
const callback = { paymentKey, orderNumber: order.orderNumber, amount: order.totalPrice };
const makeStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};

async function failedAuthentication(stage) {
  const storage = makeStorage();
  const calls = [];
  const api = {
    createOrder: async (body) => { calls.push(['create', body]); return structuredClone(order); },
    getOrder: async (id) => {
      calls.push(['get', id]);
      if (stage === 'lookup') throw new ApiError(`서버 오류가 발생했습니다. ${paymentKey}`, {
        code: 'HTTP_ERROR', status: 500, requestPath: `/api/orders/${id}`, requestMethod: 'GET',
      });
      return structuredClone(order);
    },
    confirmPayment: async (body) => {
      calls.push(['confirm', body]);
      throw new ApiError('승인 응답 시간이 초과되었습니다.', {
        code: 'TIMEOUT', requestPath: '/api/payments/confirm', requestMethod: 'POST',
      });
    },
  };
  const manager = createCheckoutManager({ api, storage, uuid: () => 'local-ssr-transaction' });
  await manager.prepare(cart);
  manager.markTossRequested({ ...callback, method: 'CARD' });
  let failure;
  try { await manager.confirmToss(callback); } catch (error) { failure = error; }
  assert(failure);
  assert.deepEqual(manager.getPendingTossReturn(), { type: 'success', ...callback });
  assert.equal(manager.getSaved().phase, stage === 'lookup' ? 'ready' : 'confirming');
  return { storage, calls, manager, api, details: describePaymentError(failure, { afterAuthentication: true, paymentKey }) };
}

async function renderSavedScreen({ storage, details, screen = 'payment', serverMenus = false }) {
  const previous = Object.fromEntries(['window', 'fetch', 'sessionStorage'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let networkCalls = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true,
    value: { location: { pathname: '/', search: '', origin: 'http://127.0.0.1:5173', hostname: '127.0.0.1' } } });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: storage });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
    value: () => { networkCalls += 1; throw new Error('SSR에서 외부 API를 요청하면 안 됩니다.'); } });
  let server;
  try {
    server = await createServer({
      server: { middlewareMode: true }, logLevel: 'silent',
      cacheDir: `/private/tmp/voice-recovery-screen-${process.pid}-${screen}-cache`,
      plugins: [{ name: 'stored-payment-recovery-screen', enforce: 'pre', transform(code, id) {
        if (!id.endsWith('/src/App.jsx')) return;
        let transformed = code.replace("useState('menu')", `useState('${screen}')`)
          .replace("const [paymentError, setPaymentError] = useState('');", `const [paymentError, setPaymentError] = useState(${JSON.stringify(details)});`)
          .replace("const [paymentStatus, setPaymentStatus] = useState('결제 수단을 준비하고 있습니다.');",
            `const [paymentStatus, setPaymentStatus] = useState(${JSON.stringify(details.title)});`);
        if (serverMenus) {
          const categories = groupMenus(normalizeMenus([{ menuId: 1, nameKo: '버거', price: 5900,
            status: 'ACTIVE', categoryNameKo: '버거', options: [] }]));
          transformed = transformed.replace('useState(fallbackMenuCatalog)', `useState(${JSON.stringify(categories)})`)
            .replace("useState('sample')", "useState('server')")
            .replace('useState(fallbackMenuCatalog[0].id)', "useState('버거')");
        }
        return transformed;
      } }],
    });
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const html = renderToString(React.createElement(App));
    assert.equal(networkCalls, 0, '렌더만으로 조회나 승인을 자동 실행하면 안 됩니다.');
    assert(!html.includes(paymentKey), '보관된 결제 인증 키는 HTML에 노출하면 안 됩니다.');
    return { html, text: html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '') };
  } finally {
    try { await server?.close(); }
    finally {
      for (const [name, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  }
}

test('첫 주문 조회 500 후 새로 연 화면은 보관된 인증을 계속할 버튼 하나와 주문·실패 단계를 표시한다', async () => {
  const state = await failedAuthentication('lookup');
  const before = structuredClone(state.calls);
  const { html, text } = await renderSavedScreen(state);
  assert.equal((html.match(/>결제 계속하기<\/button>/g) || []).length, 1);
  for (const label of ['결제 위젯 불러오기', 'SDK 결제 요청', '데모 결제 완료', '결제가 완료되었습니다.']) assert(!html.includes(label));
  assert(text.includes('주문번호 ORD-RECOVERY-731'));
  assert(text.includes('주문 ID 731'));
  assert(text.includes('주문 상태 조회 · HTTP 500'));
  assert(text.includes('GET /api/orders/731'));
  assert(text.includes('[결제 인증정보]'));
  assert.deepEqual(state.calls, before);
});

test('승인 응답 유실 후 새로 연 화면은 재결제 대신 결제 상태 확인 버튼을 제공한다', async () => {
  const state = await failedAuthentication('approval');
  const before = structuredClone(state.calls);
  const { html, text } = await renderSavedScreen(state);
  assert.equal((html.match(/>결제 상태 확인<\/button>/g) || []).length, 1);
  assert(!html.includes('>결제 계속하기</button>'));
  assert(!html.includes('SDK 결제 요청'));
  assert(!text.includes('HTTP 500'));
  assert(text.includes('POST /api/payments/confirm'));
  assert.deepEqual(state.calls, before);
});

test('인증 결과가 남아도 새 장바구니 수량·삭제를 편집하고 이전 결제 결과를 별도로 확인할 수 있다', async () => {
  const state = await failedAuthentication('lookup');
  const { html, text } = await renderSavedScreen({ ...state, screen: 'cart' });
  const controls = html.match(/<div class="quantity-controls">([\s\S]*?)<\/div>/)?.[1];
  assert(controls);
  assert.equal((controls.match(/<button/g) || []).length, 3);
  assert(!controls.includes('disabled'));
  assert(text.includes('메뉴는 담거나 수정할 수 있습니다.'));
  assert(text.includes('이전 결제 결과를 먼저 확인'));
  assert.equal((html.match(/>결제 결과 확인<\/button>/g) || []).length, 1);
});

test('주문 GET 500으로 인증 결과가 남아도 정상 서버 메뉴의 담기 버튼은 활성화된다', async () => {
  const state = await failedAuthentication('lookup');
  const { html, text } = await renderSavedScreen({ ...state, screen: 'menu', serverMenus: true });
  const addButton = html.match(/<button[^>]*>담기<\/button>/)?.[0];
  assert(addButton);
  assert(!addButton.includes('disabled'));
  assert(text.includes('버거'));
  assert(!text.includes('예시 메뉴입니다.'));
});

test('조회로 결제 완료·환불 종료가 확정되면 복구 버튼은 사라지고 정상 메뉴를 계속 담을 수 있다', async () => {
  for (const status of ['PAID', 'REFUNDED']) {
    const state = await failedAuthentication('lookup');
    state.api.getOrder = async (id) => {
      state.calls.push(['get', id]);
      return { ...structuredClone(order), status };
    };
    await state.manager.readReceipt(order.orderId);
    assert.equal(state.manager.getPendingTossReturn(), null);
    assert.equal(state.manager.getSaved().phase, status === 'PAID' ? 'paid' : 'closed');
    const before = structuredClone(state.calls);
    const payment = await renderSavedScreen(state);
    assert(!payment.html.includes('결제 계속하기'));
    assert(!payment.html.includes('결제 상태 확인'));
    const menu = await renderSavedScreen({ ...state, screen: 'menu', serverMenus: true });
    const addButton = menu.html.match(/<button[^>]*>담기<\/button>/)?.[0];
    assert(addButton);
    assert(!addButton.includes('disabled'));
    assert.deepEqual(state.calls, before);
  }
});

test('구조화된 결제 오류 이후 KDS로 이동해도 오류 객체를 React 자식으로 렌더하지 않는다', async () => {
  const state = await failedAuthentication('lookup');
  const { text } = await renderSavedScreen({ ...state, screen: 'kds' });
  assert(text.includes('KDS 주문 현황'));
  assert(text.includes('서버 오류가 발생했습니다. [결제 인증정보]'));
  assert(!text.includes('결제가 완료되었습니다.'));
});
