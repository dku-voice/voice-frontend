import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceWait, receiveVoiceMessage, voiceLanguage } from '../src/integration/voice-language.js';
import { addCartItem, createCartItem, normalizeMenus, buildOrderBody } from '../src/domain/kiosk.js';

function clock() {
  let time = 0;
  let id = 0;
  const tasks = new Map();
  return {
    now: () => time,
    schedule: (callback, delay) => { const key = ++id; tasks.set(key, { callback, at: time + delay }); return key; },
    cancel: (key) => tasks.delete(key),
    tick(delay) {
      const end = time + delay;
      for (;;) {
        const first = [...tasks].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        time = first[1].at;
        tasks.delete(first[0]);
        first[1].callback();
      }
      time = end;
    },
  };
}

test('한국어 5초·외국어 12초에만 터치 대체를 안내하고 PCM 프레임이 타이머를 연장하지 않는다', () => {
  for (const language of ['ko', 'ja', 'es', 'th']) {
    const fake = clock(); const events = [];
    const wait = createVoiceWait({ ...fake, onPending: () => events.push('pending'), onTouch: (event) => events.push(event) });
    wait.start(language);
    fake.tick(2999); assert.deepEqual(events, []);
    wait.start(language); // another audio frame
    fake.tick(1); assert.deepEqual(events, ['pending']);
    const deadline = language === 'ko' ? 5000 : 12000;
    fake.tick(deadline - 3001); assert.equal(events.length, 1);
    fake.tick(1); assert.deepEqual(events[1], { language, deadline });
    assert.equal(wait.waiting, language === 'ko', '5s touch is soft; 12s response expiry is terminal');
    assert.equal(wait.expired, language !== 'ko');
    assert.equal(wait.touchAvailable, true);
    wait.finish();
    assert.equal(wait.waiting, false);
  }
});

test('대기 중 수동 언어 변경은 시작 시각을 보존하고 잘못된 값은 타이머를 바꾸지 않는다', () => {
  const fake = clock(); const events = [];
  const wait = createVoiceWait({ ...fake, onPending: () => {}, onTouch: (event) => events.push(event) });
  wait.start('ko'); fake.tick(4000); wait.changeLanguage('th');
  fake.tick(1000); assert.deepEqual(events, []);
  wait.changeLanguage('en'); fake.tick(6999); assert.deepEqual(events, []);
  fake.tick(1); assert.deepEqual(events, [{ language: 'th', deadline: 12000 }]);
  wait.finish();
  wait.start('ja'); fake.tick(4000); wait.changeLanguage('ko'); fake.tick(1000);
  assert.deepEqual(events[1], { language: 'ko', deadline: 5000 });
  wait.finish(); fake.tick(60000); assert.equal(events.length, 2);
});

test('5초까지 언어를 모르더라도 9초에 도착한 외국어 결과를 버리지 않고 기존 주문 처리에 전달한다', () => {
  const fake = clock(); const events = [];
  const wait = createVoiceWait({ ...fake, onPending: () => {}, onTouch: () => events.push('touch') });
  wait.start('ko'); fake.tick(5000); assert.deepEqual(events, ['touch']);
  fake.tick(4000);
  let language = 'ko';
  const payload = { type: 'order', language: 'ja', item: { menuId: 1, optionIds: [10] } };
  const data = receiveVoiceMessage(JSON.stringify(payload), { voiceActive: true, currentLanguage: language,
    onLanguage: (value) => { language = value; events.push('language'); } });
  wait.finish();
  assert.deepEqual(data, payload);
  const [menu] = normalizeMenus([{ menuId: 1, nameKo: '데리버거', price: 2800, status: 'ACTIVE',
    options: [{ optionId: 10, nameKo: '치즈 추가', optionType: 'ADD', extraPrice: 500 }] }]);
  let cart = [];
  // Legacy handler adds one item per event; that quantity contract is unchanged.
  cart = addCartItem(cart, createCartItem(menu, data.item.optionIds));
  cart = addCartItem(cart, createCartItem(menu, data.item.optionIds));
  assert.equal(language, 'ja'); assert.equal(cart[0].quantity, 2); assert.equal(cart[0].price, 3300);
  assert.deepEqual(buildOrderBody(cart), { items: [{ menuId: 1, quantity: 2, optionIds: [10] }] });
  fake.tick(60000); assert.equal(events.length, 2);
});

test('자동 전환은 음성 시작 이후 지원 언어에만 적용하고 기존 메시지의 메뉴·수량·옵션 필드를 변경하지 않는다', () => {
  for (const language of ['ko', 'ja', 'es', 'th']) {
    const events = [];
    const raw = { type: 'order', language, item: { menuId: 14, quantity: 3, optionIds: [] } };
    const data = receiveVoiceMessage(JSON.stringify(raw), { voiceActive: true, currentLanguage: language === 'ko' ? 'th' : 'ko', onLanguage: (l) => events.push(l) });
    assert.deepEqual(events, [language]); assert.deepEqual(data, raw);
  }
  for (const value of [undefined, null, '', 'en', 'ja-JP', 'JA', ' ja ', 1, {}, []]) {
    assert.equal(voiceLanguage({ language: value }, 'es'), 'es');
    receiveVoiceMessage(JSON.stringify({ type: 'order', language: value, item: { menuId: 1 } }), {
      voiceActive: true, currentLanguage: 'es', onLanguage: () => assert.fail('unsupported language'),
    });
  }
  receiveVoiceMessage('{"language":"th"}', { voiceActive: false, onLanguage: () => assert.fail('mic not started') });
  for (const raw of ['null', '[]', '1', 'invalid']) assert.throws(() => receiveVoiceMessage(raw));
});

test('메시지 수신과 타이머 종료는 기존 status/items 응답을 임의로 order/item으로 변환하지 않는다', () => {
  const raw = { status: 'success', language: 'es', items: [{ menu_id: 'cola_01', quantity: 2, options: [] }] };
  assert.deepEqual(receiveVoiceMessage(JSON.stringify(raw)), raw);
});

test('메뉴나 추천 결과가 없는 응답으로는 화면 언어를 바꾸지 않는다', () => {
  const changes = [];
  const options = { voiceActive: true, currentLanguage: 'ja', onLanguage: (language) => changes.push(language) };
  receiveVoiceMessage(JSON.stringify({ status: 'success', language: 'ko', items: [], recognized_text: '' }), options);
  receiveVoiceMessage(JSON.stringify({ status: 'error', language: 'ko', items: [] }), options);
  assert.deepEqual(changes, []);
  receiveVoiceMessage(JSON.stringify({ status: 'success', language: 'es', items: [{ menu_id: '14', quantity: 2 }] }), options);
  receiveVoiceMessage(JSON.stringify({ type: 'recommendation', language: 'th', recognized_text: 'x', items: [{ menu_id: '2' }] }), options);
  assert.deepEqual(changes, ['es', 'th']);
});
