import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMenus, groupMenus, createCartItem, addCartItem, cartFingerprint, buildOrderBody, normalizeOrder } from '../src/domain/kiosk.js';

const rawMenus = [
  { menuId: 1, nameKo: '버거', price: 2800, status: 'ACTIVE', categoryNameKo: '버거', options: [
    { optionId: 10, nameKo: '치즈 추가', optionType: 'ADD', extraPrice: 500 },
    { optionId: 11, nameKo: '양파 제외', optionType: 'REMOVE', extraPrice: 0 },
  ] },
  { menuId: 9, nameKo: '양념감자', price: 2000, status: 'ACTIVE', categoryNameKo: '사이드', options: [
    { optionId: 20, nameKo: '어니언 소스', optionType: 'ADD', extraPrice: 0 },
    { optionId: 21, nameKo: '치즈 소스', optionType: 'ADD', extraPrice: 0 },
    { optionId: 22, nameKo: '칠리 소스', optionType: 'ADD', extraPrice: 0 },
  ] },
  { menuId: 14, nameKo: '콜라', price: 1800, status: 'SOLD_OUT', categoryNameKo: '음료', options: [] },
  { menuId: 17, nameKo: '숨김 음료', price: 1800, status: 'INACTIVE', categoryNameKo: '음료', options: [] },
];

test('최신 메뉴 필드만으로 화면 모델을 만들고 INACTIVE 제외·SOLD_OUT 표시를 유지한다', () => {
  const before = structuredClone(rawMenus);
  const menus = normalizeMenus(rawMenus);
  assert.equal(menus[0].name, '버거');
  assert.deepEqual(menus[0].allergens, []);
  assert.deepEqual(groupMenus(menus).flatMap((group) => group.items.map((item) => item.menuId)), [1, 9, 14]);
  assert.equal(menus[2].status, 'SOLD_OUT');
  assert.throws(() => createCartItem(menus[2]));
  assert.deepEqual(rawMenus, before);
});

test('ADD/REMOVE와 수량을 반영하고 같은 메뉴의 옵션 조합을 별도 장바구니 행으로 다룬다', () => {
  const [menu] = normalizeMenus(rawMenus);
  const plain = createCartItem(menu);
  const extra = createCartItem(menu, [11, 10, 10], 2);
  assert.equal(extra.unitPrice, 3300);
  assert.deepEqual(extra.optionIds, [10, 11]);
  const cart = addCartItem(addCartItem([plain], extra), createCartItem(menu, [10, 11]));
  assert.equal(cart.length, 2);
  assert.equal(cart[1].quantity, 3);
  assert.notEqual(cart[0].lineId, cart[1].lineId);
  assert.equal(extra.quantity, 2);
  assert.deepEqual(buildOrderBody(cart), { items: [
    { menuId: 1, quantity: 1, optionIds: [] }, { menuId: 1, quantity: 3, optionIds: [10, 11] },
  ] });
});

test('양념감자 소스는 한 개만 선택하고 다른 메뉴의 유사 옵션을 임의 그룹화하지 않는다', () => {
  const menus = normalizeMenus(rawMenus);
  assert.throws(() => createCartItem(menus[1]), /한 가지/);
  assert.throws(() => createCartItem(menus[1], [20, 21]), /한 가지/);
  assert.equal(createCartItem(menus[1], [22]).price, 2000);
  const other = { ...menus[1], nameKo: '다른 메뉴', name: '다른 메뉴' };
  assert.equal(createCartItem(other, [20, 21]).price, 2000);
});

test('알 수 없는 옵션·문자열 ID·잘못된 수량·중복 서버 메뉴는 거부한다', () => {
  const [menu] = normalizeMenus(rawMenus);
  assert.throws(() => createCartItem(menu, [999]));
  assert.throws(() => createCartItem(menu, ['10']));
  assert.throws(() => createCartItem(menu, [], 0));
  assert.throws(() => normalizeMenus([...rawMenus, rawMenus[0]]));
  assert.throws(() => buildOrderBody([{ id: 'sample-burger', quantity: 1 }]));
});

test('API가 동일 옵션을 반복해도 한 번씩만 표시·선택·과금하고 원본 응답을 변경하지 않는다', () => {
  const repeated = structuredClone(rawMenus);
  repeated[0].options = Array.from({ length: 7 }, () => structuredClone(rawMenus[0].options)).flat();
  repeated[1].options = [...structuredClone(rawMenus[1].options), ...structuredClone(rawMenus[1].options)];
  const original = structuredClone(repeated);
  const menus = normalizeMenus(repeated);
  assert.deepEqual(menus[0].options.map((option) => option.optionId), [10, 11]);
  assert.equal(menus[1].options.length, 3);
  const cart = [createCartItem(menus[0], [10, 11], 2), createCartItem(menus[1], [20])];
  assert.equal(cart[0].unitPrice, 3300);
  assert.equal(cart[1].unitPrice, 2000);
  assert.deepEqual(buildOrderBody(cart), { items: [
    { menuId: 1, quantity: 2, optionIds: [10, 11] }, { menuId: 9, quantity: 1, optionIds: [20] },
  ] });
  assert.deepEqual(repeated, original);
});

test('같은 옵션 ID의 이름·번역·종류·가격이 다르면 어느 값도 임의로 선택하지 않는다', () => {
  const option = { optionId: 10, nameKo: '양파 추가', nameEn: 'Add Onion', optionType: 'ADD', extraPrice: 0 };
  for (const difference of [
    { nameKo: '치즈 추가' }, { nameEn: 'Add Cheese' }, { optionType: 'REMOVE' }, { extraPrice: 500 },
  ]) {
    assert.throws(() => normalizeMenus([{ ...rawMenus[0], options: [option, { ...option, ...difference }] }]), /서로 다른 정보/);
  }
});

test('반복된 옵션이어도 잘못된 가격·종류·이름·문자열 ID는 계속 거부한다', () => {
  const option = rawMenus[0].options[0];
  for (const difference of [{ extraPrice: -1 }, { optionType: 'UNKNOWN' }, { nameKo: '' }, { optionId: '10' }]) {
    assert.throws(() => normalizeMenus([{ ...rawMenus[0], options: [option, { ...option, ...difference }] }]));
  }
});

test('장바구니 fingerprint는 표시 가격·순서와 무관하고 수량·옵션으로 구분한다', () => {
  const [menu] = normalizeMenus(rawMenus);
  const first = createCartItem(menu, [], 2);
  const second = createCartItem(menu, [10]);
  assert.equal(cartFingerprint([first, second]), cartFingerprint([second, { ...first, price: 1 }]));
  assert.notEqual(cartFingerprint([first]), cartFingerprint([{ ...first, quantity: 3 }]));
});

test('영수증은 서버 단가·소계·총액을 검증하고 일치하지 않는 완료 응답은 거부한다', () => {
  const receipt = { orderId: 5, orderNumber: 'ORD-MOCK-5', status: 'PAID', totalPrice: 6600, items: [
    { menuId: 1, menuNameKo: '버거', quantity: 2, unitPrice: 3300, subtotal: 6600, options: [{ optionId: 10, nameKo: '치즈 추가' }] },
  ] };
  assert.equal(normalizeOrder(receipt).items[0].price, 3300);
  assert.throws(() => normalizeOrder({ ...receipt, totalPrice: 6601 }));
  assert.throws(() => normalizeOrder({ ...receipt, status: 'UNKNOWN' }));
});
