import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoAgeMonitor } from '../src/integration/auto-age-monitor.js';
import { fakeClock } from './helpers/voice-clock.js';

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('자동 나이 분석은 한 번씩만 실행하고 성공 후 5초 간격으로 반복한다', async () => {
  const clock = fakeClock(); let opens = 0; let analyses = 0; let cancels = 0;
  const monitor = createAutoAgeMonitor({
    openCamera: async () => { opens += 1; return true; },
    analyzeCamera: async () => { analyses += 1; return { estimatedAge: 35 }; },
    cancelCamera: () => { cancels += 1; },
    schedule: clock.schedule,
    cancelSchedule: clock.cancel,
  });

  assert.equal(monitor.start(), true); assert.equal(monitor.start(), false); assert.equal(clock.count, 1);
  clock.tick(0); await flush();
  assert.equal(opens, 1); assert.equal(analyses, 1); assert.equal(clock.count, 1);
  clock.tick(4999); await flush(); assert.equal(analyses, 1);
  clock.tick(1); await flush(); assert.equal(opens, 2); assert.equal(analyses, 2);
  monitor.stop(); assert.equal(clock.count, 0); assert.equal(cancels, 1); assert.equal(monitor.active, false);
});

test('카메라 권한 거부는 자동 재요청하지 않고 다른 일시 오류만 제한 간격으로 재시도한다', async () => {
  const deniedClock = fakeClock(); let deniedOpens = 0;
  const denied = createAutoAgeMonitor({
    openCamera: async () => { deniedOpens += 1; return false; },
    analyzeCamera: async () => assert.fail('권한 거부 후 분석 금지'),
    cancelCamera() {},
    getCameraState: () => ({ error: { code: 'PERMISSION_DENIED' } }),
    schedule: deniedClock.schedule,
    cancelSchedule: deniedClock.cancel,
  });
  denied.start(); deniedClock.tick(0); await flush();
  assert.equal(deniedOpens, 1); assert.equal(deniedClock.count, 0); assert.equal(denied.active, false);

  const retryClock = fakeClock(); let retryOpens = 0;
  const retrying = createAutoAgeMonitor({
    openCamera: async () => { retryOpens += 1; return false; },
    cancelCamera() {},
    getCameraState: () => ({ error: { code: 'CAMERA_IN_USE' } }),
    schedule: retryClock.schedule,
    cancelSchedule: retryClock.cancel,
  });
  retrying.start(); retryClock.tick(0); await flush(); assert.equal(retryClock.count, 1);
  retryClock.tick(8000); await flush(); assert.equal(retryOpens, 2);
  retrying.stop();
});

test('화면 전환 중 취소하면 늦은 분석 결과가 새 타이머를 만들지 않는다', async () => {
  const clock = fakeClock(); const pending = deferred(); let analyses = 0; let cancels = 0;
  const monitor = createAutoAgeMonitor({
    openCamera: async () => true,
    analyzeCamera: () => { analyses += 1; return pending.promise; },
    cancelCamera: () => { cancels += 1; },
    schedule: clock.schedule,
    cancelSchedule: clock.cancel,
  });
  monitor.start(); clock.tick(0); await flush(); assert.equal(analyses, 1);
  monitor.stop(); pending.resolve({ estimatedAge: 77 }); await flush();
  assert.equal(cancels, 1); assert.equal(clock.count, 0); assert.equal(monitor.active, false);
});
