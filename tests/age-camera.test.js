import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgeCamera, ageCameraMessages } from '../src/integration/age-camera.js';

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 15; index += 1) await Promise.resolve(); };
const stream = () => {
  const track = { stops: 0, stop() { this.stops += 1; } };
  return { track, getTracks: () => [track] };
};
const age = (estimatedAge = 32) => ({ estimatedAge, ageGroup: 'adult', isSenior: false });
function setup(overrides = {}) {
  const states = []; const results = []; const streams = []; const uploads = []; const canvases = [];
  const video = { srcObject: null, videoWidth: 1920, videoHeight: 1080, pauses: 0,
    play: async () => {}, pause() { this.pauses += 1; } };
  const mediaDevices = { getUserMedia: async (request) => {
    assert.deepEqual(request, { video: true, audio: false });
    const acquired = stream(); streams.push(acquired); return acquired;
  } };
  const canvasFactory = () => {
    const context = { draws: [], clears: [], drawImage(...args) { this.draws.push(args); }, clearRect(...args) { this.clears.push(args); } };
    const canvas = { width: 0, height: 0, context,
      getContext: (kind) => kind === '2d' ? context : null,
      toBlob(callback, type, quality) {
        assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.86);
        callback(new Blob(['local-test-image'], { type }));
      } };
    canvases.push(canvas); return canvas;
  };
  const camera = createAgeCamera({ getVideo: () => video, mediaDevices, createCanvas: canvasFactory,
    analyze: async (blob, { signal }) => {
      assert(blob instanceof Blob); assert.equal(signal.aborted, false);
      assert.equal(video.srcObject, null); assert(streams.every((source) => source.track.stops === 1));
      assert(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
      uploads.push(blob); return age();
    },
    onState: (state) => states.push(state), onResult: (result) => results.push(result),
    permissionTimeoutMs: 50, captureTimeoutMs: 50, timeoutMs: 50, ...overrides });
  return { camera, video, streams, uploads, canvases, results, states, mediaDevices, canvasFactory };
}

test('미리보기와 전송을 분리하고 촬영 직후 카메라·캔버스를 정리한 뒤 한 프레임만 분석한다', async () => {
  const state = setup(); const { camera, video } = state;
  assert.equal(camera.busy, false); assert.equal(camera.getState().phase, 'idle');
  assert.equal(await camera.analyze(), null); assert.equal(state.uploads.length, 0);
  assert.equal(await camera.open(), true); assert.equal(camera.busy, true);
  assert.equal(camera.getState().phase, 'preview'); assert.equal(video.srcObject, state.streams[0]);
  assert.equal(state.uploads.length, 0); assert.equal(state.streams[0].track.stops, 0);
  assert.deepEqual(await camera.analyze(), age());
  assert.deepEqual(state.results, [age()]); assert.equal(state.uploads.length, 1);
  assert.equal(camera.getState().phase, 'success'); assert.equal(camera.busy, false);
  assert.equal(video.srcObject, null); assert.equal(video.pauses, 1);
  assert.deepEqual(state.canvases[0].context.draws[0].slice(1), [0, 0, 1280, 720]);
  const serialized = JSON.stringify(camera.getState());
  assert(!serialized.includes('local-test-image')); assert(!serialized.includes('blob')); assert(!serialized.includes('srcObject'));
  camera.cancel(); camera.cancel(); assert.equal(video.pauses, 1); assert.equal(state.streams[0].track.stops, 1);
  assert.deepEqual(camera.getState(), { phase: 'idle', error: null, result: null });
});

test('중복 열기·분석은 같은 Promise를 재사용하며 미리보기에서 다시 열어도 재권한 요청하지 않는다', async () => {
  const capture = deferred(); const state = setup({ analyze: () => capture.promise });
  const first = state.camera.open(); assert.equal(first, state.camera.open());
  await first; await state.camera.open(); assert.equal(state.streams.length, 1);
  const analyze = state.camera.analyze(); assert.equal(analyze, state.camera.analyze());
  assert.equal(await state.camera.open(), false);
  await flush(); capture.resolve(age(40)); await analyze;
  assert.deepEqual(state.results, [age(40)]);
});

