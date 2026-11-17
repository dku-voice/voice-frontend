import test from 'node:test';
import assert from 'node:assert/strict';
import { koreaToday } from '../src/integration/date.js';

test('UTC 오후 3시의 한국 자정에 다음 날짜로 바뀐다', () => {
  assert.equal(koreaToday(Date.parse('2026-11-14T14:59:59.999Z')), '2026-11-14');
  assert.equal(koreaToday(Date.parse('2026-11-14T15:00:00.000Z')), '2026-11-15');
});

test('한국 새벽에는 UTC의 전날이 아닌 한국의 오늘을 반환한다', () => {
  const instant = Date.parse('2026-11-14T19:00:00.000Z');
  assert.equal(new Date(instant).toISOString().slice(0, 10), '2026-11-14');
  assert.equal(koreaToday(instant), '2026-11-15');
  assert.equal(koreaToday(Date.parse('2026-11-15T00:00:00.000Z')), '2026-11-15');
});

test('한국 시간 기준 연말과 윤년 월말도 YYYY-MM-DD 형식으로 처리한다', () => {
  assert.equal(koreaToday(Date.parse('2026-12-31T15:00:00.000Z')), '2027-01-01');
  assert.equal(koreaToday(Date.parse('2028-02-28T15:00:00.000Z')), '2028-02-29');
});
