import { ApiError, apiClient } from './client.js';

const invalidInput = (message) => new ApiError(message, { code: 'INVALID_INPUT' });
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const id = (value, label) => {
  if (!positiveInteger(value)) throw invalidInput(`${label}의 숫자 ID를 확인해 주세요.`);
  return value;
};
const requiredText = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw invalidInput(`${label}을(를) 입력해 주세요.`);
  return value.trim();
};
const query = (path, values) => {
  const parameters = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined) parameters.set(key, value);
  });
  return parameters.size ? `${path}?${parameters}` : path;
};
const statsParameters = (storeId, from, to) => {
  const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!validDate(from) || !validDate(to) || from > to) {
    throw invalidInput('통계 조회 시작일과 종료일을 올바르게 선택해 주세요.');
  }
  return { storeId: requiredText(storeId, '매장 ID'), from, to };
};
const orderBody = (body) => {
  if (!Array.isArray(body?.items) || body.items.length === 0) throw invalidInput('주문할 메뉴를 한 개 이상 선택해 주세요.');
  return {
    items: Array.from(body.items, (item) => {
      id(item?.menuId, '메뉴');
      if (!positiveInteger(item.quantity)) throw invalidInput('메뉴 수량은 1 이상의 정수여야 합니다.');
      if (!Array.isArray(item.optionIds) || !Array.from(item.optionIds).every(positiveInteger)) {
        throw invalidInput('선택 옵션의 숫자 ID를 확인해 주세요.');
      }
      return { menuId: item.menuId, quantity: item.quantity, optionIds: [...new Set(item.optionIds)] };
    }),
  };
};

export function createKioskApi({ client = apiClient } = {}) {
  const protectedRequest = (path, { token, signal } = {}, options = {}) => client.request(path, {
    ...options, token, signal, auth: true,
  });

  return {
    fetchMenus: async ({ categoryId, signal } = {}) => client.request(query('/api/menus', {
      categoryId: categoryId == null ? undefined : id(categoryId, '카테고리'),
    }), { signal }),
    createOrder: async (body, { signal } = {}) => client.request('/api/orders', {
      method: 'POST', body: orderBody(body), signal,
    }),
    getOrder: async (orderId, { signal } = {}) => client.request(`/api/orders/${id(orderId, '주문')}`, { signal }),
    confirmPayment: async (payload, { signal } = {}) => {
      if (payload?.pgProvider !== 'TEST' || payload.method !== 'CARD') {
        throw invalidInput('현재 시연에서는 TEST 카드 결제만 사용할 수 있습니다.');
      }
      id(payload.orderId, '주문');
      if (!positiveInteger(payload.amount)) throw invalidInput('서버에서 확인한 결제 금액을 사용해 주세요.');
      return client.request('/api/payments/confirm', {
        method: 'POST', signal,
        body: {
          pgProvider: 'TEST', pgTransactionId: requiredText(payload.pgTransactionId, '결제 거래 ID'),
          orderId: payload.orderId, amount: payload.amount, method: 'CARD',
        },
      });
    },
    cancelPayment: async (payload, { signal } = {}) => client.request('/api/payments/cancel', {
      method: 'POST', signal,
      body: {
        pgTransactionId: requiredText(payload?.pgTransactionId, '결제 거래 ID'),
        cancelReason: requiredText(payload?.cancelReason, '취소 사유'),
      },
    }),
    login: async ({ username, password } = {}, { signal } = {}) => {
      const account = requiredText(username, '아이디');
      if (typeof password !== 'string' || !password.trim()) throw invalidInput('로그인 정보를 입력해 주세요.');
      const session = await client.request('/api/auth/login', {
        method: 'POST', body: { username: account, password }, signal,
      });
      if (typeof session?.accessToken !== 'string' || !session.accessToken.trim()
        || !['ADMIN', 'STAFF'].includes(session.role)) {
        throw new ApiError('로그인 응답의 토큰 또는 권한 정보가 올바르지 않습니다.', { code: 'INVALID_RESPONSE' });
      }
      return { accessToken: session.accessToken, role: session.role };
    },
    logout: (options) => protectedRequest('/api/auth/logout', options, { method: 'POST' }),
    fetchKdsOrders: async ({ storeId = 'store-default', token, signal } = {}) => protectedRequest(
      query('/api/kds/orders', { storeId: requiredText(storeId, '매장 ID') }), { token, signal },
    ),
    updateKdsStatus: async (orderId, status, options) => {
      if (!['PREPARING', 'COMPLETED'].includes(status)) throw invalidInput('변경할 조리 상태를 확인해 주세요.');
      return protectedRequest(query(`/api/kds/orders/${id(orderId, '주문')}/status`, { status }), options, { method: 'PATCH' });
    },
    updateMenuStatus: async (menuId, status, options) => {
      if (!['ACTIVE', 'SOLD_OUT', 'INACTIVE'].includes(status)) throw invalidInput('변경할 메뉴 상태를 확인해 주세요.');
      return protectedRequest(query(`/api/admin/menus/${id(menuId, '메뉴')}/status`, { status }), options, { method: 'PATCH' });
    },
    fetchAdminOrders: async ({ storeId = 'store-default', token, signal } = {}) => protectedRequest(
      query('/api/admin/orders', { storeId: requiredText(storeId, '매장 ID') }), { token, signal },
    ),
    getAdminOrder: async (orderId, options) => protectedRequest(`/api/admin/orders/${id(orderId, '주문')}`, options),
    fetchAdminPayments: async ({ storeId = 'store-default', token, signal } = {}) => protectedRequest(
      query('/api/admin/payments', { storeId: requiredText(storeId, '매장 ID') }), { token, signal },
    ),
    fetchSalesStats: async ({ storeId = 'store-default', from, to, token, signal } = {}) => protectedRequest(
      query('/api/admin/stats/sales', statsParameters(storeId, from, to)), { token, signal },
    ),
    fetchMenuStats: async ({ storeId = 'store-default', from, to, token, signal } = {}) => protectedRequest(
      query('/api/admin/stats/menus', statsParameters(storeId, from, to)), { token, signal },
    ),
  };
}

export const kioskApi = createKioskApi();
export const fetchMenus = (options) => kioskApi.fetchMenus(options);
export const createOrder = (body, options) => kioskApi.createOrder(body, options);
export const getOrder = (orderId, options) => kioskApi.getOrder(orderId, options);
export const confirmPayment = (payload, options) => kioskApi.confirmPayment(payload, options);
export const cancelPayment = (payload, options) => kioskApi.cancelPayment(payload, options);
export const login = (credentials, options) => kioskApi.login(credentials, options);
export const logout = (options) => kioskApi.logout(options);
export const fetchKdsOrders = (options) => kioskApi.fetchKdsOrders(options);
export const updateKdsStatus = (orderId, status, options) => kioskApi.updateKdsStatus(orderId, status, options);
export const updateMenuStatus = (menuId, status, options) => kioskApi.updateMenuStatus(menuId, status, options);
export const fetchAdminOrders = (options) => kioskApi.fetchAdminOrders(options);
export const getAdminOrder = (orderId, options) => kioskApi.getAdminOrder(orderId, options);
export const fetchAdminPayments = (options) => kioskApi.fetchAdminPayments(options);
export const fetchSalesStats = (options) => kioskApi.fetchSalesStats(options);
export const fetchMenuStats = (options) => kioskApi.fetchMenuStats(options);
