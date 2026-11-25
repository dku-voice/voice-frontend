import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';

// Execute the actual App socket callback and manual selector against a fake
// socket. No microphone, real AI, backend mutation or payment request is used.
test('실제 WebSocket 수신 지점은 현재 음성 창에만 자동 전환하고 수동 선택·재시작·이전 소켓을 보호한다', async () => {
  const keys = ['window', 'WebSocket', 'fetch', 'localStorage', '__voiceLanguageAppTest'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const sockets = [];
  const trace = { items: [], bridge: null };
  const install = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(data); }
  }
  install('window', { location: { origin: 'http://localhost:5173', pathname: '/', search: '' }, speechSynthesis: { cancel() {} } });
  install('WebSocket', FakeSocket);
  const stored = new Map();
  install('localStorage', { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) });
  install('fetch', () => assert.fail('live API is forbidden'));
  install('__voiceLanguageAppTest', trace);
  const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent',
    cacheDir: `/private/tmp/voice-language-app-${process.pid}`,
    plugins: [{ name: 'voice-language-test-bridge', enforce: 'pre', transform(code, id) {
      if (!id.endsWith('/src/App.jsx')) return;
      return code.replace('const AI_WS_URL = runtimeConfig.aiWsUrl;', "const AI_WS_URL = 'ws://ai.invalid/ws/audio';")
        .replace('  const addToCart = (candidate) => {', '  const addToCart = (candidate) => { globalThis.__voiceLanguageAppTest.items.push(structuredClone(candidate));')
        .replace('  aiMessageHandlerRef.current = handleAiMessage;', `
          globalThis.__voiceLanguageAppTest.bridge = { connectWebSocket, sendAudioToServer, stopVoiceStreaming,
            languageRef, voiceLanguageGuardRef, voiceSessionRef, appMountedRef, renderTopBar };
          aiMessageHandlerRef.current = handleAiMessage;`);
    } }],
  });
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const { default: Selector } = await server.ssrLoadModule('/src/i18n/LanguageSelector.jsx');
    renderToString(React.createElement(App));
    const app = trace.bridge;
    app.appMountedRef.current = true;
    app.connectWebSocket();
    const first = sockets[0];
    const start = () => { app.voiceLanguageGuardRef.current.startSession(); app.voiceSessionRef.current = true; };
    const audio = () => app.sendAudioToServer(new ArrayBuffer(4));
    const receive = (socket, data) => socket.onmessage({ data: JSON.stringify(data) });
    const findSelector = (node) => {
      if (node?.type === Selector) return node;
      return React.Children.toArray(node?.props?.children).map(findSelector).find(Boolean);
    };
    const choose = (language) => {
      const element = findSelector(app.renderTopBar());
      assert(element);
      Selector(element.props).props.children.find((button) => button.props.lang === language).props.onClick();
    };
    const item = { menuId: 1, quantity: 3, optionIds: [10] };
    start(); receive(first, { language: 'ja', items: [{ menu_id: '1' }] }); assert.equal(app.languageRef.current, 'ko');
    await audio(); receive(first, { type: 'order', item, language: 'ja' });
    assert.equal(app.languageRef.current, 'ja');
    assert.deepEqual(trace.items, [item]);

    await audio(); choose('es'); await audio();
    receive(first, { type: 'order', item, language: 'th' });
    assert.equal(app.languageRef.current, 'es');
    assert.deepEqual(trace.items, [item, item], 'language rejection must not skip the legacy order handler');
    await audio(); receive(first, { language: 'th', items: [{ menu_id: '1' }] }); assert.equal(app.languageRef.current, 'th');

    await audio(); app.stopVoiceStreaming(false); start(); await audio();
    receive(first, { language: 'es', items: [{ menu_id: '1' }] }); assert.equal(app.languageRef.current, 'th');
    await audio(); receive(first, { language: 'ko', items: [{ menu_id: '1' }] }); assert.equal(app.languageRef.current, 'ko');
    await audio(); choose('ko'); receive(first, { language: 'ja', items: [{ menu_id: '1' }] }); assert.equal(app.languageRef.current, 'ko');

    first.readyState = 3; app.connectWebSocket(); const second = sockets[1];
    await audio(); receive(first, { type: 'order', item, language: 'es' });
    assert.equal(app.languageRef.current, 'ko'); assert.equal(trace.items.length, 2);
    receive(second, { language: 'ja', items: [{ menu_id: '1' }] }); assert.equal(app.languageRef.current, 'ja');
    await audio(); receive(second, { type: 'order', item, language: null });
    assert.equal(app.languageRef.current, 'ja'); assert.equal(trace.items.length, 3);
    app.stopVoiceStreaming(false);
  } finally {
    trace.bridge?.stopVoiceStreaming(false);
    await server.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
