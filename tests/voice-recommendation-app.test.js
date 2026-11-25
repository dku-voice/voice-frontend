import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import { groupMenus, normalizeMenus } from '../src/domain/kiosk.js';

const menus = groupMenus(normalizeMenus([
  { menuId: 2, nameKo: '리아 새우버거', price: 4800, status: 'ACTIVE', categoryNameKo: '버거', options: [] },
  { menuId: 14, nameKo: '콜라', price: 2100, status: 'ACTIVE', categoryNameKo: '음료', options: [] },
  { menuId: 17, nameKo: '아이스아메리카노', price: 2500, status: 'SOLD_OUT', categoryNameKo: '음료', options: [] },
]));

async function setup({ initialRecommendation = null } = {}) {
  const keys = ['window', 'WebSocket', 'fetch', 'localStorage', '__voiceRecommendationTest'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const install = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const sockets = [];
  const trace = { cart: [], screens: [], recommendation: initialRecommendation, errors: [], bridge: null };
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 1; sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; }
  }
  install('window', { location: { origin: 'http://localhost:5173', pathname: '/', search: '' }, speechSynthesis: { cancel() {} } });
  install('WebSocket', Socket);
  install('localStorage', { getItem: () => null, setItem() {} });
  install('fetch', () => assert.fail('live API is forbidden'));
  install('__voiceRecommendationTest', trace);
  const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent',
    cacheDir: `/private/tmp/voice-recommendation-app-${process.pid}`,
    plugins: [{ name: 'voice-recommendation-bridge', enforce: 'pre', transform(code, id) {
      if (!id.endsWith('/src/App.jsx')) return;
      return code.replace('const AI_WS_URL = runtimeConfig.aiWsUrl;', "const AI_WS_URL = 'ws://ai.invalid/ws/audio';")
        .replace('const [ttsEnabled, setTtsEnabled] = useState(true);', 'const [ttsEnabled, setTtsEnabled] = useState(false);')
        .replace('const [menuCatalog, setMenuCatalog] = useState([]);', `const [menuCatalog, setMenuCatalog] = useState(${JSON.stringify(menus)});`)
        .replace("const [menuSource, setMenuSource] = useState('loading');", "const [menuSource, setMenuSource] = useState('server');")
        .replace(/const \[cart, setCart\] = (useState\([^;]*\));/, `const [cart, setCartState] = $1;
          const setCart = (update) => { const state = globalThis.__voiceRecommendationTest;
            state.cart = typeof update === 'function' ? update(state.cart) : update; setCartState(update); };`)
        .replace("const [currentScreen, setCurrentScreen] = useState('menu');", `const [currentScreen, setCurrentScreenState] = useState(globalThis.__voiceRecommendationTest.recommendation ? 'recommendations' : 'menu');
          const setCurrentScreen = (next) => { globalThis.__voiceRecommendationTest.screens.push(next); setCurrentScreenState(next); };`)
        .replace('const [voiceRecommendation, setVoiceRecommendation] = useState(null);', `const [voiceRecommendation, setVoiceRecommendationState] = useState(globalThis.__voiceRecommendationTest.recommendation);
          const setVoiceRecommendation = (next) => { globalThis.__voiceRecommendationTest.recommendation = next; setVoiceRecommendationState(next); };`)
        .replace("const [error, setError] = useState('');", `const [error, setErrorState] = useState('');
          const setError = (next) => { if (next) globalThis.__voiceRecommendationTest.errors.push(next); setErrorState(next); };`)
        .replace('  aiMessageHandlerRef.current = handleAiMessage;', `
          globalThis.__voiceRecommendationTest.bridge = { connectWebSocket, sendAudioToServer, voiceLanguageGuardRef,
            voiceSessionRef, appMountedRef, handleAiMessage };
          aiMessageHandlerRef.current = handleAiMessage;`);
    } }],
  });
  const { default: App } = await server.ssrLoadModule('/src/App.jsx');
  const html = renderToString(React.createElement(App));
  const close = async () => {
    await server.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  };
  return { trace, html, sockets, close };
}

test('음성 추천 응답은 장바구니를 건드리지 않고 이유와 함께 추천 화면으로 이동한다', async () => {
  const state = await setup();
  try {
    const app = state.trace.bridge; app.appMountedRef.current = true; app.connectWebSocket();
    app.voiceLanguageGuardRef.current.startSession(); app.voiceSessionRef.current = true;
    await app.sendAudioToServer(new Int16Array(128).fill(3000).buffer);
    state.sockets[0].onmessage({ data: JSON.stringify({ type: 'recommendation', recognized_text: '산뜻한 거 추천해줘',
      language: 'ko', source: 'llm', items: [
        { menu_id: '2', name: '리아 새우버거', reason: '산뜻함 특징이 있습니다.' },
        { menu_id: '999', name: '없는 메뉴', reason: '무시' },
      ] }) });
    assert.deepEqual(state.trace.cart, []);
    assert.equal(state.trace.screens.at(-1), 'recommendations');
    assert.equal(state.trace.recommendation.query, '산뜻한 거 추천해줘');
    assert.deepEqual(state.trace.recommendation.items.map(({ menu, reason }) => [menu.menuId, reason]),
      [[2, '산뜻함 특징이 있습니다.']]);
    assert.equal(app.voiceSessionRef.current, false);
  } finally { await state.close(); }
});

test('추천 결과가 모두 현재 메뉴에 없으면 화면을 바꾸지 않고 안내한다', async () => {
  const state = await setup();
  try {
    const app = state.trace.bridge;
    app.handleAiMessage(JSON.stringify({ type: 'recommendation', recognized_text: '추천해줘', language: 'ko',
      source: 'fallback', items: [{ menu_id: '999', name: '없는 메뉴', reason: 'x' }] }));
    assert.deepEqual(state.trace.screens, []);
    assert.equal(state.trace.recommendation, null);
    assert(state.trace.errors.at(-1).includes('추천할 메뉴를 찾지 못했습니다'));
  } finally { await state.close(); }
});

test('인식 문장이 없는 기존 추천 메시지는 화면을 이동하지 않는다', async () => {
  const state = await setup();
  try {
    state.trace.bridge.handleAiMessage(JSON.stringify({ type: 'recommendation', items: [{ menuId: 14 }] }));
    assert.deepEqual(state.trace.screens, []);
    assert.equal(state.trace.recommendation, null);
  } finally { await state.close(); }
});

test('추천 화면은 요청 문장, 추천 이유, 판매 상태에 맞는 담기 버튼을 보여준다', async () => {
  const shrimp = menus.flatMap((group) => group.items ?? [group]).find((item) => item.menuId === 2) ?? menus.find((item) => item.menuId === 2);
  const iced = menus.flatMap((group) => group.items ?? [group]).find((item) => item.menuId === 17) ?? menus.find((item) => item.menuId === 17);
  const state = await setup({ initialRecommendation: { query: '시원한 거 추천해줘', items: [
    { menu: shrimp, reason: '산뜻함 특징이 있습니다.' }, { menu: iced, reason: '시원한 음료입니다.' },
  ] } });
  try {
    assert(state.html.includes('>추천</button>'));
    assert(state.html.includes('말씀하신 내용에 맞춰 고른 메뉴입니다.'));
    assert(state.html.includes('시원한 거 추천해줘'));
    assert(state.html.includes('산뜻함 특징이 있습니다.'));
    assert(state.html.includes('<h3>리아 새우버거</h3>'));
    assert.equal((state.html.match(/<button class="primary" disabled=""[^>]*>장바구니 담기<\/button>/g) || []).length, 1);
  } finally { await state.close(); }
});
