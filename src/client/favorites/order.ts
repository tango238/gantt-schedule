/** 一覧の並び: お気に入りを上に固定。それぞれの中では元の並び (最終更新の新しい順) を保つ。 */
export function orderFavoritesFirst<T extends { favorite: boolean }>(items: readonly T[]): T[] {
  return [...items.filter((s) => s.favorite), ...items.filter((s) => !s.favorite)];
}
