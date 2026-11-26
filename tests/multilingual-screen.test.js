import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import { groupMenus, normalizeMenus, createCartItem } from '../src/domain/kiosk.js';
import { translate } from '../src/i18n/index.js';

const menus = normalizeMenus(JSON.parse(await readFile(new URL('./fixtures/menus-2026-11-19.json', import.meta.url))));
const cart = [createCartItem(menus[0], [1], 2)];
const receipt = { orderId: 123, orderNumber: 'ORD-LOCAL-I18N', status: 'PAID', totalPrice: 6600,
  items: [{ menuId: 1, menuNameKo: '데리버거', quantity: 2, unitPrice: 3300, subtotal: 6600, options: [{ optionId: 1, nameKo: '치즈 추가' }] }] };

test('5개 언어로 전체 화면·메뉴·옵션·장바구니·영수증·오류·KDS·관리자를 렌더하고 읽기만으로도 네트워크 요청을 하지 않는다', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('SSR에서 실제 요청 금지'); };
  try {
    for (const language of ['ko', 'ja', 'es', 'th']) {
      for (const scenario of ['menu', 'cart', 'recommendations', 'payment', 'ageResult', 'kds', 'admin', 'kds-login', 'admin-login']) {
        const screen = scenario.replace('-login', '');
        const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent',
          cacheDir: `/private/tmp/voice-i18n-${process.pid}-${language}-${scenario}`,
          plugins: [{ name: 'i18n-screen-state', enforce: 'pre', transform(code, id) {
            if (!id.endsWith('/src/App.jsx')) return;
            for (const [name, setter, value] of [
              ['language', 'setLanguage', language], ['currentScreen', 'setCurrentScreen', screen],
              ['menuCatalog', 'setMenuCatalog', groupMenus(menus)], ['adminMenuItems', 'setAdminMenuItems', menus],
              ['menuLoading', 'setMenuLoading', false], ['menuSource', 'setMenuSource', 'server'], ['selectedCategory', 'setSelectedCategory', '버거'],
              ['optionSelections', 'setOptionSelections', { 1: [1] }],
              ['cart', 'setCart', cart], ['recommendations', 'setRecommendations', menus.slice(1, 4)], ['receipt', 'setReceipt', receipt],
              ['receiptError', 'setReceiptError', '서버 오류가 발생했습니다.'], ['ageEstimate', 'setAgeEstimate', 32],
              ['session', 'setSession', scenario.endsWith('-login') ? null : { accessToken: 'test-only-staff-token', role: 'ADMIN', expiresAt: 9999999999999 }],
              ['adminLogs', 'setAdminLogs', [{ id: 1, createdAt: '2026-11-19T10:00:00+09:00', event: '메뉴 상태 변경', user: 'admin', detail: '1 → ACTIVE' }]],
              ['paymentOrder', 'setPaymentOrder', receipt],
              ['paymentError', 'setPaymentError', { message: '서버 오류가 발생했습니다.', stage: '주문 상태 조회', status: 500, requestMethod: 'GET', requestPath: '/api/orders/123' }],
              ['kdsOrders', 'setKdsOrders', [{ ...receipt, id: 123, number: receipt.orderNumber, qty: 2, orderedAt: '2026-11-19T10:00:00+09:00', items: [{ menuNameKo: '데리버거', quantity: 2, optionNames: ['치즈 추가'] }] }]],
              ['adminData', 'setAdminData', { orders: [receipt], payments: [{ paymentId: 1, orderId: 123, amount: 6600, method: 'CARD', pgProvider: 'TOSS' }], popular: [['데리버거', 2]], sales: { totalSales: 6600, totalOrders: 1, averageOrder: 6600 } }],
            ]) code = code.replace(new RegExp(`const \\[${name}, ${setter}\\] = useState\\([^;]*\\);`), `const [${name}, ${setter}] = useState(${JSON.stringify(value)});`);
            return code;
          } }],
        });
        try {
          const { default: App } = await server.ssrLoadModule('/src/App.jsx');
          const { default: Selector } = await server.ssrLoadModule('/src/i18n/LanguageSelector.jsx');
          let chosen = language;
          const selector = Selector({ language, onChange: (value) => { chosen = value; } });
          assert.equal(selector.props.children.length, 5);
          for (const button of selector.props.children) {
            button.props.onClick();
            assert.equal(chosen, button.props.lang, 'each real button handler must select its own language');
          }
          const html = renderToString(React.createElement(App)).replace(/<!--[\s\S]*?-->/g, '');
          assert(html.includes(`<div lang="${language}" class="App`));
          assert(html.includes(translate('음성 인식 키오스크', language)));
          assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
          for (const label of ['한국어', '日本語', 'Español', 'ไทย']) assert(html.includes(`>${label}</button>`));
          if (screen === 'menu') {
            assert(html.includes(translate('데리버거', language)));
            assert(html.includes(translate('치즈 추가', language)));
            assert.equal((html.match(/type="checkbox" checked=""/g) || []).length, 1);
          }
          if (screen === 'payment') {
            assert(html.includes('id="payment-widget"')); assert(html.includes('id="agreement-widget"'));
            assert(html.includes(translate('서버 오류가 발생했습니다.', language)));
            assert(html.includes('GET /api/orders/123'));
          }
          if (language !== 'ko') {
            const text = html.replace(/<button[^>]*lang="ko"[^>]*>한국어<\/button>/g, '').replace(/<[^>]*>/g, '');
            assert(!/[가-힣]/.test(text), `${language}/${screen}: untranslated text: ${text.match(/[^.!?]*[가-힣][^.!?]*/g)}`);
          }
          assert(!html.includes('test-only-staff-token'));
        } finally { await server.close(); }
      }
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
