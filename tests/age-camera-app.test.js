import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import { fakeClock } from './helpers/voice-clock.js';

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const estimate = { estimatedAge: 72, ageGroup: 'senior', isSenior: true };
const fixtureCart = [{ menuId: 14, id: 14, lineId: '14:', name: '콜라', price: 2100, quantity: 2, optionIds: [] }];
let renderId = 0;

function buttons(node) {
  if (!React.isValidElement(node)) return [];
  return [...(node.type === 'button' ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(buttons)];
}

async function setup({ analyze = async () => ({ ...estimate }), permission, toBlob } = {}) {
  const keys = ['window', 'document', 'navigator', 'localStorage', 'fetch', '__ageCameraAppTest'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const install = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const trace = { apiCalls: [], permissions: 0, streams: [], ageWrites: [], cameraWrites: [], navigations: [], contrastWrites: [], cartWrites: [], recommendationWrites: [], clock: fakeClock(), bridge: null };
  const video = { videoWidth: 640, videoHeight: 480, srcObject: null, muted: false, playsInline: false, pauses: 0,
    async play() {}, pause() { this.pauses += 1; } };
  const makeStream = () => {
    const track = { stops: 0, stop() { this.stops += 1; } };
    const stream = { getTracks: () => [track], track }; trace.streams.push(stream); return stream;
  };
  trace.api = { analyze: async (blob, options) => {
    assert(blob instanceof Blob); assert.equal(blob.type, 'image/jpeg');
    trace.apiCalls.push({ signal: options.signal });
    return analyze(blob, options);
  } };
  install('__ageCameraAppTest', trace);
  install('window', { location: { origin: 'http://localhost:5173', pathname: '/', search: '' }, speechSynthesis: { cancel() {} } });
  install('navigator', { mediaDevices: { getUserMedia: (request) => {
    trace.permissions += 1; assert.deepEqual(request, { video: true, audio: false });
    return permission ? permission(makeStream) : Promise.resolve(makeStream());
  } } });
  install('document', { createElement: (tag) => {
    assert.equal(tag, 'canvas');
    return { width: 0, height: 0, getContext: () => ({ drawImage() {}, clearRect() {} }),
      toBlob: (callback, type, quality) => {
        assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.86);
        if (toBlob) toBlob(callback); else callback(new Blob(['mock-jpeg-not-a-face'], { type }));
      } };
  } });
  const stored = new Map();
  install('localStorage', { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) });
  install('fetch', () => assert.fail('live HTTP/face upload forbidden'));
  const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent',
    cacheDir: `/private/tmp/age-camera-app-${process.pid}-${renderId++}`,
    plugins: [{ name: 'age-camera-app-bridge', enforce: 'pre', transform(code, id) {
      if (!id.endsWith('/src/App.jsx')) return;
      let source = code.replace("import { ageAnalysisApi } from './api/vision.js';", 'const ageAnalysisApi = globalThis.__ageCameraAppTest.api;')
        .replace("const [currentScreen, setCurrentScreen] = useState('menu');", "const [currentScreen, setCurrentScreen] = useState('ageResult');")
        .replace('const [ttsEnabled, setTtsEnabled] = useState(true);', 'const [ttsEnabled, setTtsEnabled] = useState(false);')
        .replace('createVoiceWait({', 'createVoiceWait({ ...globalThis.__ageCameraAppTest.clock,')
        .replace(/const \[cart, setCart\] = useState\([^;]*\);/, `const [cart, setCart] = useState(${JSON.stringify(fixtureCart)});`);
      for (const [name, setter, target] of [
        ['currentScreen', 'setCurrentScreen', 'navigations'], ['ageEstimate', 'setAgeEstimate', 'ageWrites'],
        ['cameraState', 'setCameraState', 'cameraWrites'], ['highContrast', 'setHighContrast', 'contrastWrites'], ['cart', 'setCart', 'cartWrites'],
        ['recommendations', 'setRecommendations', 'recommendationWrites'],
      ]) {
        const expression = new RegExp(`const \\[${name}, ${setter}\\] = (useState\\([^;]*\\));`);
        assert(expression.test(source), `test state hook ${name} must exist`);
        source = source.replace(expression, `const [${name}, ${setter}State] = $1;
          const ${setter} = (value) => { globalThis.__ageCameraAppTest.${target}.push(value); ${setter}State(value); };`);
      }
      return source.replace('  aiMessageHandlerRef.current = handleAiMessage;', `
        globalThis.__ageCameraAppTest.bridge = { cameraRef, videoRef, currentScreenRef, appMountedRef,
          voiceStartingRef, voiceSessionRef, voiceWaitRef, paymentBusyRef, languageRef, openAgeAnalysis,
          menuItemsRef, handleAiMessage, openCamera, analyzeCamera, cancelCamera, chooseTouchOrder, renderAgeResult, renderTopBar, renderMenu };
        aiMessageHandlerRef.current = handleAiMessage;`);
    } }],
  });
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const html = renderToString(React.createElement(App));
    trace.bridge.appMountedRef.current = true;
    trace.bridge.videoRef.current = video;
    const close = async () => {
      trace.bridge.cancelCamera(); trace.bridge.voiceWaitRef.current.finish();
      trace.bridge.appMountedRef.current = false;
      await server.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    };
    return { trace, app: trace.bridge, video, html, close, makeStream,
      async open() { trace.bridge.openCamera(); return trace.bridge.cameraRef.current.open(); },
      async analyze() { trace.bridge.analyzeCamera(); return trace.bridge.cameraRef.current.analyze(); },
    };
  } catch (error) {
    await server.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
    throw error;
  }
}

