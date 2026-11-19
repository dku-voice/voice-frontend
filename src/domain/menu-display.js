// Resolve suggestions against the latest catalog, never prices/status from an
// old suggestion or unverified AI payload. This is a catalog list, not a score.
export function availableRecommendations(candidates, menus, cart) {
  const catalog = new Map(menus.map((menu) => [menu.menuId, menu]));
  const excluded = new Set(cart.map((item) => item.menuId));
  const result = [];
  for (const candidate of candidates) {
    const menu = catalog.get(candidate.menuId ?? candidate.id);
    if (!menu || menu.status !== 'ACTIVE' || excluded.has(menu.menuId)) continue;
    excluded.add(menu.menuId);
    result.push(menu);
  }
  return result;
}
