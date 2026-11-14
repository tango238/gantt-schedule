import type { D1Like } from "../schedules/repo";

/** 画面の「担当」の選択肢用。ログインしたことのある全ユーザー (users 表)。 */
export interface UserListItem {
  id: string;
  name: string;
  email: string;
}

const LIST_LIMIT = 1000;

export async function listAllUsers(db: D1Like): Promise<UserListItem[]> {
  const { results } = await db
    .prepare("SELECT id, name, email FROM users ORDER BY name COLLATE NOCASE, email LIMIT ?")
    .bind(LIST_LIMIT)
    .all<UserListItem>();
  return results.map((r) => ({ id: r.id, name: r.name, email: r.email }));
}

/** ids のうち users 表に無いもの (重複は 1 つにまとめる)。 */
export async function missingUserIds(db: D1Like, ids: readonly string[]): Promise<string[]> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return [];
  const marks = uniq.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT id FROM users WHERE id IN (${marks})`)
    .bind(...uniq)
    .all<{ id: string }>();
  const found = new Set(results.map((r) => r.id));
  return uniq.filter((u) => !found.has(u));
}