test('App은 명시적 미리보기와 촬영을 분리하고 senior 결과로 모드·화면·장바구니를 자동 변경하지 않는다', async () => {
  const state = await setup();
  try {
    const { app, trace, video, html } = state;
    assert.equal(trace.permissions, 0); assert.equal(trace.apiCalls.length, 0);
    assert(html.includes('촬영 후 분석을 누르면 사진 한 장을 나이 분석 서버로 전송합니다.'));
    assert(buttons(app.renderAgeResult()).find((button) => button.props.children === '촬영 후 분석').props.disabled);
    app.openCamera(); app.openCamera(); assert.equal(await app.cameraRef.current.open(), true);
    assert.equal(trace.permissions, 1); assert.equal(trace.apiCalls.length, 0); assert(video.srcObject);
    app.analyzeCamera(); app.analyzeCamera(); assert.deepEqual(await app.cameraRef.current.analyze(), estimate);
    assert.equal(trace.apiCalls.length, 1); assert.equal(video.srcObject, null); assert.equal(trace.streams[0].track.stops, 1);
    assert.equal(trace.ageWrites.at(-1), 72); assert.deepEqual(trace.navigations, []); assert.deepEqual(trace.contrastWrites, []);
    assert.deepEqual(trace.cartWrites, []); assert.equal(app.currentScreenRef.current, 'ageResult');
    const touch = buttons(app.renderAgeResult()).find((button) => button.props.children === '터치로 주문하기');
    assert(touch); touch.props.onClick();
    assert.equal(trace.navigations.at(-1), 'menu'); assert.equal(trace.ageWrites.at(-1), null);
    assert.equal(app.cameraRef.current.getState().result, null);
  } finally { await state.close(); }
});

test('실제 탐색 버튼의 취소는 이전 분석의 늦은 결과를 버리고 현재 화면·수동 선택을 보존한다', async () => {
  const pending = deferred(); const state = await setup({ analyze: () => pending.promise });
  try {
    await state.open(); state.app.analyzeCamera(); const analysis = state.app.cameraRef.current.analyze(); await flush();
    assert.equal(state.trace.apiCalls.length, 1);
    const cart = buttons(state.app.renderTopBar()).find((button) => String(button.props.children).startsWith('장바구니'));
    assert(cart); cart.props.onClick(); state.app.currentScreenRef.current = 'cart';
    assert.equal(state.trace.navigations.at(-1), 'cart'); assert.equal(state.trace.apiCalls[0].signal.aborted, true);
    const writes = state.trace.ageWrites.length; const states = state.trace.cameraWrites.length;
    pending.resolve({ ...estimate, estimatedAge: 91 }); assert.equal(await analysis, null); await flush();
    assert.equal(state.trace.ageWrites.length, writes); assert.equal(state.trace.cameraWrites.length, states);
    assert.equal(state.trace.navigations.at(-1), 'cart'); assert.deepEqual(state.trace.cartWrites, []);
  } finally { await state.close(); }
});

