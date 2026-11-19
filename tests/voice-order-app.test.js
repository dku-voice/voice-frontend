import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import { buildOrderBody, groupMenus, normalizeMenus } from '../src/domain/kiosk.js';

test('App WebSocket 수신 지점은 새 AI items를 숫자 menuId 장바구니로 한 번에 반영한다', async () => {
  const keys = ['window', 'WebSocket', 'fetch', 'localStorage', '__voiceOrderAppTest'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const install = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const sockets = []; const trace = { cart: [], bridge: null };
  const menus = groupMenus(normalizeMenus([
    { menuId: 10, nameKo: '감자튀김', price: 2200, status: 'ACTIVE', categoryNameKo: '사이드', options: [] },
    { menuId: 14, nameKo: '콜라', price: 2100, status: 'ACTIVE', categoryNameKo: '음료', options: [] },
  ]));
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
  install('__voiceOrderAppTest', trace);
  const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent',
    cacheDir: `/private/tmp/voice-order-app-${process.pid}`,
    plugins: [{ name: 'voice-order-app-bridge', enforce: 'pre', transform(code, id) {
      if (!id.endsWith('/src/App.jsx')) return;
      return code.replace('const AI_WS_URL = runtimeConfig.aiWsUrl;', "const AI_WS_URL = 'ws://ai.invalid/ws/audio';")
        .replace('const [ttsEnabled, setTtsEnabled] = useState(true);', 'const [ttsEnabled, setTtsEnabled] = useState(false);')
        .replace('const [menuCatalog, setMenuCatalog] = useState([]);', `const [menuCatalog, setMenuCatalog] = useState(${JSON.stringify(menus)});`)
        .replace("const [menuSource, setMenuSource] = useState('loading');", "const [menuSource, setMenuSource] = useState('server');")
        .replace(/const \[cart, setCart\] = (useState\([^;]*\));/, `const [cart, setCartState] = $1;
          const setCart = (update) => { const state = globalThis.__voiceOrderAppTest;
            state.cart = typeof update === 'function' ? update(state.cart) : update; setCartState(update); };`)
        .replace('  aiMessageHandlerRef.current = handleAiMessage;', `
          globalThis.__voiceOrderAppTest.bridge = { connectWebSocket, sendAudioToServer, languageRef,
            voiceLanguageGuardRef, voiceSessionRef, appMountedRef, stopVoiceStreaming };
          aiMessageHandlerRef.current = handleAiMessage;`);
    } }],
  });
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    renderToString(React.createElement(App));
    const app = trace.bridge; app.appMountedRef.current = true; app.connectWebSocket();
    const socket = sockets[0];
    app.voiceLanguageGuardRef.current.startSession(); app.voiceSessionRef.current = true;
    await app.sendAudioToServer(new Int16Array(128).fill(3000).buffer);
    socket.onmessage({ data: JSON.stringify({ status: 'success', recognized_text: '콜라 두 개하고 감자튀김 하나',
      items: [{ menu_id: 'cola_01', quantity: 2, options: [] }, { menu_id: 'fries_01', quantity: 1, options: [] }],
      error_msg: null, language: 'es' }) });
    assert.equal(app.languageRef.current, 'es');
    assert.deepEqual(buildOrderBody(trace.cart), { items: [
      { menuId: 14, quantity: 2, optionIds: [] }, { menuId: 10, quantity: 1, optionIds: [] },
    ] });
    assert.equal(app.voiceSessionRef.current, false);
  } finally {
    trace.bridge?.stopVoiceStreaming(false); await server.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
