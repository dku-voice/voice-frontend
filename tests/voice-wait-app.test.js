import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import { normalizeMenus, groupMenus, buildOrderBody } from '../src/domain/kiosk.js';
import { fakeClock } from './helpers/voice-clock.js';

test('App은 9초 외국어 주문을 처리하고 12초 종료 후 늦은 응답을 격리하며 터치 주문과 새 음성 재시도를 유지한다', async () => {
  const keys = ['window', 'WebSocket', 'AudioWorkletNode', 'navigator', 'localStorage', 'fetch', '__voiceWaitAppTest'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const install = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const clock = fakeClock(); const sockets = []; const streams = [];
  const trace = { clock, cart: [], bridge: null };
  const menus = groupMenus(normalizeMenus([{ menuId: 1, nameKo: '데리버거', price: 2800, status: 'ACTIVE', categoryNameKo: '버거',
    options: [{ optionId: 10, nameKo: '치즈 추가', optionType: 'ADD', extraPrice: 500 }] }]));
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    sent = [];
    constructor() { super(); sockets.push(this); }
    send(data) { assert(data instanceof ArrayBuffer || data === 'END'); this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class AudioContext {
    sampleRate = 16000;
    state = 'running';
    destination = {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }
  class Worklet {
    port = { onmessage: null };
    connect() {}
    disconnect() {}
  }
  install('window', { location: { origin: 'http://localhost:5173', pathname: '/', search: '' },
    speechSynthesis: { cancel() {} }, AudioContext, setTimeout });
  install('WebSocket', Socket); install('AudioWorkletNode', Worklet);
  install('navigator', { mediaDevices: { getUserMedia: async (request) => {
    assert(request.audio, 'no camera or real microphone access');
    const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }; streams.push(stream); return stream;
  } } });
  const storage = new Map();
  install('localStorage', { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) });
  install('fetch', () => assert.fail('live HTTP request forbidden'));
  install('__voiceWaitAppTest', trace);
  const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent',
    cacheDir: `/private/tmp/voice-wait-app-${process.pid}`,
    plugins: [{ name: 'voice-wait-clock', enforce: 'pre', transform(code, id) {
      if (!id.endsWith('/src/App.jsx')) return;
      return code.replace('const AI_WS_URL = runtimeConfig.aiWsUrl;', "const AI_WS_URL = 'ws://ai.invalid/ws/audio';")
        .replace('const [ttsEnabled, setTtsEnabled] = useState(true);', 'const [ttsEnabled, setTtsEnabled] = useState(false);')
        .replace('const [menuCatalog, setMenuCatalog] = useState([]);', `const [menuCatalog, setMenuCatalog] = useState(${JSON.stringify(menus)});`)
        .replace("const [menuSource, setMenuSource] = useState('loading');", "const [menuSource, setMenuSource] = useState('server');")
        .replace(/const \[cart, setCart\] = (useState\([^;]*\));/, `const [cart, setCartState] = $1;
          const setCart = (update) => {
            const state = globalThis.__voiceWaitAppTest;
            state.cart = typeof update === 'function' ? update(state.cart) : update;
            setCartState(update);
          };`)
        .replace('createVoiceWait({', 'createVoiceWait({ ...globalThis.__voiceWaitAppTest.clock,')
        .replace('  aiMessageHandlerRef.current = handleAiMessage;', `
          globalThis.__voiceWaitAppTest.bridge = { startVoiceStreaming, stopVoiceStreaming, finishVoiceStreaming, sendAudioToServer, addToCart,
            selectLanguageManually, languageRef, voiceSessionRef, appMountedRef, voiceWaitRef, wsRef, retireVoiceSocket };
          aiMessageHandlerRef.current = handleAiMessage;`);
    } }],
  });
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx'); renderToString(React.createElement(App));
    const app = trace.bridge; app.appMountedRef.current = true;
    const item = { menuId: 1, optionIds: [10] };
    const receive = (socket, data) => socket.onmessage({ data: JSON.stringify(data) });
    const silence = () => app.sendAudioToServer(new Int16Array(4096).buffer);
    app.selectLanguageManually('ko'); await app.startVoiceStreaming(); const first = sockets[0];
    await app.sendAudioToServer(new Int16Array(8192).fill(3000).buffer); clock.tick(1600);
    assert.equal(first.sent.at(-1), 'END', '1600ms speech pause must finish the server recording');
    clock.tick(5000); assert.equal(first.readyState, 1); assert.equal(app.voiceSessionRef.current, true);
    clock.tick(4000); receive(first, { type: 'order', item, language: 'ja' });
    assert.equal(trace.cart[0].quantity, 1); assert.equal(app.languageRef.current, 'ja'); assert.equal(clock.count, 0);

    app.stopVoiceStreaming(false); app.selectLanguageManually('es'); await app.startVoiceStreaming();
    const expiring = sockets.at(-1); const late = expiring.onmessage;
    await silence(); clock.tick(12000);
    assert.equal(expiring.readyState, 3); assert.equal(app.wsRef.current, null);
    assert.equal(app.voiceSessionRef.current, false); assert.equal(clock.count, 0);
    assert(streams.at(-1).getTracks()[0].stopped);
    late({ data: JSON.stringify({ type: 'order', item, language: 'th' }) });
    late({ data: JSON.stringify({ type: 'age_estimate', age: 80, language: 'th' }) });
    assert.equal(trace.cart[0].quantity, 1); assert.equal(app.languageRef.current, 'es');
    await silence(); assert.equal(clock.count, 0, 'old worker results must not restart an expired wait');
    app.addToCart(item);
    assert.deepEqual(buildOrderBody(trace.cart), { items: [{ menuId: 1, quantity: 2, optionIds: [10] }] });
    assert.equal(trace.cart[0].price, 3300);

    await app.startVoiceStreaming(); const retry = sockets.at(-1); assert.notEqual(retry, expiring);
    await silence(); late({ data: JSON.stringify({ type: 'order', item, language: 'ko' }) });
    assert.equal(trace.cart[0].quantity, 2);
    clock.tick(9000); receive(retry, { type: 'order', item, language: 'th' });
    assert.equal(trace.cart[0].quantity, 3); assert.equal(app.languageRef.current, 'th'); assert.equal(clock.count, 0);

    await silence(); const invalidLate = retry.onmessage; retry.onmessage({ data: 'not json' });
    assert.equal(retry.readyState, 3); assert.equal(app.voiceSessionRef.current, false);
    invalidLate({ data: JSON.stringify({ type: 'order', item, language: 'ja' }) }); assert.equal(trace.cart[0].quantity, 3);
    app.addToCart(item); assert.equal(trace.cart[0].quantity, 4);

    await app.startVoiceStreaming(); const failed = sockets.at(-1); const failedLate = failed.onmessage;
    await silence(); failed.onerror(); assert.equal(app.voiceSessionRef.current, false); assert.equal(clock.count, 0);
    await app.startVoiceStreaming(); const recovered = sockets.at(-1); assert.notEqual(failed, recovered);
    failedLate({ data: JSON.stringify({ type: 'order', item, language: 'ko' }) }); assert.equal(trace.cart[0].quantity, 4);
    await silence(); receive(recovered, { type: 'order', item });
    assert.equal(trace.cart[0].quantity, 5); assert.equal(app.languageRef.current, 'th');
    await silence(); clock.tick(1000); receive(recovered, { language: 'es', items: [{ menu_id: '1' }] });
    assert.equal(app.voiceWaitRef.current.waiting, true, 'language alone must not end analysis wait');
    clock.tick(8000); assert.equal(recovered.readyState, 1);
    receive(recovered, { type: 'order', item });
    assert.equal(trace.cart[0].quantity, 6); assert.equal(app.languageRef.current, 'es'); assert.equal(clock.count, 0);
    app.stopVoiceStreaming(true); assert.equal(clock.count, 0);
    await app.startVoiceStreaming(); const manual = sockets.at(-1);
    app.finishVoiceStreaming(); assert.equal(manual.sent.at(-1), 'END', 'manual recording stop must send END');
    assert.equal(app.voiceSessionRef.current, true, 'session remains active until the AI result arrives');
  } finally {
    trace.bridge?.stopVoiceStreaming(false);
    trace.bridge?.retireVoiceSocket(trace.bridge.wsRef.current);
    await server.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
