import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { messages } from '../src/i18n/messages.js';
import { translate, formatMoney, readLanguage, storeLanguage, localeFor, orderSummary } from '../src/i18n/index.js';
import { localizeTree } from '../src/i18n/react.js';

test('모든 번역 키는 일본어·스페인어·태국어 값과 동일한 보간 변수를 갖는다', () => {
  for (const [key, translations] of Object.entries(messages)) {
    const tokens = (value) => [...value.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
    for (const language of ['ja', 'es', 'th']) {
      assert.equal(typeof translations[language], 'string', `${language}: ${key}`);
      assert(translations[language].length);
      assert.deepEqual(tokens(translations[language]), tokens(key));
    }
  }
});

test('공개 메뉴 스냅샷의 상품·옵션·분류·알레르기 이름을 번역하며 원본 응답을 보존한다', async () => {
  const menus = JSON.parse(await readFile(new URL('./fixtures/menus-2026-11-19.json', import.meta.url)));
  const before = structuredClone(menus);
  for (const menu of menus) {
    for (const value of [menu.nameKo, menu.categoryNameKo, ...menu.allergensKo, ...menu.options.map((o) => o.nameKo)]) {
      for (const language of ['ja', 'es', 'th']) assert.notEqual(translate(value, language), value, `${language}: ${value}`);
    }
  }
  assert.deepEqual(menus, before);
});

test('동적 안내·오류·옵션 목록을 번역하고 미등록 문구와 잘못된 언어는 기본 문구를 유지한다', () => {
  assert.equal(translate('장바구니 3', 'es'), 'Carrito 3');
  assert.equal(translate('데리버거을 장바구니에 담았습니다.', 'es'), 'Se ha añadido Hamburguesa teriyaki al carrito.');
  assert.equal(translate('메뉴 서버: 서버 오류가 발생했습니다.', 'ja'), 'メニューサーバー: サーバーエラーが発生しました。');
  assert.equal(translate('치즈 추가, 양파 제거', 'es'), 'Añadir queso, Sin cebolla');
  assert(translate('서버 요청에 실패했습니다. (HTTP 500)', 'th').includes('500'));
  assert.equal(translate('신규 서버 메시지', 'es'), '신규 서버 메시지');
  assert.equal(translate('결제하기', 'xx'), '결제하기');
  assert.equal(translate('결제하기', 'ko'), '결제하기');
  assert.equal(translate(' / ', 'th'), ' / ');
});

test('가격은 환율 변환 없이 같은 KRW 금액을 포맷하고 KDS 표시만 번역한다', () => {
  assert.equal(formatMoney(2800, 'ko'), '2,800원');
  for (const language of ['ja', 'es', 'th']) {
    assert.equal(formatMoney(2800, language), new Intl.NumberFormat(localeFor(language), { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(2800));
  }
  const order = { items: [{ menuNameKo: '데리버거', quantity: 2, optionNames: ['치즈 추가'] }] };
  assert.equal(orderSummary(order, 'es'), 'Hamburguesa teriyaki 2 uds. (Añadir queso)');
  assert.equal(order.items[0].quantity, 2);
});

test('React 표시 번역은 이벤트·ref·입력 값·옵션 ID·SDK 컨테이너를 보존한다', () => {
  const handler = () => {};
  const ref = React.createRef();
  const input = React.createElement('input', { value: '관리자', onChange: handler, ref, placeholder: '아이디' });
  const option = React.createElement('option', { value: 'SOLD_OUT' }, '품절');
  const container = React.createElement('div', { id: 'payment-widget', ref });
  const [translatedInput, translatedOption, translatedContainer] = localizeTree([input, option, container], 'es');
  assert.equal(translatedInput.props.value, '관리자');
  assert.equal(translatedInput.props.onChange, handler);
  assert.equal(translatedInput.ref, ref);
  assert.equal(translatedInput.props.placeholder, 'Usuario');
  assert.equal(translatedOption.props.value, 'SOLD_OUT');
  assert.equal(translatedOption.props.children, 'Agotado');
  assert.equal(translatedContainer.props.id, 'payment-widget');
  assert.equal(translatedContainer.ref, ref);
});

test('언어 저장소가 막히거나 손상돼도 한국어로 시작하고 다른 저장소 키는 변경하지 않는다', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const stored = new Map([['unrelated', 'unchanged']]);
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) } });
    assert.equal(readLanguage(), 'ko');
    for (const language of ['ko', 'ja', 'es', 'th']) { storeLanguage(language); assert.equal(readLanguage(), language); }
    storeLanguage('invalid'); assert.equal(readLanguage(), 'th');
    assert.equal(stored.get('unrelated'), 'unchanged');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    assert.equal(readLanguage(), 'ko'); assert.doesNotThrow(() => storeLanguage('ja'));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
