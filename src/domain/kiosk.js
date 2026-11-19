const STATUSES = new Set(['PENDING', 'PAID', 'PREPARING', 'COMPLETED', 'CANCELLED', 'REFUNDED']);
const PAID_STATUSES = new Set(['PAID', 'PREPARING', 'COMPLETED']);
const SAUCES = new Set(['어니언소스', '치즈소스', '칠리소스']);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === 'string' ? value.trim() : '';
const compact = (value) => text(value).replace(/\s/gu, '');
const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
const imageFor = (category) => /burger|버거/i.test(category) ? '🍔' : /drink|음료/i.test(category) ? '🥤' : '🍟';

const optionIdsFor = (value = []) => {
  if (!Array.isArray(value) || !Array.from(value).every(positiveInteger)) {
    throw new Error('선택한 옵션 ID를 확인해 주세요.');
  }
  return [...new Set(value)].sort((a, b) => a - b);
};
const variantKey = (menuId, optionIds) => `${menuId}:${optionIds.join(',')}`;

export const normalizeMenus = (raw) => {
  if (!Array.isArray(raw)) throw new Error('메뉴 응답 형식이 올바르지 않습니다.');
  const ids = new Set();
  return Array.from(raw, (menu) => {
    if (!positiveInteger(menu?.menuId) || !text(menu.nameKo) || !nonNegativeInteger(menu.price)
      || !['ACTIVE', 'SOLD_OUT', 'INACTIVE'].includes(menu.status) || ids.has(menu.menuId)) {
      throw new Error('서버 메뉴 정보가 올바르지 않습니다. 다시 불러와 주세요.');
    }
    ids.add(menu.menuId);
    if (menu.options != null && !Array.isArray(menu.options)) throw new Error('메뉴 옵션 형식이 올바르지 않습니다.');
    const optionsById = new Map();
    for (const option of menu.options || []) {
      if (!positiveInteger(option?.optionId) || !text(option.nameKo)
        || !['ADD', 'REMOVE'].includes(option.optionType) || !nonNegativeInteger(option.extraPrice)
        || (option.optionType === 'REMOVE' && option.extraPrice !== 0)) {
        throw new Error('서버 메뉴 옵션 정보가 올바르지 않습니다.');
      }
      const normalized = { ...option, name: text(option.nameKo), nameKo: text(option.nameKo), nameEn: text(option.nameEn) };
      const previous = optionsById.get(option.optionId);
      if (previous) {
        // A joined API response may repeat the same option. Never choose between
        // conflicting definitions or charge twice for an identical repeated row.
        if (['nameKo', 'nameEn', 'optionType', 'extraPrice'].some((field) => previous[field] !== normalized[field])) {
          throw new Error('같은 옵션 ID에 서로 다른 정보가 있습니다. 메뉴 정보를 확인해 주세요.');
        }
        continue;
      }
      optionsById.set(option.optionId, normalized);
    }
    const options = [...optionsById.values()];
    const categoryNameKo = text(menu.categoryNameKo) || '기타';
    return {
      ...menu,
      id: menu.menuId,
      menuId: menu.menuId,
      name: text(menu.nameKo),
      nameKo: text(menu.nameKo),
      nameEn: text(menu.nameEn),
      basePrice: menu.price,
      price: menu.price,
      categoryNameKo,
      categoryNameEn: text(menu.categoryNameEn),
      imageUrl: typeof menu.imageUrl === 'string' ? menu.imageUrl : '',
      image: imageFor(text(menu.categoryNameEn) || categoryNameKo),
      tags: [categoryNameKo],
      options,
      allergens: strings(menu.allergensKo),
      allergensKo: strings(menu.allergensKo),
      allergensEn: strings(menu.allergensEn),
      nutrient: menu.nutrient && typeof menu.nutrient === 'object' ? { ...menu.nutrient } : null,
    };
  });
};

export const groupMenus = (menus) => {
  const groups = new Map();
  for (const menu of menus) {
    if (menu.status === 'INACTIVE') continue;
    const name = menu.categoryNameKo || '기타';
    if (!groups.has(name)) groups.set(name, { id: name, name, items: [] });
    groups.get(name).items.push(menu);
  }
  return [...groups.values()];
};

export const getOptionGroups = (menu) => {
  const options = menu.options || [];
  const sauces = compact(menu.nameKo || menu.name) === '양념감자'
    ? options.filter((option) => option.optionType === 'ADD' && option.extraPrice === 0 && SAUCES.has(compact(option.nameKo)))
    : [];
  const sauceIds = new Set(sauces.map((option) => option.optionId));
  return {
    add: options.filter((option) => option.optionType === 'ADD' && !sauceIds.has(option.optionId)),
    remove: options.filter((option) => option.optionType === 'REMOVE'),
    sauces,
  };
};

export const createCartItem = (menu, optionIds = [], quantity = 1) => {
  const menuId = menu?.menuId ?? menu?.id;
  if (!positiveInteger(menuId) || menu.status !== 'ACTIVE') throw new Error('현재 주문할 수 없는 메뉴입니다.');
  if (!positiveInteger(quantity)) throw new Error('메뉴 수량은 1 이상의 정수여야 합니다.');
  const selectedIds = optionIdsFor(optionIds);
  const selected = selectedIds.map((id) => {
    const matches = (menu.options || []).filter((option) => option.optionId === id);
    if (matches.length !== 1 || !nonNegativeInteger(matches[0].extraPrice)
      || !['ADD', 'REMOVE'].includes(matches[0].optionType)
      || (matches[0].optionType === 'REMOVE' && matches[0].extraPrice !== 0)) {
      throw new Error('이 메뉴에 사용할 수 없는 옵션입니다.');
    }
    return matches[0];
  });
  const { sauces } = getOptionGroups(menu);
  if (sauces.length && selected.filter((option) => sauces.some((sauce) => sauce.optionId === option.optionId)).length !== 1) {
    throw new Error('양념감자 소스를 한 가지 선택해 주세요.');
  }
  const basePrice = menu.basePrice ?? menu.price;
  const unitPrice = basePrice + selected.reduce((sum, option) => sum + option.extraPrice, 0);
  if (!nonNegativeInteger(basePrice) || !nonNegativeInteger(unitPrice) || !Number.isSafeInteger(unitPrice * quantity)) {
    throw new Error('메뉴 금액을 확인해 주세요.');
  }
  return {
    ...menu,
    id: menuId,
    menuId,
    basePrice,
    lineId: variantKey(menuId, selectedIds),
    optionIds: selectedIds,
    optionNames: selected.map((option) => option.nameKo || option.name),
    unitPrice,
    price: unitPrice,
    quantity,
  };
};

