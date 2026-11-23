import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import { fakeClock } from './helpers/voice-clock.js';

let renderId = 0;

async function setup({ analyze, permission, language } = {}) {
  const keys = ['window', 'document', 'navigator', 'localStorage', 'fetch', '__welcomeStartTest'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const install = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const trace = { apiCalls: [], permissions: 0, streams: [], stageWrites: [], phaseWrites: [], navigations: [],
    countdownWrites: [], ageWrites: [], clock: fakeClock(), bridge: null };
  const video = { videoWidth: 640, videoHeight: 480, srcObject: null, muted: false, playsInline: false,
    async play() {}, pause() {} };
  trace.api = { analyze: async (blob, options) => {
    trace.apiCalls.push({ signal: options.signal });
    return analyze(blob, options);
  } };
  install('__welcomeStartTest', trace);
  install('window', { location: { origin: 'http://localhost:5173', pathname: '/', search: '' }, speechSynthesis: { cancel() {} } });
  install('navigator', { mediaDevices: { getUserMedia: () => {
    trace.permissions += 1;
    if (permission) return permission();
    const track = { stops: 0, stop() { this.stops += 1; } };
    const stream = { getTracks: () => [track], track };
    trace.streams.push(stream);
    return Promise.resolve(stream);
  } } });
  install('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage() {}, clearRect() {} }),
    toBlob: (callback, type) => callback(new Blob(['mock-jpeg-not-a-face'], { type })) }) });
  const stored = new Map(language ? [['voice-kiosk-language', language]] : []);
  install('localStorage', { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) });
  install('fetch', () => assert.fail('live HTTP forbidden'));
  const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent',
    cacheDir: `/private/tmp/welcome-start-${process.pid}-${renderId++}`,
    plugins: [{ name: 'welcome-start-bridge', enforce: 'pre', transform(code, id) {
      if (!id.endsWith('/src/App.jsx')) return;
      let source = code.replace("import { ageAnalysisApi } from './api/vision.js';", 'const ageAnalysisApi = globalThis.__welcomeStartTest.api;')
        .replace('const [ttsEnabled, setTtsEnabled] = useState(true);', 'const [ttsEnabled, setTtsEnabled] = useState(false);')
        .replace('createVoiceWait({', 'createVoiceWait({ ...globalThis.__welcomeStartTest.clock,');
      for (const [name, setter, target] of [
        ['kioskStage', 'setKioskStage', 'stageWrites'], ['startPhase', 'setStartPhase', 'phaseWrites'],
        ['currentScreen', 'setCurrentScreen', 'navigations'], ['completeCountdown', 'setCompleteCountdown', 'countdownWrites'],
        ['ageEstimate', 'setAgeEstimate', 'ageWrites'],
      ]) {
        const expression = new RegExp(`const \\[${name}, ${setter}\\] = (useState\\([^;]*\\));`);
        assert(expression.test(source), `test state hook ${name} must exist`);
        source = source.replace(expression, `const [${name}, ${setter}State] = $1;
          const ${setter} = (value) => { globalThis.__welcomeStartTest.${target}.push(value); ${setter}State(value); };`);
      }
      return source.replace('  aiMessageHandlerRef.current = handleAiMessage;', `
        globalThis.__welcomeStartTest.bridge = { cameraRef, videoRef, appMountedRef, voiceWaitRef, kioskStageRef,
          startOrder, enterOrdering, returnToWelcome, cancelCamera };
        aiMessageHandlerRef.current = handleAiMessage;`);
    } }],
  });
  const restore = () => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  };
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const html = renderToString(React.createElement(App));
    trace.bridge.appMountedRef.current = true;
    trace.bridge.videoRef.current = video;
    const close = async () => {
      trace.bridge.cancelCamera(); trace.bridge.voiceWaitRef.current.finish();
      trace.bridge.appMountedRef.current = false;
      await server.close();
      restore();
    };
    return { trace, app: trace.bridge, html, close };
  } catch (error) {
    await server.close();
    restore();
    throw error;
  }
}

