import type { D1Like } from "../schedules/repo";

/** タスクのコメント (D1 の task_comments 表)。時刻は ms の INTEGER。 */

export const COMMENT_MAX_CHARS = 4000;
/** 1 タスクあたりの上限。 */
export const COMMENTS_PER_TASK_MAX = 500;

export interface CommentItem {
  id: string;
  taskId: string;
  body: string;
  createdAt: number;
  /** null = 未編集 */
  updatedAt: number | null;
  author: { id: string; name: string };
  /** 自分が書いたコメントか (編集・削除できる)。 */
  mine: boolean;
}

interface Row {
  id: string;
  taskId: string;
  body: string;
  createdAt: number;
  updatedAt: number | null;
  userId: string;
  userName: string | null;
}

const SELECT = `SELECT c.id, c.task_id AS taskId, c.body, c.created_at AS createdAt, c.updated_at AS updatedAt,
  c.user_id AS userId, u.name AS userName
  FROM task_comments c LEFT JOIN users u ON u.id = c.user_id`;

const toItem = (r: Row, me: string): CommentItem => ({
  id: r.id,
  taskId: r.taskId,
  body: r.body,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  author: { id: r.userId, name: r.userName ?? "" },
  mine: r.userId === me,
});

/**
 * コメント本文の検査。前後の空白を除いて 1〜COMMENT_MAX_CHARS 文字 (コードポイント数)。
 * 改行 (LF / CRLF) と tab は許可し、それ以外の制御文字・双方向制御文字は不可。CRLF は LF にそろえる。
 */
export function validCommentBody(v: unknown): string | null {
  if (typeof v !== "string" || v.length > COMMENT_MAX_CHARS * 2 + 64) return null;
  // 制御文字 (C0 / DEL / C1)、行・段落区切り (U+2028 / 2029)、双方向制御文字 (U+202A–202E, U+2066–2069) は不可。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/.test(v.replace(/\r\n/g, "\n"))) return null;
  const s = v.replace(/\r\n/g, "\n").trim();
  if (s === "") return null;
  return Array.from(s).length <= COMMENT_MAX_CHARS ? s : null;
}

export async function listComments(db: D1Like, scheduleId: string, taskId: string, me: string): Promise<CommentItem[]> {
  const { results } = await db
    .prepare(`${SELECT} WHERE c.schedule_id = ? AND c.task_id = ? ORDER BY c.created_at, c.rowid LIMIT ?`)
    .bind(scheduleId, taskId, COMMENTS_PER_TASK_MAX)
    .all<Row>();
  return results.map((r) => toItem(r, me));
}

/** スケジュール内のタスク別のコメント件数 (0 件のタスクは含まない)。 */
export async function commentCounts(db: D1Like, scheduleId: string): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("SELECT task_id AS taskId, COUNT(*) AS n FROM task_comments WHERE schedule_id = ? GROUP BY task_id")
    .bind(scheduleId)
    .all<{ taskId: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of results) out[r.taskId] = Number(r.n);
  return out;
}

export async function getComment(db: D1Like, scheduleId: string, commentId: string, me: string): Promise<CommentItem | null> {
  const r = await db
    .prepare(`${SELECT} WHERE c.id = ? AND c.schedule_id = ?`)
    .bind(commentId, scheduleId)
    .first<Row>();
  return r ? toItem(r, me) : null;
}

/** 作成する。1 タスクの上限に達していたら "limit"。上限の判定と挿入は 1 文 (原子的)。 */
export async function createComment(
  db: D1Like,
  p: { id: string; scheduleId: string; taskId: string; userId: string; body: string; now: number },
): Promise<"ok" | "limit"> {
  const r = await db
    .prepare(
      `INSERT INTO task_comments (id, schedule_id, task_id, user_id, body, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, NULL
       WHERE (SELECT COUNT(*) FROM task_comments WHERE schedule_id = ? AND task_id = ?) < ?`,
    )
    .bind(p.id, p.scheduleId, p.taskId, p.userId, p.body, p.now, p.scheduleId, p.taskId, COMMENTS_PER_TASK_MAX)
    .run();
  return r.meta.changes > 0 ? "ok" : "limit";
}

/** 書いた本人 (userId) のコメントだけ更新する。更新できなければ false。 */
export async function updateCommentBody(
  db: D1Like,
  p: { scheduleId: string; commentId: string; userId: string; body: string; now: number },
): Promise<boolean> {
  const r = await db
    .prepare("UPDATE task_comments SET body = ?, updated_at = ? WHERE id = ? AND schedule_id = ? AND user_id = ?")
    .bind(p.body, p.now, p.commentId, p.scheduleId, p.userId)
    .run();
  return r.meta.changes > 0;
}

/** 書いた本人 (userId) のコメントだけ物理削除する。 */
export async function deleteCommentRow(
  db: D1Like,
  p: { scheduleId: string; commentId: string; userId: string },
): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM task_comments WHERE id = ? AND schedule_id = ? AND user_id = ?")
    .bind(p.commentId, p.scheduleId, p.userId)
    .run();
  return r.meta.changes > 0;
}
