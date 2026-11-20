import test from 'node:test';
import assert from 'node:assert/strict';
import { AGE_ANALYSIS_PATH, createAgeAnalysisApi } from '../src/api/vision.js';

const image = () => new Blob(['fake-image-for-mocked-fetch-only'], { type: 'image/jpeg' });
const result = (override = {}) => ({ status: 'success', estimated_age: 72, age_group: 'senior', is_senior: true, error_msg: null, ...override });
const response = (body = result(), status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };

test('배포 명세의 POST와 multipart file만 보내며 JSON envelope·Bearer·수동 Content-Type을 사용하지 않는다', async () => {
  let calls = 0;
  const input = image();
  const api = createAgeAnalysisApi({ fetchImpl: async (path, options) => {
    calls += 1;
    assert.equal(path, '/ai/api/vision/analyze_age'); assert.equal(path, AGE_ANALYSIS_PATH);
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert(options.body instanceof FormData);
    assert.deepEqual([...options.body.keys()], ['file']);
    const uploaded = options.body.get('file');
    assert.equal(uploaded.name, 'age-capture.jpg'); assert.equal(uploaded.type, 'image/jpeg');
    assert.equal(await uploaded.text(), await input.text());
    assert.equal(options.signal.aborted, false);
    return response();
  } });
  assert.deepEqual(await api.analyze(input), { estimatedAge: 72, ageGroup: 'senior', isSenior: true });
  assert.equal(calls, 1);
});

test('성공 응답의 선택 필드는 명세 기본값으로만 채우고 나이 기반 모드 규칙을 만들지 않는다', async () => {
  for (const age of [0, 35, 120]) {
    const api = createAgeAnalysisApi({ fetchImpl: async () => response({ status: 'success', estimated_age: age }) });
    assert.deepEqual(await api.analyze(image()), { estimatedAge: age, ageGroup: 'unknown', isSenior: false });
  }
  const api = createAgeAnalysisApi({ fetchImpl: async () => response(result({ estimated_age: 35, age_group: 'senior', is_senior: true })) });
  assert.deepEqual(await api.analyze(image()), { estimatedAge: 35, ageGroup: 'senior', isSenior: true });
});

test('HTTP 200의 status:error도 실패로 처리하고 원시 모델 오류나 얼굴 관련 데이터를 오류 객체에 남기지 않는다', async () => {
  const privateText = 'private-face-details/internal-model-path';
  const api = createAgeAnalysisApi({ fetchImpl: async () => response({ status: 'error', estimated_age: null,
    age_group: 'unknown', is_senior: false, error_msg: privateText }) });
  await assert.rejects(api.analyze(image()), (error) => {
    assert.equal(error.code, 'ANALYSIS_FAILED');
    assert(!error.message.includes('얼굴을 찾')); // no fabricated cause
    assert(!error.message.includes(privateText)); assert(!JSON.stringify(error).includes(privateText));
    assert.equal(error.requestPath, AGE_ANALYSIS_PATH); assert.equal(error.requestMethod, 'POST');
    assert.equal(error.body, undefined); assert.equal(error.cause, undefined);
    return true;
  });
});

test('명세상 허용된 null·누락 나이는 형식 오류나 임의 나이 대신 분석 결과 없음으로 처리한다', async () => {
  for (const body of [{ status: 'success' }, result({ estimated_age: null })]) {
    await assert.rejects(createAgeAnalysisApi({ fetchImpl: async () => response(body) }).analyze(image()), code('ANALYSIS_FAILED'));
  }
});

