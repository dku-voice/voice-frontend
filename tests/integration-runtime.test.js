import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeConfig, resolveWebSocketUrl } from '../src/integration/runtime.js';

const securePage = { protocol: 'https:', host: 'dku-voice.com', origin: 'https://dku-voice.com' };
const localPage = { protocol: 'http:', host: 'localhost:5173', origin: 'http://localhost:5173' };

test('배포 기본값은 같은 출처 API와 현재 호스트 WSS를 사용하고 미확정 사진 API를 비워 둔다', () => {
  assert.deepEqual(createRuntimeConfig({ location: securePage }), {
    apiBaseUrl: '', aiWsUrl: 'wss://dku-voice.com/ws/audio',
    storeId: 'store-default', aiSnapshotUrl: '',
  });
});

test('로컬 개발에서는 현재 포트를 보존하고 명시한 WS 서버도 사용할 수 있다', () => {
  assert.equal(createRuntimeConfig({ location: localPage }).aiWsUrl, 'ws://localhost:5173/ws/audio');
  assert.equal(resolveWebSocketUrl('ws://localhost:8000/ws/audio', localPage), 'ws://localhost:8000/ws/audio');
});

test('HTTP 계열 환경변수와 상대경로를 올바른 WebSocket 프로토콜로 변환한다', () => {
  assert.equal(resolveWebSocketUrl('https://voice.example.test/ws/audio', securePage), 'wss://voice.example.test/ws/audio');
  assert.equal(resolveWebSocketUrl('http://localhost:8000/ws/audio', localPage), 'ws://localhost:8000/ws/audio');
  assert.equal(resolveWebSocketUrl('/voice/socket', securePage), 'wss://dku-voice.com/voice/socket');
  assert.equal(resolveWebSocketUrl('//voice.example.test/ws/audio', securePage), 'wss://voice.example.test/ws/audio');
});

test('HTTPS 페이지에서는 명시적인 WS와 HTTP 음성 주소를 거부한다', () => {
  for (const address of ['ws://voice.example.test/ws/audio', 'http://voice.example.test/ws/audio']) {
    assert.throws(() => resolveWebSocketUrl(address, securePage), /WSS/);
  }
});

test('API 주소 끝 슬래시를 제거하고 사진 전송은 명시한 경로만 사용한다', () => {
  const config = createRuntimeConfig({
    env: { VITE_API_BASE_URL: ' https://backend.example.test/// ', VITE_STORE_ID: ' store-seoul ', VITE_AI_SNAPSHOT_URL: '/legacy/snapshot' },
    location: securePage,
  });
  assert.equal(config.apiBaseUrl, 'https://backend.example.test');
  assert.equal(config.storeId, 'store-seoul');
  assert.equal(config.aiSnapshotUrl, '/legacy/snapshot');
});

test('혼합 콘텐츠 API와 사진 주소, 잘못된 WebSocket 주소를 거부한다', () => {
  assert.throws(() => createRuntimeConfig({ env: { VITE_API_BASE_URL: 'http://backend.example.test' }, location: securePage }), /HTTPS/);
  assert.throws(() => createRuntimeConfig({ env: { VITE_AI_SNAPSHOT_URL: 'http://ai.example.test/snapshot' }, location: securePage }), /HTTPS/);
  for (const address of ['javascript:alert(1)', 'ftp://voice.example.test/ws', 'wss://name:secret@voice.example.test/ws', 'wss://voice.example.test/ws#fragment']) {
    assert.throws(() => resolveWebSocketUrl(address, securePage), /주소 형식/);
  }
});

test('브라우저 위치가 없는 테스트 환경에서도 네트워크 요청 없이 설정을 읽는다', () => {
  assert.deepEqual(createRuntimeConfig({ location: undefined }), {
    apiBaseUrl: '', aiWsUrl: '', storeId: 'store-default', aiSnapshotUrl: '',
  });
});