const orderLines = (cart) => {
  if (!Array.isArray(cart)) throw new Error('장바구니 정보가 올바르지 않습니다.');
  const variants = new Map();
  for (const item of cart) {
    const menuId = item?.menuId ?? item?.id;
    if (!positiveInteger(menuId) || !positiveInteger(item?.quantity)) {
      throw new Error('주문 메뉴 ID와 수량을 확인해 주세요.');
    }
    const optionIds = optionIdsFor(item.optionIds ?? []);
    const key = variantKey(menuId, optionIds);
    const quantity = (variants.get(key)?.quantity || 0) + item.quantity;
    if (!positiveInteger(quantity)) throw new Error('주문 수량을 확인해 주세요.');
    variants.set(key, { menuId, quantity, optionIds });
  }
  return [...variants.values()];
};

export const addCartItem = (cart, item) => {
  const [line] = orderLines([item]);
  const lineId = variantKey(line.menuId, line.optionIds);
  let merged = false;
  const next = cart.map((existing) => {
    const [existingLine] = orderLines([existing]);
    if (variantKey(existingLine.menuId, existingLine.optionIds) !== lineId) return existing;
    if (merged) return null;
    merged = true;
    const quantity = orderLines([...cart.filter((candidate) => {
      const [candidateLine] = orderLines([candidate]);
      return variantKey(candidateLine.menuId, candidateLine.optionIds) === lineId;
    }), item])[0].quantity;
    return { ...item, ...line, lineId, quantity };
  }).filter(Boolean);
  return merged ? next : [...next, { ...item, ...line, lineId }];
};

export const cartFingerprint = (cart) => JSON.stringify(orderLines(cart).sort((a, b) => a.menuId - b.menuId
  || a.optionIds.join(',').localeCompare(b.optionIds.join(','))));

export const buildOrderBody = (cart) => {
  const items = orderLines(cart);
  if (!items.length) throw new Error('주문할 메뉴를 장바구니에 담아 주세요.');
  return { items };
};

export const normalizeOrder = (raw) => {
  if (!positiveInteger(raw?.orderId) || !text(raw.orderNumber) || !STATUSES.has(raw.status)
    || !nonNegativeInteger(raw.totalPrice) || !Array.isArray(raw.items) || !raw.items.length) {
    throw new Error('서버 주문 정보가 올바르지 않습니다. 주문 내역을 확인해 주세요.');
  }
  const items = Array.from(raw.items, (item, index) => {
    if (!positiveInteger(item?.menuId) || !text(item.menuNameKo) || !positiveInteger(item.quantity)
      || !nonNegativeInteger(item.unitPrice) || !nonNegativeInteger(item.subtotal)
      || item.subtotal !== item.unitPrice * item.quantity || (item.options != null && !Array.isArray(item.options))) {
      throw new Error('서버 영수증 항목이 올바르지 않습니다.');
    }
    const options = Array.from(item.options || [], (option) => {
      if (!positiveInteger(option?.optionId) || !text(option.nameKo)) throw new Error('서버 영수증 옵션이 올바르지 않습니다.');
      return { ...option };
    });
    const optionIds = optionIdsFor(options.map((option) => option.optionId));
    const variantId = variantKey(item.menuId, optionIds);
    return {
      ...item,
      id: item.menuId,
      name: item.menuNameKo,
      price: item.unitPrice,
      variantId,
      lineId: `${variantId}#${index}`,
      options,
      optionIds,
      optionNames: options.map((option) => option.nameKo),
    };
  });
  const sum = items.reduce((total, item) => total + item.subtotal, 0);
  if (!Number.isSafeInteger(sum) || sum !== raw.totalPrice) throw new Error('서버 주문 총액이 영수증과 다릅니다.');
  return { ...raw, id: raw.orderId, items };
};

export const orderStatusLabel = (status) => ({
  PENDING: '결제 대기', PAID: '결제 완료', PREPARING: '조리 중', COMPLETED: '조리 완료',
  CANCELLED: '주문 취소', REFUNDED: '환불 완료',
}[status] || '알 수 없음');

export const isPaidOrder = (order) => PAID_STATUSES.has(order?.status);

export const assertOrderMatchesCheckout = (order, checkout) => {
  const expected = checkout?.order || checkout;
  if (order?.orderId !== expected?.orderId || order?.orderNumber !== expected?.orderNumber
    || order?.totalPrice !== expected?.totalPrice) {
    throw new Error('서버 주문번호 또는 금액이 저장된 주문과 다릅니다.');
  }
  if (Array.isArray(expected.items) && cartFingerprint(order.items) !== cartFingerprint(expected.items)) {
    throw new Error('서버 주문 항목이 저장된 주문과 다릅니다.');
  }
  return order;
};

export const isUncertainOrderError = (error) => !(error?.status >= 400 && error.status < 500)
  && error?.code !== 'INVALID_INPUT';
