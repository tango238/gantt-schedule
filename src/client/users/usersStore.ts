import { create } from "zustand";
import { request } from "../schedulesApi";

export interface UserInfo {
  id: string;
  name: string;
  email: string;
}

interface UsersState {
  /** ログインしたことのある全ユーザー (null = 未取得)。 */
  users: UserInfo[] | null;
  /** id (大文字小文字を区別) -> 名前。未取得なら null。 */
  names: ReadonlyMap<string, string> | null;
}

export const useUsersStore = create<UsersState>()(() => ({ users: null, names: null }));

let loadedAt = 0;
let inFlight: Promise<boolean> | null = null;
/** 取り直しても一覧に無かった ID (同じ ID のためには、もう取りに行かない)。 */
const settledUnknown = new Set<string>();
/** 未知の ID を見つけて取り直すときの最短間隔。 */
export const USERS_REFRESH_MS = 15_000;

/**
 * ユーザー一覧を取得する。force でなければ、取得済みで間隔内なら何もしない。
 * 戻り値は「実際に取得した (成功した)」か。force は「取得しても無かった ID」の記録を消す (スケジュールを開いたとき)。
 */
export function loadUsers(force = false, now = Date.now()): Promise<boolean> {
  if (inFlight) return inFlight;
  if (!force && useUsersStore.getState().users !== null && now - loadedAt < USERS_REFRESH_MS) return Promise.resolve(false);
  if (force) settledUnknown.clear();
  inFlight = (async () => {
    try {
      const { users } = await request<{ users: UserInfo[] }>("/api/users", { cache: "no-store" });
      loadedAt = Date.now();
      useUsersStore.setState({ users, names: new Map(users.map((u) => [u.id, u.name])) });
      return true;
    } catch {
      /* 担当者名が出ないだけ。次の機会に取り直す */
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export type RefreshResult = "none" | "throttled" | "fetched";

/**
 * doc の担当に一覧に無い ID があれば (他の人が初めてログインした直後など) 取り直す。
 * 取り直しても無かった ID は覚え、同じ ID の集合では二度と取りに行かない (新しい未知の ID が現れたときだけ、
 * 間隔制限つきで取りに行く)。"throttled" = 間隔内で取れなかった (呼び出し側が後で 1 回だけ再試行する)。
 */
export async function refreshIfUnknown(assigneeIds: readonly string[], now = Date.now()): Promise<RefreshResult> {
  const names = useUsersStore.getState().names;
  if (names === null) return "none";
  const unknown = assigneeIds.filter((id) => !names.has(id));
  if (unknown.every((id) => settledUnknown.has(id))) return "none";
  const fetched = await loadUsers(false, now);
  if (!fetched) return "throttled";
  const after = useUsersStore.getState().names;
  for (const id of unknown) if (!after?.has(id)) settledUnknown.add(id);
  return "fetched";
}
