import test from 'node:test';
import assert from 'node:assert/strict';
import { availableRecommendations } from '../src/domain/menu-display.js';
import { normalizeMenus } from '../src/domain/kiosk.js';

test('추천은 최신 서버 메뉴의 이름·가격·이미지·옵션을 사용하고 외부 후보 값은 사용하지 않는다', () => {
  const menus = normalizeMenus([
    { menuId: 1, nameKo: '데리버거', price: 2800, status: 'ACTIVE', imageUrl: 'https://example.com/menu.png',
      options: [{ optionId: 1, nameKo: '치즈 추가', optionType: 'ADD', extraPrice: 500 }] },
  ]);
  const candidates = [{ menuId: 1, name: '임시 버거', price: 1, imageUrl: 'https://example.com/wrong.png', confidence: 0.99 }];
  const result = availableRecommendations(candidates, menus, []);
  assert.deepEqual(result, menus);
  assert.equal(result[0], menus[0]);
  assert.equal(result[0].confidence, undefined);
});

test('품절·비활성·삭제된 메뉴와 이미 담은 메뉴·중복 후보는 추천에서 제외한다', () => {
  const menus = normalizeMenus([
    { menuId: 1, nameKo: '데리버거', price: 2800, status: 'ACTIVE' },
    { menuId: 10, nameKo: '감자튀김', price: 2200, status: 'ACTIVE' },
    { menuId: 14, nameKo: '콜라', price: 2100, status: 'SOLD_OUT' },
    { menuId: 17, nameKo: '아이스아메리카노', price: 2600, status: 'INACTIVE' },
  ]);
  const before = structuredClone(menus);
  const result = availableRecommendations([...menus, { id: 999 }, menus[1]], menus, [{ menuId: 1 }]);
  assert.deepEqual(result.map((item) => item.menuId), [10]);
  assert.deepEqual(menus, before);
  assert.deepEqual(availableRecommendations([], menus, []), []);
});
