import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceLanguageGuard, receiveVoiceMessage } from '../src/integration/voice-language.js';
import { normalizeMenus, createCartItem, addCartItem, buildOrderBody } from '../src/domain/kiosk.js';

function harness(initialLanguage = 'ko') {
  const guard = createVoiceLanguageGuard();
  const socket = {};
  let language = initialLanguage;
  let active = false;
  return {
    guard, socket,
    start() { active = true; guard.startSession(); },
    stop() { active = false; guard.stopSession(); },
    audio() { guard.audioSent(socket); },
    select(next) { guard.manualSelection(); language = next; },
    receive(data) {
      return receiveVoiceMessage(JSON.stringify(data), { voiceActive: active, currentLanguage: language,
        onLanguage: (next) => { language = next; }, canApplyLanguage: () => guard.acceptResponse(socket) });
    },
    get language() { return language; },
  };
}

test('실제 음성을 보낸 현재 세션에서만 4개 지원 언어를 적용하며 언어 관리 상태는 재사용한다', () => {
  for (const language of ['ko', 'ja', 'es', 'th']) {
    const flow = harness(language === 'ko' ? 'th' : 'ko');
    flow.start();
    flow.receive({ language });
    assert.notEqual(flow.language, language, 'audio not sent yet');
    flow.audio(); flow.receive({ type: 'order', item: { menuId: 1 }, language });
    assert.equal(flow.language, language);
  }
});

test('수동 선택 전 요청의 늦은 언어는 무시하고 기존 주문 payload는 그대로 반환한다', () => {
  const flow = harness(); flow.start(); flow.audio(); flow.select('es');
  flow.audio(); // continuing PCM must not relabel the older outstanding window
  const order = { type: 'order', item: { menuId: 1, quantity: 3, optionIds: [10] }, language: 'ja' };
  assert.deepEqual(flow.receive(order), order);
  assert.equal(flow.language, 'es');
  flow.audio(); flow.receive({ type: 'order', item: { menuId: 1 }, language: 'th' });
  assert.equal(flow.language, 'th', 'a subsequent voice window may override the manual choice');
});

test('현재 언어 버튼을 다시 선택해도 이전 응답의 언어 덮어쓰기를 막는다', () => {
  const flow = harness('ja'); flow.start(); flow.audio(); flow.select('ja');
  flow.receive({ type: 'order', item: { menuId: 1 }, language: 'ko' });
  assert.equal(flow.language, 'ja');
});

test('음성 종료와 재시작 이후에도 이전 미확정 응답은 새 세션의 언어로 취급하지 않는다', () => {
  const flow = harness(); flow.start(); flow.audio(); flow.stop();
  flow.receive({ language: 'ja', items: [{ menu_id: '1' }] }); assert.equal(flow.language, 'ko');
  flow.start(); flow.audio(); flow.stop(); flow.start(); flow.audio();
  const late = { type: 'order', item: { menuId: 14 }, language: 'es' };
  assert.deepEqual(flow.receive(late), late); assert.equal(flow.language, 'ko');
  flow.audio(); flow.receive({ language: 'th', items: [{ menu_id: '1' }] }); assert.equal(flow.language, 'th');
});

test('언어가 없거나 잘못된 기존 주문도 처리 경로에 남으며 다음 응답은 정상 전환한다', () => {
  for (const language of [undefined, null, '', 'en', 'ja-JP', 'JA', ' ja ', 1, {}, []]) {
    const flow = harness('es'); flow.start(); flow.audio();
    const data = { type: 'order', item: { menuId: 14, optionIds: [] }, language };
    const raw = JSON.parse(JSON.stringify(data));
    assert.deepEqual(flow.receive(data), raw); assert.equal(flow.language, 'es');
    flow.audio(); flow.receive({ language: 'ja', items: [{ menu_id: '1' }] }); assert.equal(flow.language, 'ja');
  }
});

test('관련 없는 상태 메시지나 잘못된 JSON은 미확정 언어 보호 창을 소모하지 않는다', () => {
  const flow = harness(); flow.start(); flow.audio(); flow.select('es');
  flow.receive({ type: 'kds_status', order: { orderId: 1 } });
  assert.throws(() => receiveVoiceMessage('null', { canApplyLanguage: () => flow.guard.acceptResponse(flow.socket) }));
  flow.audio(); flow.receive({ language: 'ja', items: [{ menu_id: '1' }] }); assert.equal(flow.language, 'es');
  flow.audio(); flow.receive({ language: 'th', items: [{ menu_id: '1' }] }); assert.equal(flow.language, 'th');
});

test('보호 창은 소켓별로 구분하고 수동 언어 보호 중에도 옵션·합산·주문 API 필드는 그대로 유지한다', () => {
  const guard = createVoiceLanguageGuard(); const oldSocket = {}; const newSocket = {};
  guard.startSession(); guard.audioSent(oldSocket);
  assert.equal(guard.acceptResponse(newSocket), false);
  assert.equal(guard.acceptResponse(oldSocket), true);
  const [menu] = normalizeMenus([{ menuId: 1, nameKo: '데리버거', price: 2800, status: 'ACTIVE',
    options: [{ optionId: 10, nameKo: '치즈 추가', optionType: 'ADD', extraPrice: 500 }] }]);
  const flow = harness(); flow.start(); flow.audio(); flow.select('es');
  const data = flow.receive({ type: 'order', item: { menuId: 1, optionIds: [10] }, language: 'ja' });
  const line = createCartItem(menu, data.item.optionIds); // unchanged legacy quantity behavior
  const cart = addCartItem(addCartItem([], line), line);
  assert.equal(flow.language, 'es'); assert.equal(cart[0].quantity, 2); assert.equal(cart[0].price, 3300);
  assert.deepEqual(buildOrderBody(cart), { items: [{ menuId: 1, quantity: 2, optionIds: [10] }] });
});