test('권한 거부·장치 없음·장치 사용 중 오류는 안전한 메시지로 처리하고 기존 주문을 막지 않는다', async () => {
  for (const [name, expected] of [['NotAllowedError', 'PERMISSION_DENIED'], ['NotFoundError', 'CAMERA_NOT_FOUND'], ['NotReadableError', 'CAMERA_IN_USE']]) {
    const { camera } = setup({ mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error('raw private diagnostic'), { name }); } } });
    assert.equal(await camera.open(), false); assert.equal(camera.busy, false);
    assert.equal(camera.getState().error.code, expected);
    assert.equal(camera.getState().error.message, ageCameraMessages[expected]);
    assert(!JSON.stringify(camera.getState()).includes('raw private'));
    camera.cancel(); assert.equal(camera.getState().phase, 'idle');
  }
  const unsupported = setup({ mediaDevices: null });
  assert.equal(await unsupported.camera.open(), false); assert.equal(unsupported.camera.getState().error.code, 'UNSUPPORTED');
});

test('취소 전에 요청한 권한이 늦게 허용돼도 새 카메라 미리보기를 건드리지 않고 이전 트랙만 중지한다', async () => {
  const one = deferred(); const two = deferred(); let calls = 0;
  const state = setup({ mediaDevices: { getUserMedia: () => (++calls === 1 ? one.promise : two.promise) } });
  const first = state.camera.open(); await flush(); state.camera.cancel(); assert.equal(await first, false);
  const second = state.camera.open(); await flush(); const newer = stream(); two.resolve(newer);
  assert.equal(await second, true); assert.equal(state.video.srcObject, newer);
  const old = stream(); one.resolve(old); await flush();
  assert.equal(old.track.stops, 1); assert.equal(state.video.srcObject, newer); assert.equal(state.video.pauses, 0);
  assert.equal(state.camera.getState().phase, 'preview');
  state.camera.cancel(); assert.equal(newer.track.stops, 1); assert.equal(state.video.srcObject, null);
});

test('권한·미리보기 제한 시간과 취소를 처리하고 지연된 완료가 상태를 되살리지 않는다', async () => {
  const permission = deferred(); const denied = setup({ mediaDevices: { getUserMedia: () => permission.promise }, permissionTimeoutMs: 5 });
  assert.equal(await denied.camera.open(), false); assert.equal(denied.camera.getState().error.code, 'PERMISSION_TIMEOUT');
  const old = stream(); permission.resolve(old); await flush(); assert.equal(old.track.stops, 1);
  assert.equal(denied.camera.getState().phase, 'error');
  const play = deferred(); const state = setup({ captureTimeoutMs: 5 }); state.video.play = () => play.promise;
  assert.equal(await state.camera.open(), false); assert.equal(state.camera.getState().error.code, 'PREVIEW_TIMEOUT');
  assert.equal(state.streams[0].track.stops, 1); assert.equal(state.video.srcObject, null);
  play.resolve(); await flush(); assert.equal(state.camera.getState().phase, 'error');
});

test('새 미리보기 도중 이전 play가 완료돼도 새 srcObject를 분리하지 않는다', async () => {
  const play = deferred(); const state = setup(); state.video.play = () => play.promise;
  const first = state.camera.open(); await flush(); state.camera.cancel(); await first;
  state.video.play = async () => {};
  assert.equal(await state.camera.open(), true); const current = state.video.srcObject; const pauses = state.video.pauses;
  play.resolve(); await flush(); assert.equal(state.video.srcObject, current); assert.equal(state.video.pauses, pauses);
  state.camera.cancel();
});

test('영상 크기·캔버스·Blob 오류에서 가짜 프레임을 만들거나 전송하지 않는다', async () => {
  for (const change of [
    (state) => { state.video.videoWidth = 0; },
    (state) => { state.video.videoHeight = NaN; },
  ]) {
    const state = setup(); change(state);
    await state.camera.open(); assert.equal(await state.camera.analyze(), null);
    assert.equal(state.uploads.length, 0); assert.equal(state.streams[0].track.stops, 1);
    assert.equal(state.camera.getState().error.code, 'VIDEO_NOT_READY');
  }
  for (const createCanvas of [
    () => ({ width: 0, height: 0, getContext: () => null }),
    () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, clearRect() {} }), toBlob: (callback) => callback(null) }),
    () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, clearRect() {} }), toBlob: (callback) => callback(new Blob([])) }),
  ]) {
    const state = setup({ createCanvas }); await state.camera.open();
    assert.equal(await state.camera.analyze(), null); assert.equal(state.camera.getState().error.code, 'CAPTURE_FAILED');
    assert.equal(state.uploads.length, 0); assert.equal(state.streams[0].track.stops, 1);
  }
});

