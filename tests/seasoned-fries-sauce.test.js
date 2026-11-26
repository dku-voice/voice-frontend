import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translate } from '../src/i18n/index.js';
import { needsSauceChoice } from '../src/domain/kiosk.js';

const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const fries = {
  nameKo: '양념감자',
  options: [
    { optionId: 31, nameKo: '어니언 소스', optionType: 'ADD', extraPrice: 0 },
    { optionId: 32, nameKo: '치즈 소스', optionType: 'ADD', extraPrice: 0 },
    { optionId: 33, nameKo: '칠리 소스', optionType: 'ADD', extraPrice: 0 },
  ],
};

test('양념감자는 소스가 정확히 하나일 때만 바로 담을 수 있다', () => {
  assert.equal(needsSauceChoice(fries, []), true);
  assert.equal(needsSauceChoice(fries, [32]), false);
  assert.equal(needsSauceChoice(fries, [31, 32]), true);
  assert.equal(needsSauceChoice({ nameKo: '데리버거', options: [] }, []), false);
});

test('음성 주문에서 소스가 빠지면 다른 메뉴는 담고 소스 선택을 연다', () => {
  const voice = source.slice(source.indexOf('const addVoiceOrderToCart'), source.indexOf('const removeFromCart'));
  assert.match(voice, /needsSauceChoice\(menu, candidate\.optionIds\)/);
  assert.match(voice, /\.filter\(\(entry\) => entry !== missingSauce\)/);
  assert.match(voice, /setPendingSauce\(\{ menuId: menu\.menuId, quantity: candidate\.quantity \?\? 1 \}\)/);
  assert.match(source, /open=\{sauceMissing \|\| undefined\}/);
});

test('소스 안내 문구가 모든 언어로 번역된다', () => {
  const texts = ['소스 1개 선택 (어니언·치즈·칠리)', '양념감자의 소스를 골라 주세요.', '콜라 1개를 장바구니에 담았습니다. 양념감자의 소스를 골라 주세요.'];
  for (const text of texts) {
    for (const language of ['en', 'ja', 'es', 'th']) assert.notEqual(translate(text, language), text, `${text} ${language}`);
  }
  assert.equal(
    translate('콜라 1개를 장바구니에 담았습니다. 양념감자의 소스를 골라 주세요.', 'en'),
    'Added 1 Cola to your cart. Please choose a sauce for the Seasoned Fries.',
  );
});
