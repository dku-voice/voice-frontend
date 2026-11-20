import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import { normalizeMenus, groupMenus, createCartItem } from '../src/domain/kiosk.js';

// Public GET /api/menus snapshot, 2026-11-19 KST. Only tests read this file.
const raw = JSON.parse(await readFile(new URL('./fixtures/menus-2026-11-19.json', import.meta.url)));
let renderId = 0;
async function renderScreen({ menus = raw, screen = 'menu', source = 'server', category = '버거', error = '', age = null, recommendations } = {}) {
  const catalog = normalizeMenus(menus);
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { calls += 1; throw new Error('화면 검증에서 실제 요청 금지'); };
  const replaceState = (code, name, setter, initial) => code.replace(
    new RegExp(`const \\[${name}, ${setter}\\] = useState\\([^;]*\\);`),
    `const [${name}, ${setter}] = useState(${JSON.stringify(initial)});`,
  );
  const server = await createServer({
    server: { middlewareMode: true }, logLevel: 'silent',
    cacheDir: `/private/tmp/menu-screen-${process.pid}-${renderId++}`,
    plugins: [{ name: 'menu-screen-state', enforce: 'pre', transform(code, id) {
      if (!id.endsWith('/src/App.jsx')) return;
      for (const [name, setter, value] of [
        ['menuCatalog', 'setMenuCatalog', groupMenus(catalog)],
        ['selectedCategory', 'setSelectedCategory', category],
        ['menuSource', 'setMenuSource', source], ['menuLoading', 'setMenuLoading', false],
        ['menuError', 'setMenuError', error], ['currentScreen', 'setCurrentScreen', screen],
        ['ageEstimate', 'setAgeEstimate', age],
        ['recommendations', 'setRecommendations', recommendations ?? catalog],
      ]) code = replaceState(code, name, setter, value);
      return code;
    } }],
  });
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const html = renderToString(React.createElement(App));
    assert.equal(calls, 0);
    return html.replace(/<!--[\s\S]*?-->/g, '');
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
}

test('실제 응답의 17개 메뉴 이름·가격·이미지·분류·옵션을 그대로 표시하고 주문 데이터 값을 유지한다', async () => {
  const original = structuredClone(raw);
  const menus = normalizeMenus(raw);
  const groups = groupMenus(menus);
  assert.deepEqual(groups.map((g) => [g.name, g.items.length]), [['버거', 8], ['사이드', 5], ['음료', 4]]);
  for (const group of groups) {
    const html = await renderScreen({ category: group.name });
    assert.equal((html.match(/class="item-card /g) || []).length, group.items.length);
    for (const menu of group.items) {
      const received = raw.find((m) => m.menuId === menu.menuId);
      assert(html.includes(`<h3>${received.nameKo}</h3>`));
      assert(html.includes(`${received.price.toLocaleString('ko-KR')}원`));
      assert(html.includes(`src="${received.imageUrl}"`));
      for (const option of menu.options) assert(html.includes(option.nameKo));
      assert.equal(menu.options.length, new Set(received.options.map((o) => o.optionId)).size);
      const options = menu.menuId === 9 ? [121] : [];
      assert.equal(createCartItem(menu, options).price, received.price);
    }
  }
  assert.deepEqual(raw, original);
});

test('품절은 가격과 품절 표시를 유지하며 담기를 막고 비활성 메뉴는 표시하지 않는다', async () => {
  const menus = structuredClone(raw.slice(0, 2));
  menus[0].status = 'SOLD_OUT';
  menus[1].status = 'INACTIVE';
  const html = await renderScreen({ menus });
  assert(html.includes('<h3>데리버거</h3>'));
  assert(html.includes('2,800원 · 품절'));
  assert.match(html, /<button[^>]*disabled=""[^>]*>담기<\/button>/);
  assert(!html.includes('<h3>리아 새우버거</h3>'));
});

test('서버가 비어 있거나 조회가 실패하면 임시 메뉴를 만들지 않고 이전 데이터도 주문을 차단한다', async () => {
  const empty = await renderScreen({ menus: [] });
  assert(empty.includes('현재 표시할 판매 메뉴가 없습니다.'));
  assert(!empty.includes('item-card'));
  const failed = await renderScreen({ source: 'error', error: '메뉴 서버: 조회 실패' });
  assert(failed.includes('마지막으로 불러온 정보입니다.'));
  assert.equal((failed.match(/<button[^>]*disabled=""[^>]*>담기<\/button>/g) || []).length, 8);
  const firstFailure = await renderScreen({ menus: [], source: 'error', error: '메뉴 서버: 조회 실패' });
  assert(!firstFailure.includes('클래식 버거'));
  assert(!firstFailure.includes('현재 표시할 판매 메뉴가 없습니다.'));
});

test('추천 화면은 현재 서버의 판매 정보만 사용하며 알고리즘·신뢰도를 꾸며 표시하지 않는다', async () => {
  const html = await renderScreen({ screen: 'recommendations', recommendations: [{ menuId: 1, name: '옛 임시 메뉴', price: 1, confidence: 0.82 }] });
  assert(html.includes('<h3>데리버거</h3>'));
  assert(html.includes('2,800원'));
  assert(!html.includes('옛 임시 메뉴'));
  assert(!html.includes('FP-Growth'));
  assert(!html.includes('신뢰도'));
  const failed = await renderScreen({ screen: 'recommendations', source: 'error' });
  assert(!failed.includes('recommendation-card'));
});

test('연령 결과는 수신 전 대기 안내를 표시하고 실제 수신 값에만 나이를 표시한다', async () => {
  const waiting = await renderScreen({ screen: 'ageResult' });
  assert(waiting.includes('결과 대기'));
  assert(waiting.includes('카메라를 켠 뒤 촬영 후 분석을 눌러 주세요.'));
  assert(!waiting.includes('예시 결과'));
  const received = await renderScreen({ screen: 'ageResult', age: 32 });
  assert(received.includes('32세'));
  assert(received.includes('서버에서 수신한 연령 추정 결과'));
  assert(!received.includes('연령대에 맞춘'));
});

test('이미지 주소가 없으면 다른 상품 사진을 만들지 않고 이미지 없음으로 표시한다', async () => {
  const menus = structuredClone(raw.slice(0, 1));
  menus[0].imageUrl = '';
  const html = await renderScreen({ menus });
  assert(html.includes('데리버거 이미지 없음'));
  assert(!html.includes('<img'));
});
