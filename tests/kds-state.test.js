import test from 'node:test';
import assert from 'node:assert/strict';
import { changedKdsIds, mergeKdsOrders } from '../src/integration/kds-state.js';

test('GET 중 다른 주문의 SSE가 와도 기존 주문은 서버의 PREPARING 상태로 갱신한다', () => {
  const snapshot = new Map([[1, 3]]);
  const versions = new Map([[1, 3], [2, 4]]);
  const result = mergeKdsOrders({
    serverOrders: [{ id: 1, status: 'PREPARING' }],
    currentOrders: [{ id: 1, status: 'PAID' }, { id: 2, status: 'PAID' }],
    changedIds: changedKdsIds(snapshot, versions),
  });
  assert.deepEqual(result, [{ id: 1, status: 'PREPARING' }, { id: 2, status: 'PAID' }]);
});

test('다른 기기에서 완료되어 GET에 없는 주문을 무관한 새 SSE 때문에 남기지 않는다', () => {
  const result = mergeKdsOrders({
    serverOrders: [],
    currentOrders: [{ id: 1, status: 'PAID' }, { id: 2, status: 'PAID' }],
    changedIds: new Set([2]),
  });
  assert.deepEqual(result, [{ id: 2, status: 'PAID' }]);
});

test('조회 이후 해당 주문에서 확인한 조리 시작은 오래된 GET보다 우선한다', () => {
  const result = mergeKdsOrders({
    serverOrders: [{ orderId: 1, status: 'PAID' }],
    currentOrders: [{ orderId: 1, status: 'PREPARING' }],
    changedIds: new Set([1]),
  });
  assert.deepEqual(result, [{ orderId: 1, status: 'PREPARING' }]);
});

test('완료한 주문과 조회 이후 삭제한 주문은 서버의 과거 목록에 있어도 복원하지 않는다', () => {
  assert.deepEqual(mergeKdsOrders({
    serverOrders: [{ id: 1, status: 'PAID' }, { id: 2, status: 'PREPARING' }],
    currentOrders: [{ id: 1, status: 'PREPARING' }],
    changedIds: [1, 2], closedIds: new Set([1]),
  }), []);
});

test('요청 중 변경이 없으면 서버에서 사라진 기존 주문을 제거하고 새 상태만 사용한다', () => {
  assert.deepEqual(mergeKdsOrders({
    serverOrders: [{ id: 2, status: 'PREPARING' }],
    currentOrders: [{ id: 1, status: 'PAID' }, { id: 2, status: 'PAID' }],
  }), [{ id: 2, status: 'PREPARING' }]);
});

test('버전 비교는 추가·변경·삭제된 ID만 반환하고 입력 Map과 주문 배열을 변경하지 않는다', () => {
  const snapshot = new Map([[1, 1], [2, 2], [3, 3]]);
  const current = new Map([[1, 1], [2, 4], [4, 5]]);
  assert.deepEqual(changedKdsIds(snapshot, current), new Set([2, 3, 4]));
  assert.deepEqual([...snapshot], [[1, 1], [2, 2], [3, 3]]);
  const serverOrders = Object.freeze([Object.freeze({ id: 1, status: 'PAID' })]);
  const currentOrders = Object.freeze([Object.freeze({ id: 1, status: 'PREPARING' })]);
  assert.deepEqual(mergeKdsOrders({ serverOrders, currentOrders, changedIds: [1] }), currentOrders);
  assert.equal(serverOrders[0].status, 'PAID');
});

test('완료·취소 상태는 대기 목록에서 제외하고 잘못된 ID/목록은 오류로 알린다', () => {
  assert.deepEqual(mergeKdsOrders({ serverOrders: [{ id: 1, status: 'COMPLETED' }], currentOrders: [] }), []);
  assert.throws(() => mergeKdsOrders({ serverOrders: null, currentOrders: [] }), /목록/);
  assert.throws(() => mergeKdsOrders({ serverOrders: [{ id: 0, status: 'PAID' }], currentOrders: [] }), /ID/);
});
