import { create } from "zustand";
import { showToast } from "../components/uiStore";
import { t } from "../i18n";
import { enqueueFavorite } from "./favoriteQueue";

/**
 * スケジュール画面のお気に入りの状態 (スケジュール ID 別)。GET /api/schedules/:id の応答から入る。
 * 共同編集の doc には含めない。再同期で応答が届いても、自分の切り替えが通信中ならそちらを優先する。
 */
interface FavoriteState {
  byId: Record<string, boolean>;
  inflight: Record<string, number>;
}
export const useFavoriteStore = create<FavoriteState>()(() => ({ byId: {}, inflight: {} }));

export function noteFavorite(id: string, favorite: boolean): void {
  useFavoriteStore.setState((s) => (s.inflight[id] ? s : { byId: { ...s.byId, [id]: favorite } }));
}

/** 即時に切り替え、失敗したら戻してトースト。同じスケジュールへの要求は順番に送る。 */
export async function toggleFavoriteOf(id: string): Promise<void> {
  const prev = useFavoriteStore.getState().byId[id] === true;
  const next = !prev;
  const bump = (d: number) =>
    useFavoriteStore.setState((s) => ({ inflight: { ...s.inflight, [id]: (s.inflight[id] ?? 0) + d } }));
  bump(1);
  useFavoriteStore.setState((s) => ({ byId: { ...s.byId, [id]: next } }));
  const r = await enqueueFavorite(id, next);
  if (!r.ok) {
    if (r.latest) useFavoriteStore.setState((s) => ({ byId: { ...s.byId, [id]: prev } }));
    showToast("error", t("error.list.favoriteFailed"));
  }
  bump(-1);
}
