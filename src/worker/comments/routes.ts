import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env";
import { loadDocAndRev, scheduleExists } from "../schedules/repo";
import {
  COMMENTS_PER_TASK_MAX,
  commentCounts,
  createComment,
  deleteCommentRow,
  getComment,
  listComments,
  updateCommentBody,
  validCommentBody,
} from "./repo";

/**
 * タスクのコメント API。全ルート要ログイン (requireAuth) ・CSRF 検査は共通ミドルウェア。
 * 作成者と日時はサーバーがセッションと時計から決める (リクエストの値は見ない)。
 * 編集・削除は書いた本人だけ (管理者でも他人のコメントは不可 = 403)。
 * 変更のあとは Durable Object へ通知して、接続中の全員に「コメントが変わった (taskId)」を配信する。
 */
export const commentRoutes = new Hono<AppEnv>();

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_MAX_BYTES = 64 * 1024;

const noStore = (c: { header(k: string, v: string): void }) => c.header("cache-control", "no-store");

// 上限はコメントの POST / PATCH のパスだけにかける (このルーターは /api/schedules に "/" でマウントされるので、
// "*" にすると JSON インポートなど他のルートの上限まで 64KB になってしまう)。
const commentBodyLimit = bodyLimit({ maxSize: BODY_MAX_BYTES, onError: (c) => c.json({ error: "too_large", limit: BODY_MAX_BYTES }, 413) });
commentRoutes.post("/:id/tasks/:taskId/comments", commentBodyLimit);
commentRoutes.patch("/:id/comments/:commentId", commentBodyLimit);

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 通知の失敗でコメントの保存を失敗にしない (配信されなくても、画面を開き直せば見える)。 */
async function notify(c: { env: AppEnv["Bindings"] }, scheduleId: string, taskId: string): Promise<void> {
  try {
    await c.env.SCHEDULE_ROOM.get(c.env.SCHEDULE_ROOM.idFromName(scheduleId)).commentsChanged(taskId);
  } catch (e) {
    console.error("room: comments notify failed", e);
  }
}

const validSchedule = async (c: { env: AppEnv["Bindings"] }, id: string): Promise<boolean> =>
  ID_PATTERN.test(id) && (await scheduleExists(c.env.DB, id));

commentRoutes.get("/:id/comment-counts", async (c) => {
  const id = c.req.param("id");
  if (!(await validSchedule(c, id))) return c.json({ error: "not_found" }, 404);
  noStore(c);
  return c.json({ counts: await commentCounts(c.env.DB, id) });
});

commentRoutes.get("/:id/tasks/:taskId/comments", async (c) => {
  const id = c.req.param("id");
  const taskId = c.req.param("taskId");
  if (!TASK_ID.test(taskId) || !(await validSchedule(c, id))) return c.json({ error: "not_found" }, 404);
  noStore(c);
  return c.json({ comments: await listComments(c.env.DB, id, taskId.toLowerCase(), c.var.user.id) });
});

commentRoutes.post("/:id/tasks/:taskId/comments", async (c) => {
  const id = c.req.param("id");
  const taskId = c.req.param("taskId");
  if (!TASK_ID.test(taskId)) return c.json({ error: "not_found" }, 404);
  const body = await readJson(c);
  const text = body ? validCommentBody(body.body) : null;
  if (text === null) return c.json({ error: "invalid_body", message: "body must be 1-4000 characters" }, 400);
  if (!ID_PATTERN.test(id)) return c.json({ error: "not_found" }, 404);
  // スケジュールが存在し未削除で、タスクが現在の doc にあること。
  const state = await loadDocAndRev(c.env.DB, id);
  const key = taskId.toLowerCase();
  if (!state || !state.doc.tasks.some((t) => t.id.toLowerCase() === key)) return c.json({ error: "not_found" }, 404);

  const user = c.var.user;
  const commentId = crypto.randomUUID();
  const r = await createComment(c.env.DB, { id: commentId, scheduleId: id, taskId: key, userId: user.id, body: text, now: Date.now() });
  if (r === "limit") return c.json({ error: "comment_limit", limit: COMMENTS_PER_TASK_MAX }, 409);
  const created = await getComment(c.env.DB, id, commentId, user.id);
  await notify(c, id, key);
  noStore(c);
  return c.json({ comment: created }, 201);
});

commentRoutes.patch("/:id/comments/:commentId", async (c) => {
  const id = c.req.param("id");
  const commentId = c.req.param("commentId");
  if (!ID_PATTERN.test(commentId)) return c.json({ error: "not_found" }, 404);
  const body = await readJson(c);
  const text = body ? validCommentBody(body.body) : null;
  if (text === null) return c.json({ error: "invalid_body", message: "body must be 1-4000 characters" }, 400);
  if (!(await validSchedule(c, id))) return c.json({ error: "not_found" }, 404);
  const user = c.var.user;
  const cur = await getComment(c.env.DB, id, commentId, user.id);
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (!cur.mine) return c.json({ error: "forbidden" }, 403);
  noStore(c);
  if (cur.body === text) return c.json({ comment: cur }); // 変更なし: 編集済みにしない
  const ok = await updateCommentBody(c.env.DB, { scheduleId: id, commentId, userId: user.id, body: text, now: Date.now() });
  if (!ok) return c.json({ error: "not_found" }, 404); // 直前に削除された
  const updated = await getComment(c.env.DB, id, commentId, user.id);
  await notify(c, id, cur.taskId);
  return c.json({ comment: updated });
});

commentRoutes.delete("/:id/comments/:commentId", async (c) => {
  const id = c.req.param("id");
  const commentId = c.req.param("commentId");
  if (!ID_PATTERN.test(commentId)) return c.json({ error: "not_found" }, 404);
  if (!(await validSchedule(c, id))) return c.json({ error: "not_found" }, 404);
  const user = c.var.user;
  const cur = await getComment(c.env.DB, id, commentId, user.id);
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (!cur.mine) return c.json({ error: "forbidden" }, 403);
  const ok = await deleteCommentRow(c.env.DB, { scheduleId: id, commentId, userId: user.id });
  if (!ok) return c.json({ error: "not_found" }, 404);
  await notify(c, id, cur.taskId);
  noStore(c);
  return c.json({ ok: true });
});