test('장치가 끊기거나 현재 프레임이 준비되지 않으면 남아 있는 영상 크기로 촬영·전송하지 않는다', async () => {
  for (const disconnect of [
    (state) => { state.streams[0].active = false; },
    (state) => { const source = state.streams[0]; source.track.readyState = 'ended'; source.getVideoTracks = () => [source.track]; },
    (state) => { const source = state.streams[0]; source.track.kind = 'video'; source.track.readyState = 'ended'; },
    (state) => { state.streams[0].getVideoTracks = () => []; },
    (state) => { state.video.readyState = 0; },
    (state) => { state.video.readyState = 1; state.video.HAVE_CURRENT_DATA = 2; },
  ]) {
    const state = setup(); assert.equal(await state.camera.open(), true);
    disconnect(state);
    assert(state.video.videoWidth > 0 && state.video.videoHeight > 0);
    assert.equal(await state.camera.analyze(), null);
    assert.equal(state.camera.getState().error.code, 'VIDEO_NOT_READY');
    assert.equal(state.camera.busy, false); assert.equal(state.canvases.length, 0);
    assert.equal(state.uploads.length, 0); assert.deepEqual(state.results, []);
    assert.equal(state.streams[0].track.stops, 1); assert.equal(state.video.srcObject, null);
    assert.equal(state.video.pauses, 1);
    state.camera.cancel(); assert.equal(state.streams[0].track.stops, 1);
  }
});

test('활성 카메라와 현재 프레임이 준비된 영상은 정상적으로 한 프레임을 분석한다', async () => {
  for (const readyState of [2, 3, 4]) {
    const state = setup(); await state.camera.open();
    const source = state.streams[0]; source.active = true; source.track.readyState = 'live';
    source.getVideoTracks = () => [source.track];
    state.video.readyState = readyState; state.video.HAVE_CURRENT_DATA = 2;
    assert.deepEqual(await state.camera.analyze(), age());
    assert.equal(state.uploads.length, 1); assert.equal(source.track.stops, 1);
    assert.deepEqual(state.results, [age()]);
  }
});

test('취소된 toBlob과 캡처 시간 초과의 늦은 Blob은 업로드하지 않는다', async () => {
  for (const cancel of [false, true]) {
    let finish; const state = setup({ captureTimeoutMs: 5, createCanvas: () => ({ width: 0, height: 0,
      getContext: () => ({ drawImage() {}, clearRect() {} }), toBlob: (callback) => { finish = callback; } }) });
    await state.camera.open(); const pending = state.camera.analyze(); await flush();
    if (cancel) state.camera.cancel();
    assert.equal(await pending, null);
    if (!cancel) assert.equal(state.camera.getState().error.code, 'CAPTURE_TIMEOUT');
    finish(new Blob(['late'], { type: 'image/jpeg' })); await flush();
    assert.equal(state.uploads.length, 0); assert.equal(state.streams[0].track.stops, 1);
  }
});

test('이미지 크기는 원본보다 확대하지 않고 세로 영상도 최대 범위 내에서 비율을 유지한다', async () => {
  for (const [width, height, expected] of [[320, 240, [320, 240]], [1080, 1920, [405, 720]]]) {
    const state = setup(); state.video.videoWidth = width; state.video.videoHeight = height;
    await state.camera.open(); await state.camera.analyze();
    assert.deepEqual(state.canvases[0].context.draws[0].slice(-2), expected);
  }
});

test('분석 취소·시간 초과 후 API가 늦게 성공해도 결과 콜백이나 최신 상태를 바꾸지 않는다', async () => {
  for (const cancel of [false, true]) {
    const response = deferred(); let signal;
    const state = setup({ timeoutMs: 5, analyze: (_blob, options) => { signal = options.signal; return response.promise; } });
    await state.camera.open(); const pending = state.camera.analyze(); await flush();
    if (cancel) state.camera.cancel();
    assert.equal(await pending, null); assert.equal(signal.aborted, true);
    const expected = state.camera.getState(); response.resolve(age(70)); await flush();
    assert.deepEqual(state.camera.getState(), expected); assert.deepEqual(state.results, []);
    assert.equal(state.streams[0].track.stops, 1);
  }
});

test('이전 분석 취소 후 새 요청이 성공하면 예전 결과는 전달하지 않고 공개 결과도 방어적으로 복사한다', async () => {
  const old = deferred(); let calls = 0;
  const state = setup({ analyze: () => ++calls === 1 ? old.promise : Promise.resolve(age(44)) });
  await state.camera.open(); const canceledAnalysis = state.camera.analyze(); await flush(); state.camera.cancel(); await canceledAnalysis;
  await state.camera.open(); assert.deepEqual(await state.camera.analyze(), age(44));
  old.resolve(age(88)); await flush(); assert.deepEqual(state.results, [age(44)]);
  const copy = state.camera.getState(); copy.result.estimatedAge = 99;
  assert.equal(state.camera.getState().result.estimatedAge, 44);
  state.camera.cancel(); assert.equal(state.camera.getState().result, null);
});