test('키오스크는 대기 화면에서 시작하고 카메라를 켜지 않는다', async () => {
  const state = await setup({ analyze: async () => assert.fail('no analysis before start') });
  try {
    assert(state.html.includes('주문 시작'));
    assert(state.html.includes('start-order-button'));
    assert(!state.html.includes('class="item-card'));
    assert.equal(state.trace.permissions, 0);
    assert.equal(state.trace.apiCalls.length, 0);
  } finally { await state.close(); }
});

test('주문 시작 시 한 번만 촬영하고 60세 이상이면 터치 주문 선택 팝업을 띄운다', async () => {
  const state = await setup({ analyze: async () => ({ estimatedAge: 72, ageGroup: 'senior', isSenior: true }) });
  try {
    await state.app.startOrder();
    assert.equal(state.trace.permissions, 1);
    assert.equal(state.trace.apiCalls.length, 1);
    assert.equal(state.trace.streams[0].track.stops, 1);
    assert.deepEqual(state.trace.phaseWrites, ['analyzing', 'senior']);
    assert.equal(state.trace.ageWrites.at(-1), 72);
    assert(!state.trace.stageWrites.includes('ordering'));

    state.app.enterOrdering('touch');
    assert.equal(state.trace.stageWrites.at(-1), 'ordering');
    assert.equal(state.trace.navigations.at(-1), 'menu');
    assert.equal(state.trace.apiCalls.length, 1);
  } finally { await state.close(); }
});

test('60세 미만이면 팝업 없이 바로 주문 화면으로 넘어간다', async () => {
  const state = await setup({ analyze: async () => ({ estimatedAge: 31, ageGroup: 'adult', isSenior: false }) });
  try {
    await state.app.startOrder();
    assert.equal(state.trace.apiCalls.length, 1);
    assert(!state.trace.phaseWrites.includes('senior'));
    assert.equal(state.trace.stageWrites.at(-1), 'ordering');
    assert.equal(state.trace.navigations.at(-1), 'menu');
    assert.equal(state.trace.streams[0].track.stops, 1);
  } finally { await state.close(); }
});

test('카메라 권한이 없으면 분석 없이 주문 화면으로 넘어간다', async () => {
  const denied = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  const state = await setup({ permission: denied, analyze: async () => assert.fail('no analysis without camera') });
  try {
    await state.app.startOrder();
    assert.equal(state.trace.apiCalls.length, 0);
    assert.equal(state.trace.stageWrites.at(-1), 'ordering');
    assert.equal(state.trace.navigations.at(-1), 'menu');
  } finally { await state.close(); }
});

test('처음으로는 대기 화면으로 돌아가고 카운트다운을 멈춘다', async () => {
  const state = await setup({ analyze: async () => ({ estimatedAge: 31, ageGroup: 'adult', isSenior: false }) });
  try {
    state.app.returnToWelcome();
    assert.equal(state.trace.stageWrites.at(-1), 'welcome');
    assert.equal(state.trace.navigations.at(-1), 'menu');
    assert.equal(state.trace.countdownWrites.at(-1), 0);
    assert.equal(state.trace.permissions, 0);
  } finally { await state.close(); }
});

test('대기 화면 문구는 선택한 언어로 번역된다', async () => {
  for (const language of ['ja', 'es', 'th']) {
    const state = await setup({ language, analyze: async () => assert.fail('no analysis') });
    try {
      const welcome = state.html.slice(state.html.indexOf('welcome-screen'));
      const text = welcome.replace(/<[^>]+>/g, ' ');
      assert(!/[가-힣]/.test(text), `${language}: untranslated welcome text: ${text.match(/[^ ]*[가-힣][^ ]*/g)}`);
    } finally { await state.close(); }
  }
});
