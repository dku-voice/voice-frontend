import test from 'node:test';
import assert from 'node:assert/strict';
import { removePaidItemsFromCart } from '../src/domain/cart-settlement.js';
import { normalizeMenus, normalizeOrder, createCartItem, addCartItem } from '../src/domain/kiosk.js';

const [burger, cola] = normalizeMenus([
  { menuId: 1, nameKo: '버거', price: 2800, status: 'ACTIVE', options: [
    { optionId: 10, nameKo: '치즈 추가', optionType: 'ADD', extraPrice: 500 },
  ] },
  { menuId: 14, nameKo: '콜라', price: 2100, status: 'ACTIVE', options: [] },
]);
const paidOrder = () => normalizeOrder({
  orderId: 31, orderNumber: 'ORD-SETTLEMENT-31', status: 'PAID', totalPrice: 3300,
  items: [{ menuId: 1, menuNameKo: '버거', quantity: 1, unitPrice: 3300, subtotal: 3300,
    options: [{ optionId: 10, nameKo: '치즈 추가' }] }],
});
const line = (menuId, quantity, optionIds = []) => ({ menuId, quantity, optionIds, name: '기존 이름', price: 1234 });

test('결제 중 추가한 메뉴·같은 옵션의 추가 수량·다른 옵션은 보존하고 결제 수량만 정리한다', () => {
  const purchased = createCartItem(burger, [10]);
  let cart = addCartItem([purchased], createCartItem(burger, [10], 2));
  cart = addCartItem(cart, createCartItem(burger));
  cart = addCartItem(cart, createCartItem(cola));
  const before = structuredClone(cart);
  const paid = paidOrder();
  const originalPaid = structuredClone(paid.items);
  const remaining = removePaidItemsFromCart(cart, paid.items);
  assert.deepEqual(remaining.map((item) => [item.menuId, item.optionIds, item.quantity]), [
    [1, [10], 2], [1, [], 1], [14, [], 1],
  ]);
  assert.equal(remaining[0].name, '버거');
  assert.equal(remaining[0].unitPrice, 3300);
  assert.equal(remaining[0].price, 3300);
  assert.equal(remaining[0].lineId, purchased.lineId);
  assert.deepEqual(cart, before);
  assert.deepEqual(paid.items, originalPaid);
});

test('이미 삭제하거나 수량을 줄인 항목은 음수가 되지 않고 현재 존재하는 수량까지만 제거한다', () => {
  const cart = [line(1, 1, [10]), line(14, 2)];
  const paid = [line(1, 3, [10]), line(9, 2)];
  assert.deepEqual(removePaidItemsFromCart(cart, paid), [line(14, 2)]);
  assert.deepEqual(removePaidItemsFromCart([], paid), []);
});

test('서버 영수증의 같은 옵션 조합이 여러 행이면 합산하며 옵션 순서와 중복 ID에 영향받지 않는다', () => {
  const cart = [line(1, 5, [10, 11]), line(1, 1, [10])];
  const paid = [line(1, 1, [11, 10, 10]), line(1, 2, [10, 11])];
  assert.deepEqual(removePaidItemsFromCart(cart, paid), [line(1, 2, [10, 11]), line(1, 1, [10])]);
});

test('카트의 같은 옵션 조합이 여러 행이어도 결제 수량을 각 행마다 중복 차감하지 않는다', () => {
  const cart = [line(1, 1, [10]), { ...line(1, 3, [10]), name: '두 번째 행' }];
  const remaining = removePaidItemsFromCart(cart, [line(1, 2, [10])]);
  assert.deepEqual(remaining, [{ ...line(1, 2, [10]), name: '두 번째 행' }]);
});

test('전체 수량이 결제되면 빈 장바구니가 되고 빈 결제 목록은 기존 메타데이터를 보존한다', () => {
  const cart = [createCartItem(burger, [10])];
  assert.deepEqual(removePaidItemsFromCart(cart, paidOrder().items), []);
  assert.deepEqual(removePaidItemsFromCart(cart, []), cart);
});

test('동결된 입력 배열·행·옵션을 변경하지 않는다', () => {
  const item = Object.freeze({ ...line(1, 3, [11, 10]), optionIds: Object.freeze([11, 10]) });
  const cart = Object.freeze([item]);
  const paid = Object.freeze([Object.freeze({ ...line(1, 1, [10, 11]), optionIds: Object.freeze([10, 11]) })]);
  const remaining = removePaidItemsFromCart(cart, paid);
  assert.equal(remaining[0].quantity, 2);
  assert.deepEqual(remaining[0].optionIds, [11, 10]);
  assert.equal(item.quantity, 3);
});

test('잘못된 목록·메뉴 ID·수량·옵션 ID와 합산 초과는 정리를 중단한다', () => {
  for (const invalidList of [null, {}, 'items']) {
    assert.throws(() => removePaidItemsFromCart(invalidList, []));
    assert.throws(() => removePaidItemsFromCart([], invalidList));
  }
  for (const invalidItem of [
    line('1', 1), line(0, 1), line(1, 0), line(1, -1), line(1, 1.5), line(1, Infinity),
    line(1, 1, ['10']), line(1, 1, [0]), line(1, 1, [1.5]),
    { menuId: 1, quantity: 1 }, null,
  ]) {
    assert.throws(() => removePaidItemsFromCart([invalidItem], []));
    assert.throws(() => removePaidItemsFromCart([], [invalidItem]));
  }
  assert.throws(() => removePaidItemsFromCart([], [line(1, Number.MAX_SAFE_INTEGER), line(1, 1)]));
});
