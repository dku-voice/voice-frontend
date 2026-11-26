import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translate } from '../src/i18n/index.js';

const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('주문 중에만 처음으로 버튼이 보이고 결제 중에는 누를 수 없다', () => {
  assert.match(source, /kioskStage !== 'welcome' && currentScreen !== 'complete' && \(\s*<button className="back-to-start" disabled=\{checkoutBusy\} onClick=\{requestLeaveToStart\}>처음으로<\/button>/);
});

test('장바구니가 있으면 확인을 받고, 돌아가면 장바구니를 비운다', () => {
  const request = source.slice(source.indexOf('const requestLeaveToStart'), source.indexOf('const chooseTouchOrder'));
  assert.match(request, /if \(cartRef\.current\.length\) setConfirmLeave\(true\);\s*else leaveToStart\(\);/);
  const leave = source.slice(source.indexOf('const leaveToStart'), source.indexOf('const requestLeaveToStart'));
  assert.match(leave, /if \(paymentBusyRef\.current\) return;/);
  assert.match(leave, /setCart\(\[\]\);\s*returnToWelcome\(\);/);
});

test('처음으로 확인 문구가 모든 언어로 번역된다', () => {
  for (const text of ['처음으로 돌아갈까요?', '장바구니에 담은 메뉴가 모두 지워져요.', '계속 주문하기']) {
    for (const language of ['en', 'ja', 'es', 'th']) assert.notEqual(translate(text, language), text, `${text} ${language}`);
  }
});