test('잘못된 나이·분류·플래그·envelope·HTML·깨진 JSON 응답을 성공으로 오인하지 않는다', async () => {
  const invalid = [null, [], {}, { success: true, data: result() }, result({ status: 'pending' }),
    result({ estimated_age: '72' }), result({ estimated_age: 3.5 }),
    result({ estimated_age: -1 }), result({ estimated_age: 121 }),
    result({ age_group: 'other' }), result({ age_group: null }), result({ is_senior: 'true' }), result({ is_senior: null })];
  for (const body of invalid) {
    await assert.rejects(createAgeAnalysisApi({ fetchImpl: async () => response(body) }).analyze(image()), code('INVALID_RESPONSE'));
  }
  for (const type of ['text/html', 'application/json']) {
    const api = createAgeAnalysisApi({ fetchImpl: async () => new Response('<html>not JSON</html>', { headers: { 'Content-Type': type } }) });
    await assert.rejects(api.analyze(image()), code('INVALID_RESPONSE'));
  }
  const overflow = createAgeAnalysisApi({ fetchImpl: async () => new Response('{"status":"success","estimated_age":1e400}',
    { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(overflow.analyze(image()), code('INVALID_RESPONSE'));
});

test('HTTP 오류는 상태만 남기고 세션 만료나 분석 성공으로 바꾸거나 재시도하지 않는다', async () => {
  for (const status of [401, 403, 404, 413, 422, 500, 503]) {
    let calls = 0;
    const api = createAgeAnalysisApi({ fetchImpl: async () => { calls += 1; return response({ detail: 'private server detail' }, status); } });
    await assert.rejects(api.analyze(image()), (error) => {
      assert.equal(error.code, 'HTTP_ERROR'); assert.equal(error.status, status);
      assert(!error.message.includes('로그인')); assert(!error.message.includes('private'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('빈 파일·과대 파일·지원하지 않는 MIME은 전송하지 않고 JPEG/PNG/WebP만 허용한다', async () => {
  let calls = 0;
  const api = createAgeAnalysisApi({ fetchImpl: async () => { calls += 1; return response(); } });
  for (const value of [null, {}, 'image', new Blob([], { type: 'image/jpeg' }), new Blob(['x'], { type: 'image/gif' }),
    new Blob(['x']), new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/jpeg' })]) {
    await assert.rejects(api.analyze(value), code('INVALID_IMAGE'));
  }
  assert.equal(calls, 0);
  for (const type of ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']) await api.analyze(new Blob(['x'], { type }));
  assert.equal(calls, 4);
});

test('이미 중단된 signal은 업로드하지 않고 진행 중 취소는 fetch를 중단하며 늦은 응답을 적용하지 않는다', async () => {
  let calls = 0; let finishFetch; let requestSignal;
  const api = createAgeAnalysisApi({ fetchImpl: (_path, options) => {
    calls += 1; requestSignal = options.signal; return new Promise((resolve) => { finishFetch = resolve; });
  } });
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(api.analyze(image(), { signal: canceled.signal }), code('ABORTED')); assert.equal(calls, 0);
  const controller = new AbortController(); const pending = api.analyze(image(), { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, code('ABORTED')); assert.equal(requestSignal.aborted, true);
  finishFetch(response()); await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(calls, 1);
});

test('타임아웃은 fetch와 응답 본문 소비까지 포함하며 취소 불가능한 모의 응답도 무시한다', async () => {
  let requestSignal; let finishFetch;
  const fetchApi = createAgeAnalysisApi({ timeoutMs: 5, fetchImpl: (_path, options) => {
    requestSignal = options.signal; return new Promise((resolve) => { finishFetch = resolve; });
  } });
  await assert.rejects(fetchApi.analyze(image()), code('TIMEOUT')); assert.equal(requestSignal.aborted, true);
  finishFetch(response());
  let finishBody;
  const bodyApi = createAgeAnalysisApi({ timeoutMs: 5, fetchImpl: async (_path, options) => {
    requestSignal = options.signal;
    return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () => new Promise((resolve) => { finishBody = resolve; }) };
  } });
  await assert.rejects(bodyApi.analyze(image()), code('TIMEOUT')); assert.equal(requestSignal.aborted, true);
  finishBody(result()); await new Promise((resolve) => setTimeout(resolve, 0));
});

test('사용자 취소·네트워크 실패의 내부 원인을 노출하지 않고 정상 완료 뒤 abort는 아무 영향이 없다', async () => {
  const networkApi = createAgeAnalysisApi({ fetchImpl: async () => { throw new Error('private-network-detail'); } });
  await assert.rejects(networkApi.analyze(image()), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR'); assert(!JSON.stringify(error).includes('private-network-detail')); return true;
  });
  const abortApi = createAgeAnalysisApi({ fetchImpl: async () => { throw Object.assign(new Error('native abort'), { name: 'AbortError' }); } });
  await assert.rejects(abortApi.analyze(image()), code('ABORTED'));
  const controller = new AbortController();
  const api = createAgeAnalysisApi({ fetchImpl: async () => response() });
  assert.deepEqual(await api.analyze(image(), { signal: controller.signal }), { estimatedAge: 72, ageGroup: 'senior', isSenior: true });
  controller.abort();
});
