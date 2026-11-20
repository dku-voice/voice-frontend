const kitchenStatuses = new Set(['PAID', 'PREPARING']);
const orderId = (order) => {
  const id = order?.id ?? order?.orderId;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('주방 주문의 숫자 ID를 확인해 주세요.');
  return id;
};

// Take the request snapshot with new Map(versions); do not keep a live reference.
export function changedKdsIds(snapshotVersions, currentVersions) {
  const ids = new Set([...snapshotVersions.keys(), ...currentVersions.keys()]);
  return new Set([...ids].filter((id) => snapshotVersions.get(id) !== currentVersions.get(id)));
}

export function mergeKdsOrders({ serverOrders, currentOrders, changedIds = [], closedIds = [] }) {
  if (!Array.isArray(serverOrders) || !Array.isArray(currentOrders)) {
    throw new Error('주방 주문 목록 형식을 확인해 주세요.');
  }
  const closed = new Set(closedIds);
  const merged = new Map();
  const current = new Map(currentOrders.map((order) => [orderId(order), order]));

  // The GET is authoritative for every row that did not change during the request.
  for (const order of serverOrders) {
    const id = orderId(order);
    if (!closed.has(id) && kitchenStatuses.has(order.status)) merged.set(id, order);
  }
  for (const id of changedIds) {
    const order = current.get(id);
    if (!closed.has(id) && order && kitchenStatuses.has(order.status)) merged.set(id, order);
    else merged.delete(id);
  }
  return [...merged.values()];
}
