const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const invalid = () => new Error('결제 완료 항목과 장바구니 정보를 확인해 주세요.');

const itemKey = (item) => {
  if (!positiveInteger(item?.menuId) || !positiveInteger(item.quantity)
    || !Array.isArray(item.optionIds) || !Array.from(item.optionIds).every(positiveInteger)) throw invalid();
  const optionIds = [...new Set(item.optionIds)].sort((a, b) => a - b);
  return `${item.menuId}:${optionIds.join(',')}`;
};

// The paid order is an immutable checkout snapshot. Only its purchased quantities
// are removed; additions and different option variants in the draft cart remain.
export function removePaidItemsFromCart(cart, paidItems) {
  if (!Array.isArray(cart) || !Array.isArray(paidItems)) throw invalid();
  const remainingPaid = new Map();
  for (const item of paidItems) {
    const key = itemKey(item);
    const quantity = (remainingPaid.get(key) || 0) + item.quantity;
    if (!positiveInteger(quantity)) throw invalid();
    remainingPaid.set(key, quantity);
  }
  const entries = Array.from(cart, (item) => ({ item, key: itemKey(item) }));
  const remainingCart = [];
  for (const { item, key } of entries) {
    const paidQuantity = remainingPaid.get(key) || 0;
    const removed = Math.min(item.quantity, paidQuantity);
    remainingPaid.set(key, paidQuantity - removed);
    const quantity = item.quantity - removed;
    if (quantity > 0) remainingCart.push({ ...item, quantity });
  }
  return remainingCart;
}
