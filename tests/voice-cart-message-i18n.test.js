import test from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../src/i18n/index.js';

const spoken = '데리버거 2개, 치즈스틱 1개, 콜라 3개를 장바구니에 담았습니다.';

test('음성 주문 담기 안내는 선택한 언어로 읽힌다', () => {
  assert.equal(translate(spoken, 'ja'), 'テリバーガー2個, チーズスティック1個, コーラ3個をカートに追加しました。');
  assert.equal(translate(spoken, 'es'), 'Se ha añadido al carrito: 2 Hamburguesa teriyaki, 1 Palitos de queso, 3 Refresco de cola.');
  assert.equal(translate(spoken, 'th'), 'เพิ่ม เบอร์เกอร์เทอริยากิ 2 ชิ้น, ชีสสติ๊ก 1 ชิ้น, โคล่า 3 ชิ้น ลงตะกร้าแล้ว');
});

test('한 개만 담아도 번역된다', () => {
  assert.equal(translate('불고기버거 1개를 장바구니에 담았습니다.', 'ja'), 'プルコギバーガー1個をカートに追加しました。');
});

test('숫자 자리에는 숫자만 맞춘다', () => {
  assert.equal(translate('장바구니 3', 'ja'), 'カート 3');
  assert.equal(translate('25세', 'es'), '25 años');
});
