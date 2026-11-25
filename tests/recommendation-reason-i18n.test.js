import test from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../src/i18n/index.js';

test('규칙 기반 추천 이유는 화면 언어로 번역된다', () => {
  assert.equal(translate("'산뜻함' 특징이 있는 메뉴입니다.", 'ja'), '「さっぱり」の特徴があるメニューです。');
  assert.equal(translate('지방 수치가 높은 순으로 골랐습니다. (35g)', 'es'), 'Elegido por mayor grasa. (35g)');
  assert.equal(translate('가격이 낮은 순으로 골랐습니다. (2,100원)', 'th'), 'เลือกตามราคาที่ต่ำที่สุด (2,100 วอน)');
  assert.equal(translate('대표 메뉴입니다.', 'ja'), '看板メニューです。');
  assert.equal(translate('현재 메뉴 문서에서 추천 후보로 선택했습니다.', 'es'), 'Seleccionado entre los productos disponibles.');
});

test('한국어 화면에서는 추천 이유를 바꾸지 않는다', () => {
  assert.equal(translate("'매콤함' 특징이 있는 메뉴입니다.", 'ko'), "'매콤함' 특징이 있는 메뉴입니다.");
});