test('API 오류와 잘못된 나이 응답은 안전한 실패이며 유효한 0세도 특정 모드 정책 없이 보존한다', async () => {
  const rejected = setup({ analyze: async () => { throw new Error('private-image-diagnostic'); } });
  await rejected.camera.open(); assert.equal(await rejected.camera.analyze(), null);
  assert.equal(rejected.camera.getState().error.code, 'ANALYSIS_FAILED');
  assert(!JSON.stringify(rejected.camera.getState()).includes('private-image'));
  for (const [code, expected] of [['TIMEOUT', 'ANALYSIS_TIMEOUT'], ['INVALID_RESPONSE', 'INVALID_RESPONSE'], ['ABORTED', 'ANALYSIS_FAILED']]) {
    const state = setup({ analyze: async () => { throw Object.assign(new Error('private-image-diagnostic'), { code }); } });
    await state.camera.open(); assert.equal(await state.camera.analyze(), null);
    assert.equal(state.camera.getState().error.code, expected);
  }
  for (const invalid of [age(NaN), age(-1), age(121), age(2.5), {}, { ...age(), isSenior: 1 }]) {
    const state = setup({ analyze: async () => invalid }); await state.camera.open();
    assert.equal(await state.camera.analyze(), null); assert.equal(state.camera.getState().error.code, 'INVALID_RESPONSE');
  }
  const zero = setup({ analyze: async () => ({ estimatedAge: 0, ageGroup: 'child', isSenior: false, privateExtra: 'discard' }) });
  await zero.camera.open(); assert.deepEqual(await zero.camera.analyze(), { estimatedAge: 0, ageGroup: 'child', isSenior: false });
  assert.equal(zero.camera.getState().phase, 'success');
});

test('상태 observer에서 취소해도 업로드·결과 콜백을 시작하지 않고 자원을 정리한다', async () => {
  let camera; let uploads = 0; const results = [];
  const source = stream(); const video = { srcObject: null, play: async () => {}, pause() {}, videoWidth: 10, videoHeight: 10 };
  camera = createAgeCamera({ mediaDevices: { getUserMedia: async () => source }, getVideo: () => video,
    onState: (state) => { if (state.phase === 'preview') camera.cancel(); },
    analyze: async () => { uploads += 1; return age(); }, onResult: (result) => results.push(result) });
  assert.equal(await camera.open(), false); assert.equal(camera.getState().phase, 'idle');
  assert.equal(source.track.stops, 1); assert.equal(uploads, 0); assert.deepEqual(results, []);
});

test('microtask 사이 취소는 새로운 권한·play 동작을 시작하지 않고 거절된 Promise도 소비한다', async () => {
  let camera; let permissions = 0; let plays = 0;
  camera = createAgeCamera({ mediaDevices: () => {
    camera.cancel(); return { getUserMedia: async () => { permissions += 1; return stream(); } };
  } });
  assert.equal(await camera.open(), false); assert.equal(permissions, 0);

  const source = stream(); const video = { srcObject: null, play: async () => { plays += 1; }, pause() {} };
  Object.defineProperty(video, 'muted', { set() { camera.cancel(); } });
  camera = createAgeCamera({ getVideo: () => video, mediaDevices: { getUserMedia: async () => source } });
  assert.equal(await camera.open(), false); assert.equal(plays, 0); assert.equal(source.track.stops, 1);
  assert.equal(video.srcObject, null);
  await new Promise((resolve) => setImmediate(resolve));

  const state = setup({ createCanvas: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage() {}, clearRect() {} }),
    toBlob() { state.camera.cancel(); throw new Error('late capture rejection'); },
  }) });
  await state.camera.open(); assert.equal(await state.camera.analyze(), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.camera.getState().phase, 'idle'); assert.equal(state.uploads.length, 0);
});

test('getVideo에서 취소되면 확보한 트랙을 중지하고 분리된 화면에 영상을 다시 붙이지 않는다', async () => {
  let camera; const source = stream(); const video = { srcObject: null, plays: 0, play() { this.plays += 1; } };
  camera = createAgeCamera({ getVideo: () => { camera.cancel(); return video; }, mediaDevices: { getUserMedia: async () => source } });
  assert.equal(await camera.open(), false); assert.equal(video.srcObject, null); assert.equal(video.plays, 0); assert.equal(source.track.stops, 1);
});