test('카메라 권한 거부는 로컬 오류로 남고 기존 주문 데이터와 터치 복귀를 손상시키지 않는다', async () => {
  const state = await setup({ permission: () => Promise.reject(Object.assign(new Error('private detail'), { name: 'NotAllowedError' })) });
  try {
    assert.equal(await state.open(), false); assert.equal(state.trace.apiCalls.length, 0);
    assert.equal(state.app.cameraRef.current.getState().error.code, 'PERMISSION_DENIED');
    assert.deepEqual(state.trace.cartWrites, []); assert.deepEqual(state.trace.navigations, []);
    state.app.chooseTouchOrder(); assert.equal(state.trace.navigations.at(-1), 'menu');
  } finally { await state.close(); }
});

test('성공 뒤 재시도에서 권한 오류가 나면 이전 추정 나이를 현재 결과로 남기지 않는다', async () => {
  let requests = 0;
  const state = await setup({ permission: (makeStream) => {
    requests += 1;
    return requests === 1 ? Promise.resolve(makeStream())
      : Promise.reject(Object.assign(new Error('private error'), { name: 'NotAllowedError' }));
  } });
  try {
    await state.open(); await state.analyze(); assert.equal(state.trace.ageWrites.at(-1), 72);
    assert.equal(await state.open(), false);
    assert.equal(state.trace.ageWrites.at(-1), null);
    assert.equal(state.app.cameraRef.current.getState().result, null);
    assert.equal(state.app.cameraRef.current.getState().error.code, 'PERMISSION_DENIED');
    assert.deepEqual(state.trace.navigations, []); assert.deepEqual(state.trace.cartWrites, []);
  } finally { await state.close(); }
});

test('음성 시작·분석 대기·결제 중에는 카메라 요청을 시작하지 않고 사용자가 선택한 모드를 유지한다', async () => {
  const state = await setup();
  try {
    for (const flag of ['voiceStartingRef', 'voiceSessionRef', 'paymentBusyRef']) {
      state.app[flag].current = true;
      state.app.openAgeAnalysis(); state.app.openCamera(); state.app.analyzeCamera(); await flush();
      assert.equal(state.trace.permissions, 0); assert.equal(state.trace.apiCalls.length, 0); assert.equal(state.app[flag].current, true);
      assert.deepEqual(state.trace.navigations, []); state.app[flag].current = false;
    }
    state.app.voiceWaitRef.current.start('ko'); state.app.openAgeAnalysis(); state.app.openCamera(); await flush();
    assert.equal(state.trace.permissions, 0); assert.equal(state.trace.apiCalls.length, 0);
    state.app.voiceWaitRef.current.finish();
    state.app.currentScreenRef.current = 'menu'; state.app.openAgeAnalysis();
    assert.equal(state.trace.navigations.at(-1), 'ageResult'); assert.equal(state.trace.permissions, 0, 'entry alone does not request permission');
  } finally { await state.close(); }
});

test('캡처 중 결제로 전환되면 업로드 직전 문맥 검사로 이미지 전송을 막는다', async () => {
  let finishBlob; const state = await setup({ toBlob: (callback) => { finishBlob = callback; } });
  try {
    await state.open(); state.app.analyzeCamera(); const analysis = state.app.cameraRef.current.analyze(); await flush();
    assert(finishBlob); state.app.paymentBusyRef.current = true;
    finishBlob(new Blob(['mock-jpeg'], { type: 'image/jpeg' })); await analysis;
    assert.equal(state.trace.apiCalls.length, 0); assert.equal(state.trace.streams[0].track.stops, 1);
    assert.deepEqual(state.trace.navigations, []); assert.deepEqual(state.trace.cartWrites, []);
    state.app.paymentBusyRef.current = false;
  } finally { await state.close(); }
});

test('화면을 떠난 뒤 늦게 허용된 카메라 스트림은 즉시 정리하며 촬영·업로드하지 않는다', async () => {
  const permission = deferred(); const state = await setup({ permission: () => permission.promise });
  try {
    state.app.openCamera(); const opening = state.app.cameraRef.current.open(); await flush();
    state.app.chooseTouchOrder(); state.app.currentScreenRef.current = 'menu';
    const stream = state.makeStream(); permission.resolve(stream); assert.equal(await opening, false); await flush();
    assert.equal(stream.track.stops, 1); assert.equal(state.video.srcObject, null); assert.equal(state.trace.apiCalls.length, 0);
    assert.equal(state.trace.navigations.at(-1), 'menu'); assert.deepEqual(state.trace.cartWrites, []);
  } finally { await state.close(); }
});

