import { supportedLanguage, translate } from '../i18n/index.js';

// The AI server currently emits stable string IDs while the order API accepts
// numeric menuId values. Resolve the IDs through the menu names returned by the
// backend instead of freezing today's numeric IDs in the frontend.
const AI_MENU_NAMES = Object.freeze({
  'classic-burger': '클래식 치즈버거',
  'bulgogi-burger': '불고기버거',
  'chicken-burger': '핫크리스피 치킨버거',
  fries_01: '감자튀김',
  nuggets: '치킨너겟',
  'cheese-sticks': '치즈스틱',
  cola_01: '콜라',
  'zero-cola': '제로슈거콜라',
  sprite: '사이다',
});

const text = (value) => typeof value === 'string' ? value.trim() : '';
const normalizedText = (value) => text(value).toLocaleLowerCase().replace(/[\s._-]+/gu, '');
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionNames = (option) => {
  const names = [option?.nameKo, option?.nameEn, option?.name];
  for (const language of ['en', 'ja', 'es', 'th']) names.push(translate(option?.nameKo, language));
  return new Set(names.map(normalizedText).filter(Boolean));
};

const resolveOptionIds = (menu, requested) => requested.map((requestedName) => {
  const key = normalizedText(requestedName);
  if (!key) throw new Error('AI 음성 주문의 옵션 정보를 확인해 주세요.');
  const matches = (menu.options || []).filter((option) => optionNames(option).has(key));
  if (matches.length !== 1) throw new Error(`'${requestedName}' 옵션을 현재 메뉴에서 확인할 수 없습니다.`);
  return matches[0].optionId;
});

const resolveMenu = (aiMenuId, menus) => {
  if (/^\d+$/u.test(aiMenuId)) {
    const menuId = Number(aiMenuId);
    if (!Number.isSafeInteger(menuId) || menuId <= 0) {
      throw new Error(`AI 메뉴 ID '${aiMenuId}'가 올바른 숫자 식별자가 아닙니다.`);
    }
    const menu = menus.find((candidate) => candidate.menuId === menuId);
    if (!menu) throw new Error(`AI 메뉴 ID '${aiMenuId}'에 해당하는 메뉴를 현재 서버 메뉴에서 확인할 수 없습니다.`);
    if (menu.status !== 'ACTIVE') throw new Error(`'${menu.nameKo || menu.name}' 메뉴는 현재 주문할 수 없습니다.`);
    return menu;
  }
  const expectedName = AI_MENU_NAMES[aiMenuId];
  if (!expectedName) throw new Error(`AI 메뉴 ID '${aiMenuId}'의 백엔드 메뉴 매핑이 필요합니다.`);
  const matches = menus.filter((menu) => normalizedText(menu.nameKo || menu.name) === normalizedText(expectedName));
  if (matches.length !== 1) throw new Error(`'${expectedName}' 메뉴를 현재 서버 메뉴에서 확인할 수 없습니다.`);
  if (matches[0].status !== 'ACTIVE') throw new Error(`'${expectedName}' 메뉴는 현재 주문할 수 없습니다.`);
  return matches[0];
};

export function isVoiceOrderResponse(data) {
  return plainObject(data) && Object.hasOwn(data, 'status');
}

// Validate the confirmed AI response contract without changing the legacy
// type/order path. Every item is resolved before App mutates the cart.
export function normalizeVoiceOrderResponse(data, menus) {
  if (!isVoiceOrderResponse(data)
    || !['success', 'fallback', 'error'].includes(data.status)
    || typeof data.recognized_text !== 'string'
    || !Array.isArray(data.items)
    || !(data.error_msg == null || typeof data.error_msg === 'string')
    || !supportedLanguage(data.language)) {
    throw new Error('AI 서버 응답 형식이 올바르지 않습니다.');
  }
  if (!Array.isArray(menus)) throw new Error('서버 메뉴를 불러온 뒤 음성 주문을 이용해 주세요.');
  if (data.status === 'error') {
    return { status: data.status, recognizedText: data.recognized_text.trim(), items: [], failed: true };
  }

  const items = data.items.map((item) => {
    if (!plainObject(item) || !text(item.menu_id) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0
      || !Array.isArray(item.options) || !item.options.every((option) => typeof option === 'string')) {
      throw new Error('AI 음성 주문의 메뉴·수량·옵션 형식을 확인해 주세요.');
    }
    const menu = resolveMenu(item.menu_id.trim(), menus);
    return {
      menuId: menu.menuId,
      quantity: item.quantity,
      optionIds: resolveOptionIds(menu, item.options),
    };
  });
  return { status: data.status, recognizedText: data.recognized_text.trim(), items, failed: false };
}

export const voiceMenuMappings = () => ({ ...AI_MENU_NAMES });
