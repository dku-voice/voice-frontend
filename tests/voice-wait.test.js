import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceWait, hasVoiceActivity, SPEECH_PAUSE_MS, waitForVoiceSocket, receiveVoiceMessage } from '../src/integration/voice-language.js';

import { fakeClock } from './helpers/voice-clock.js';

const loud = () => new Int16Array(8192).fill(3000).buffer;
const blip = () => new Int16Array(2048).fill(3000).buffer;
const silence = () => new Int16Array(4096).buffer;
const setup = () => {
  const clock = fakeClock(); const events = [];
  const wait = createVoiceWait({ ...clock, onRecording: () => events.push('recording'), onWaiting: () => events.push('waiting'),
    onPending: () => events.push('pending'), onTouch: (event) => events.push(event), onTimeout: () => events.push('timeout') });
  return { clock, events, wait };
};

test('로컬 PCM 활동 판단은 원본 바이트를 변경하지 않고 유효하지 않은 프레임은 무음으로 취급한다', () => {
  const input = loud(); const copy = input.slice(0);
  assert.equal(hasVoiceActivity(input), true); assert.deepEqual(input, copy);
  assert.equal(hasVoiceActivity(new Int16Array(input)), true);
  for (const value of [null, {}, new ArrayBuffer(1), new ArrayBuffer(0), silence()]) assert.equal(hasVoiceActivity(value), false);
});

test('발화가 계속되는 동안에는 처리 대기 시간을 세지 않고 800ms 무음 뒤부터 5초를 센다', () => {
  const { clock, events, wait } = setup();
  for (let index = 0; index < 80; index += 1) { wait.audio(loud(), 'ko'); clock.tick(250); }
  assert.deepEqual(events, ['recording']); assert.equal(clock.count, 1); assert.equal(wait.phase, 'recording');
  clock.tick(SPEECH_PAUSE_MS - 250); assert.equal(wait.phase, 'waiting');
  clock.tick(4999); assert(!events.some((event) => event?.deadline));
  clock.tick(1); assert.deepEqual(events.at(-1), { language: 'ko', deadline: 5000 });
  assert.equal(wait.waiting, true, 'Korean touch offer must not discard a late foreign result');
  clock.tick(7000); assert.equal(wait.expired, true); assert.equal(events.at(-1), 'timeout'); assert.equal(clock.count, 0);
});

test('실제 발화가 끝나면 END 콜백을 한 번만 실행하고 초기 무음만으로는 실행하지 않는다', () => {
  const clock = fakeClock(); let ended = 0;
  const wait = createVoiceWait({ ...clock, onPending: () => {}, onTouch: () => {}, onUtteranceEnd: () => { ended += 1; } });
  wait.audio(silence(), 'ko'); clock.tick(SPEECH_PAUSE_MS * 2); assert.equal(ended, 0);
  wait.finish(); wait.audio(loud(), 'ja'); clock.tick(SPEECH_PAUSE_MS - 1); assert.equal(ended, 0);
  clock.tick(1); assert.equal(ended, 1);
  wait.audio(silence(), 'ja'); clock.tick(2000); assert.equal(ended, 1);
});

test('0.3초보다 짧은 소리는 발화로 보지 않아 END를 보내지 않는다', () => {
  const clock = fakeClock(); let ended = 0;
  const wait = createVoiceWait({ ...clock, onPending: () => {}, onTouch: () => {}, onUtteranceEnd: () => { ended += 1; } });
  wait.audio(blip(), 'ja'); clock.tick(SPEECH_PAUSE_MS * 2); assert.equal(ended, 0);
  wait.audio(loud(), 'ja'); clock.tick(SPEECH_PAUSE_MS); assert.equal(ended, 1);
});

test('일본어·스페인어·태국어 선택은 12초를 적용하고 6~9초 정상 응답은 종료로 처리한다', () => {
  for (const language of ['ja', 'es', 'th']) {
    for (const delay of [6000, 9000]) {
      const { clock, events, wait } = setup();
      wait.audio(loud(), language); clock.tick(SPEECH_PAUSE_MS); wait.audio(silence(), language);
      clock.tick(delay); assert(!events.some((event) => event?.deadline || event === 'timeout'));
      wait.finish(); clock.tick(20000); assert.equal(clock.count, 0); assert(!events.includes('timeout'));
    }
    const { clock, events, wait } = setup(); wait.start(language);
    clock.tick(11999); assert(!events.some((event) => event?.deadline));
    clock.tick(1); assert.deepEqual(events.at(-2), { language, deadline: 12000 }); assert.equal(events.at(-1), 'timeout');
  }
});