test('기존 추천 응답은 카메라 미리보기와 분석을 취소하거나 화면을 이동시키지 않고 추천 데이터만 갱신한다', async () => {
  const pending = deferred(); const state = await setup({ analyze: () => pending.promise });
  try {
    const { app, trace, video } = state;
    const menu = { menuId: 14, id: 14, name: '콜라', price: 2100, status: 'ACTIVE', options: [] };
    app.menuItemsRef.current = [menu];
    const recommendation = JSON.stringify({ type: 'recommendation', items: [{ menuId: 14 }] });
    await state.open();
    app.handleAiMessage(recommendation);
    assert.deepEqual(trace.recommendationWrites.at(-1), [menu]);
    assert.equal(app.cameraRef.current.getState().phase, 'preview');
    assert(video.srcObject); assert.equal(trace.streams[0].track.stops, 0);
    assert.deepEqual(trace.navigations, []); assert.deepEqual(trace.cartWrites, []);

    app.analyzeCamera(); const analysis = app.cameraRef.current.analyze(); await flush();
    assert.equal(trace.apiCalls.length, 1);
    app.handleAiMessage(recommendation);
    assert.equal(trace.recommendationWrites.length, 2);
    assert.equal(app.cameraRef.current.getState().phase, 'analyzing');
    assert.equal(trace.apiCalls[0].signal.aborted, false);
    assert.deepEqual(trace.navigations, []); assert.deepEqual(trace.cartWrites, []);
    pending.resolve(estimate); assert.deepEqual(await analysis, estimate);
    assert.equal(trace.ageWrites.at(-1), 72); assert.deepEqual(trace.navigations, []);
  } finally { await state.close(); }
});

test('카메라 화면 밖의 기존 나이 응답은 진행 중인 음성 대기 타이머와 장바구니를 건드리지 않는다', async () => {
  const state = await setup();
  try {
    const { app, trace } = state;
    app.currentScreenRef.current = 'menu'; app.voiceSessionRef.current = true;
    app.voiceWaitRef.current.start('ko');
    const scheduled = trace.clock.count;
    for (const age of [79, -1, 121, '79', null]) {
      app.handleAiMessage(JSON.stringify({ type: 'age_estimate', age }));
      assert.equal(app.voiceWaitRef.current.active, true);
      assert.equal(trace.clock.count, scheduled);
    }
    assert.deepEqual(trace.ageWrites, []); assert.deepEqual(trace.navigations, []); assert.deepEqual(trace.cartWrites, []);
    trace.clock.tick(5000);
    assert.equal(app.voiceWaitRef.current.touchAvailable, true);
    assert.equal(app.voiceWaitRef.current.active, true); assert.equal(app.voiceSessionRef.current, true);
    trace.clock.tick(7000);
    assert.equal(app.voiceWaitRef.current.active, false); assert.equal(app.voiceSessionRef.current, false);
    assert.equal(trace.clock.count, 0); assert.equal(trace.permissions, 0); assert.equal(trace.apiCalls.length, 0);
  } finally { await state.close(); }
});

test('기존 나이 응답은 카메라 미리보기 중 무시되고 유휴 나이 화면에서는 기존 표시와 대기 종료를 유지한다', async () => {
  const state = await setup();
  try {
    const { app, trace } = state;
    await state.open(); const writes = trace.ageWrites.length;
    app.voiceWaitRef.current.start('ko'); const scheduled = trace.clock.count;
    app.handleAiMessage(JSON.stringify({ type: 'age_estimate', age: 80 }));
    assert.equal(trace.ageWrites.length, writes); assert.equal(app.voiceWaitRef.current.active, true);
    assert.equal(trace.clock.count, scheduled); assert.equal(app.cameraRef.current.getState().phase, 'preview');
    app.voiceWaitRef.current.finish(); app.cancelCamera();

    app.voiceWaitRef.current.start('ko'); assert(trace.clock.count > 0);
    app.handleAiMessage(JSON.stringify({ type: 'age_estimate', age: 81 }));
    assert.equal(trace.ageWrites.at(-1), 81); assert.equal(app.voiceWaitRef.current.active, false);
    assert.equal(trace.clock.count, 0); assert.deepEqual(trace.navigations, []);
    assert.deepEqual(trace.contrastWrites, []); assert.deepEqual(trace.cartWrites, []);
    assert.equal(trace.apiCalls.length, 0);
  } finally { await state.close(); }
});
