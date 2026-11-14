import { setFavorite } from "../schedulesApi";

/**
 * お気に入りの変更をスケジュール ID ごとに直列に送る (一覧とスケジュール画面で共用)。
 * 連打しても PUT / DELETE がサーバーで追い越し合わないので、最後に押した状態がサーバーの最終状態になる。
 */
const queues = new Map<string, Promise<unknown>>();
const latest = new Map<string, number>();
const touched = new Map<string, number>();
const pending = new Map<string, number>();
let epoch = 0;

const touch = (id: string) => touched.set(id, ++epoch);

/** 取得を始める時点の目印。取得中に変更があった ID は、取得結果ではなく手元の値を保つ (favoriteTouchedSince)。 */
export const favoriteEpoch = (): number => epoch;
/** 取得中に変更した、または今も通信中の ID か。 */
export const favoriteTouchedSince = (id: string, since: number): boolean =>
  (pending.get(id) ?? 0) > 0 || (touched.get(id) ?? 0) > since;

export interface FavoriteResult {
  ok: boolean;
  /** これより後に同じ ID の変更が無い (= 失敗したら画面を戻してよい)。 */
  latest: boolean;
  error?: unknown;
}

export function enqueueFavorite(id: string, on: boolean): Promise<FavoriteResult> {
  const seq = (latest.get(id) ?? 0) + 1;
  latest.set(id, seq);
  touch(id);
  pending.set(id, (pending.get(id) ?? 0) + 1);
  const run = (queues.get(id) ?? Promise.resolve()).then(async (): Promise<FavoriteResult> => {
    try {
      await setFavorite(id, on);
      return { ok: true, latest: latest.get(id) === seq };
    } catch (error) {
      return { ok: false, latest: latest.get(id) === seq, error };
    } finally {
      pending.set(id, (pending.get(id) ?? 1) - 1);
      touch(id);
    }
  });
  queues.set(id, run);
  return run;
}