test('언어 미확인·누락·잘못된 값은 한국어 화면이어도 5초로 추측하지 않고 12초까지 기다린다', () => {
  for (const language of [undefined, null, '', 'en', 0, {}]) {
    const { clock, events, wait } = setup(); wait.audio(silence(), language);
    clock.tick(9000); assert.equal(wait.waiting, true); assert(!events.some((event) => event?.deadline));
    clock.tick(3000); assert.equal(wait.expired, true); assert.equal(events.at(-1), 'timeout');
    wait.audio(loud(), 'ja'); assert.equal(wait.expired, true, 'new frames cannot silently revive an expired request');
  }
});

test('대기 중 언어 변경과 반복 PCM은 최대 기한을 연장하지 않고 예약 타이머를 누적하지 않는다', () => {
  const { clock, events, wait } = setup(); wait.start('ko');
  clock.tick(4000); wait.changeLanguage('ja'); assert(clock.count <= 2);
  clock.tick(1000); assert(!events.some((event) => event?.deadline));
  for (let index = 0; index < 200; index += 1) { wait.changeLanguage(index % 2 ? 'es' : 'th'); wait.audio(silence(), 'th'); }
  assert(clock.count <= 2); clock.tick(6999); assert(!events.includes('timeout'));
  clock.tick(1); assert.equal(events.filter((event) => event === 'timeout').length, 1); assert.equal(clock.count, 0);
});

test('유효한 language 메타데이터는 현재 언어가 같아도 대기 기준에 반영하며 결과 완료로 오인하지 않는다', () => {
  const { clock, events, wait } = setup(); wait.start(null); clock.tick(1000);
  const raw = { language: 'ko' };
  assert.deepEqual(receiveVoiceMessage(JSON.stringify(raw), { voiceActive: true, currentLanguage: 'ko',
    onLanguage: () => assert.fail('same language needs no UI change'), onLanguageDetected: (language) => wait.changeLanguage(language) }), raw);
  assert.equal(wait.waiting, true);
  clock.tick(3999); assert(!events.some((event) => event?.deadline));
  clock.tick(1); assert.deepEqual(events.at(-1), { language: 'ko', deadline: 5000 });
  clock.tick(4000); assert.equal(wait.waiting, true, '9s result must still be accepted after a 5s offer');
  wait.finish(); assert.equal(clock.count, 0);
});

test('취소·재시작과 오래된 콜백은 새 대기 상태를 만지지 못하고 다시 말하면 녹음 단계로 돌아간다', () => {
  const { clock, events, wait } = setup(); wait.start('ko'); const stale = [...clock.callbacks];
  clock.tick(4000); wait.finish(); wait.start('th'); const before = [...events];
  stale.forEach((callback) => callback()); assert.deepEqual(events, before);
  clock.tick(4000); wait.audio(loud(), 'th'); assert.equal(wait.phase, 'recording');
  clock.tick(SPEECH_PAUSE_MS); assert.equal(wait.phase, 'waiting');
  wait.finish(); clock.tick(60000); assert(!events.includes('timeout')); assert.equal(clock.count, 0);
});

class Socket extends EventTarget {
  readyState = 0;
}
test('재시도 연결 대기는 open 성공·실패·닫힘·중단을 처리하고 인식 타이머와 분리한다', async () => {
  const opened = new Socket(); const waiting = waitForVoiceSocket(opened);
  opened.readyState = 1; opened.dispatchEvent(new Event('open')); await waiting;
  await waitForVoiceSocket(opened);
  for (const event of ['error', 'close']) {
    const socket = new Socket(); const failed = waitForVoiceSocket(socket);
    socket.dispatchEvent(new Event(event)); await assert.rejects(failed, /AI 서버 연결/);
  }
  const aborted = new AbortController(); const socket = new Socket();
  const canceled = waitForVoiceSocket(socket, { signal: aborted.signal }); aborted.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  await assert.rejects(waitForVoiceSocket(new Socket(), { signal: aborted.signal }), { name: 'AbortError' });
  const closed = new Socket(); closed.readyState = 3;
  await assert.rejects(waitForVoiceSocket(closed), /AI 서버 연결/);
  await assert.rejects(waitForVoiceSocket(new Socket(), { timeoutMs: 5 }), /AI 서버 연결/);
});
