import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMenus } from '../src/domain/kiosk.js';
import { isVoiceOrderResponse, normalizeVoiceOrderResponse, voiceMenuMappings } from '../src/integration/voice-order.js';

const menus = normalizeMenus([
  { menuId: 4, nameKo: '클래식 치즈버거', nameEn: 'Classic Cheese Burger', price: 5200, status: 'ACTIVE', categoryNameKo: '버거',
    options: [{ optionId: 4, nameKo: '치즈 추가', nameEn: 'Add Cheese', optionType: 'ADD', extraPrice: 500 }] },
  { menuId: 10, nameKo: '감자튀김', nameEn: 'French Fries', price: 2200, status: 'ACTIVE', categoryNameKo: '사이드', options: [] },
  { menuId: 14, nameKo: '콜라', nameEn: 'Cola', price: 2100, status: 'ACTIVE', categoryNameKo: '음료', options: [] },
  { menuId: 17, nameKo: '오렌지 주스', nameEn: 'Orange Juice', price: 2500, status: 'ACTIVE', categoryNameKo: '음료', options: [] },
]);

test('새 AI 응답은 문자열 menu_id를 현재 백엔드 숫자 menuId로 바꾸고 수량·옵션을 보존한다', () => {
  const raw = { status: 'success', recognized_text: '클래식 버거 두 개 치즈 추가',
    items: [{ menu_id: 'classic-burger', quantity: 2, options: ['치즈 추가'] }], error_msg: null, language: 'ko' };
  assert.equal(isVoiceOrderResponse(raw), true);
  assert.deepEqual(normalizeVoiceOrderResponse(raw, menus), {
    status: 'success', recognizedText: raw.recognized_text,
    items: [{ menuId: 4, quantity: 2, optionIds: [4] }], failed: false,
  });
  const cola = normalizeVoiceOrderResponse({ ...raw, language: 'es', recognized_text: 'dos colas',
    items: [{ menu_id: 'cola_01', quantity: 2, options: [] }] }, menus);
  assert.deepEqual(cola.items, [{ menuId: 14, quantity: 2, optionIds: [] }]);
});

test('숫자 문자열 menu_id는 같은 백엔드 menuId에 직접 매칭하고 존재하지 않는 ID는 거부한다', () => {
  const raw = { status: 'success', recognized_text: '음료 주문', error_msg: null, language: 'ko' };
  const result = normalizeVoiceOrderResponse({ ...raw, items: [
    { menu_id: '14', quantity: 1, options: [] },
    { menu_id: '17', quantity: 2, options: [] },
  ] }, menus);

  assert.deepEqual(result.items, [
    { menuId: 14, quantity: 1, optionIds: [] },
    { menuId: 17, quantity: 2, optionIds: [] },
  ]);
  assert.throws(
    () => normalizeVoiceOrderResponse({ ...raw, items: [{ menu_id: '999', quantity: 1, options: [] }] }, menus),
    /현재 서버 메뉴/,
  );
});

test('새 AI 응답의 오류·빈 주문은 안전하게 반환하고 잘못된 계약이나 미확정 매핑은 거부한다', () => {
  const failed = normalizeVoiceOrderResponse({ status: 'error', recognized_text: '', items: [], error_msg: 'internal', language: 'th' }, menus);
  assert.deepEqual(failed, { status: 'error', recognizedText: '', items: [], failed: true });
  const empty = normalizeVoiceOrderResponse({ status: 'fallback', recognized_text: '다시 말씀해 주세요', items: [], error_msg: null, language: 'ko' }, menus);
  assert.equal(empty.failed, false); assert.deepEqual(empty.items, []);
  const base = { status: 'success', recognized_text: '주문', error_msg: null, language: 'ja' };
  assert.throws(() => normalizeVoiceOrderResponse({ ...base, items: [{ menu_id: 'unknown-menu', quantity: 1, options: [] }] }, menus), /매핑/);
  assert.throws(() => normalizeVoiceOrderResponse({ ...base, items: [{ menu_id: 'cola_01', quantity: 0, options: [] }] }, menus), /형식/);
  assert.throws(() => normalizeVoiceOrderResponse({ ...base, language: 'en', items: [] }, menus), /응답 형식/);
  assert.throws(() => normalizeVoiceOrderResponse({ ...base, items: [{ menu_id: 'classic-burger', quantity: 1, options: ['없는 옵션'] }] }, menus), /옵션/);
  assert.equal(Object.hasOwn(voiceMenuMappings(), 'burger_01'), false, 'ambiguous AI IDs must not be guessed');
});
