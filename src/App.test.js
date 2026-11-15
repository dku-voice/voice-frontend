import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';

// Render application JSX through the actual Vite pipeline; no browser or live APIs.
test('기존 메뉴와 결제 화면의 구조를 유지하고 렌더만으로 주문·결제를 요청하지 않는다', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.window = { location: { pathname: '/', search: '', origin: 'http://127.0.0.1:5173' } };
  globalThis.fetch = () => { calls += 1; throw new Error('실제 서버 요청 금지'); };
  try {
    for (const screen of ['menu', 'payment']) {
      const server = await createServer({
        server: { middlewareMode: true }, logLevel: 'silent',
        cacheDir: `/private/tmp/voice-ssr-${process.pid}-${screen}-cache`,
        plugins: [{
          name: 'initial-screen-test', enforce: 'pre',
          transform(code, id) {
            if (id.endsWith('/src/App.jsx')) return code.replace("useState('menu')", `useState('${screen}')`);
          },
        }],
      });
      try {
        const { default: App } = await server.ssrLoadModule('/src/App.jsx');
        const html = renderToString(React.createElement(App));
        assert(html.includes('음성 인식 키오스크'));
        if (screen === 'menu') {
          assert.equal((html.match(/class="item-card /g) || []).length, 7);
          assert(html.includes('연령 추정'));
          assert(!html.includes('5초 지연 테스트'));
        } else {
          for (const label of ['장바구니로 돌아가기', '결제 위젯 불러오기', 'SDK 결제 요청', '데모 결제 완료']) assert(html.includes(label));
          assert(html.includes('id="payment-widget"'));
          assert(html.includes('id="agreement-widget"'));
          assert(!html.includes('실제 과금 없음'));
        }
      } finally { await server.close(); }
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
