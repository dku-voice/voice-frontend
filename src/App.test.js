import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';

// Render application JSX through the actual Vite pipeline; no browser or live APIs.
test('기존 메뉴와 결제 영역을 유지하고 최종 결제 버튼 하나를 렌더하며 SSR에서 주문·결제를 요청하지 않는다', async () => {
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
          assert.equal((html.match(/class="item-card /g) || []).length, 0);
          assert(html.includes('메뉴를 불러오는 중입니다.'));
          assert(!html.includes('클래식 버거'));
          assert(!html.includes('5,900원'));
          assert(html.includes('연령 추정'));
          assert(html.includes('class="auto-age-card"'));
          assert(!html.includes('카메라 미리보기'));
          assert(html.includes('주문 시작 시 한 번 촬영해 분석합니다.'));
          assert(html.includes('카메라 분석 결과는 추정값이며 실제 나이와 다를 수 있습니다.'));
          assert(!html.includes('5초 지연 테스트'));
          assert(!html.includes('>추천</button>'));
        } else {
          assert(html.includes('장바구니로 돌아가기'));
          assert.equal((html.match(/>결제하기<\/button>/g) || []).length, 1);
          for (const label of ['결제 위젯 불러오기', 'SDK 결제 요청', '데모 결제 완료']) assert(!html.includes(label));
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
