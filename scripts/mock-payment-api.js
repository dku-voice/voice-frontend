import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// These IDs and prices belong only to this in-memory fixture catalog.
const catalog = [
  [1, '클래식 버거', 5900, '버거', 'Burger'],
  [2, '치즈 버거', 6900, '버거', 'Burger'],
  [3, '불고기 버거', 6500, '버거', 'Burger'],
  [9, '양념감자', 2500, '사이드', 'Side'],
  [10, '감자튀김', 2500, '사이드', 'Side'],
  [14, '콜라', 2000, '음료', 'Drink'],
  [15, '제로 콜라', 2000, '음료', 'Drink'],
].map(([menuId, nameKo, price, categoryNameKo, categoryNameEn]) => ({
  menuId, nameKo, nameEn: nameKo, price, categoryNameKo, categoryNameEn,
  status: 'ACTIVE', imageUrl: '', allergensKo: [], allergensEn: [], nutrient: null,
  options: menuId <= 3 ? [
    { optionId: menuId * 100 + 1, nameKo: '치즈 추가', nameEn: 'Add cheese', optionType: 'ADD', extraPrice: 500 },
    { optionId: menuId * 100 + 2, nameKo: '양파 제외', nameEn: 'Remove onion', optionType: 'REMOVE', extraPrice: 0 },
  ] : menuId === 9 ? ['어니언 소스', '치즈 소스', '칠리 소스'].map((name, index) => ({
    optionId: 900 + index, nameKo: name, nameEn: name, optionType: 'ADD', extraPrice: 0,
  })) : [],
}));

const fail = (status, message) => Object.assign(new Error(message), { status });
const integer = (value) => Number.isSafeInteger(value) && value > 0;
const copy = (value) => JSON.parse(JSON.stringify(value));
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw fail(413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'JSON 요청을 확인해 주세요.'); }
}

export function createMockPaymentApi() {
  const instanceId = randomUUID();
  const orders = new Map();
  const transactions = new Set();
  let nextOrderId = 1;
  let nextPaymentId = 1;
  const reply = (res, status, data, message = null) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Voice-Mock': 'local-only',
    });
    res.end(JSON.stringify({ success: status < 400, data, message }));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/menus') {
        return reply(res, 200, catalog);
      }
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        const body = await readJson(req);
        if (!Array.isArray(body?.items) || !body.items.length || body.items.length > 100) throw fail(400, '주문 항목을 확인해 주세요.');
        const items = body.items.map((item) => {
          const menu = catalog.find((candidate) => candidate.menuId === item?.menuId);
          if (!menu || !integer(item.quantity) || item.quantity > 10000 || !Array.isArray(item.optionIds)
            || item.optionIds.some((id) => !integer(id))) throw fail(400, '메뉴 번호·수량·옵션을 확인해 주세요.');
          const options = [...new Set(item.optionIds)].map((id) => {
            const option = menu.options.find((candidate) => candidate.optionId === id);
            if (!option) throw fail(400, '메뉴에 없는 옵션입니다.');
            return copy(option);
          });
          if (menu.menuId === 9 && options.length !== 1) throw fail(400, '양념감자 소스를 한 개 선택해 주세요.');
          const unitPrice = menu.price + options.reduce((sum, option) => sum + option.extraPrice, 0);
          return { menuId: menu.menuId, menuNameKo: menu.nameKo, menuNameEn: menu.nameEn, quantity: item.quantity, unitPrice, subtotal: unitPrice * item.quantity, options };
        });
        const orderId = nextOrderId++;
        const order = {
          orderId, orderNumber: `MOCK-${instanceId.slice(0, 8)}-${String(orderId).padStart(4, '0')}`,
          orderedAt: new Date().toISOString(), status: 'PENDING',
          totalPrice: items.reduce((sum, item) => sum + item.subtotal, 0), items,
        };
        orders.set(orderId, order);
        return reply(res, 200, copy(order));
      }
      const receipt = url.pathname.match(/^\/api\/orders\/(\d+)$/);
      if (req.method === 'GET' && receipt) {
        const order = orders.get(Number(receipt[1]));
        if (!order) throw fail(404, '모의 주문이 없습니다. 새 메뉴를 담아 다시 시작해 주세요.');
        return reply(res, 200, copy(order));
      }
      if (req.method === 'POST' && url.pathname === '/api/payments/confirm') {
        const body = await readJson(req);
        if (body?.pgProvider !== 'TEST' || body.method !== 'CARD') throw fail(400, '로컬 모의 서버는 TEST/CARD만 처리합니다.');
        const order = orders.get(body.orderId);
        if (!order) throw fail(404, '모의 주문이 없습니다.');
        if (order.status !== 'PENDING') throw fail(409, '이미 처리한 모의 주문입니다.');
        if (body.amount !== order.totalPrice) throw fail(400, '서버 주문 금액과 다릅니다.');
        if (typeof body.pgTransactionId !== 'string' || !body.pgTransactionId.trim()) throw fail(400, '거래 ID가 필요합니다.');
        if (transactions.has(body.pgTransactionId)) throw fail(409, '이미 사용한 거래 ID입니다.');
        transactions.add(body.pgTransactionId);
        order.status = 'PAID';
        return reply(res, 200, {
          paymentId: nextPaymentId++, orderId: order.orderId,
          pgProvider: 'TEST', pgTransactionId: body.pgTransactionId,
          method: 'CARD', amount: order.totalPrice, paidAt: new Date().toISOString(),
        });
      }
      // No unknown path can fall through to a real backend, AI server, or Toss.
      throw fail(404, '로컬 모의 환경은 메뉴·주문·TEST 결제·영수증만 제공합니다.');
    } catch (error) {
      if (!res.writableEnded) reply(res, error.status || 500, null, error.status ? error.message : '로컬 모의 서버 오류입니다.');
    }
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return { server, instanceId };
}
